import { NextRequest, NextResponse } from "next/server";
import { allow, clientIp } from "@/app/lib/ratelimit";

export const maxDuration = 300;

/**
 * Shared endpoint for the smaller AI tools:
 *  - mode "linkedin":  resume/profile text + target role -> optimized headline, about, skills
 *  - mode "interview": resume + job description -> likely questions with strong answers
 * Outputs are small, so these run non-streaming and fit well inside the time cap.
 */

const PROMPTS: Record<string, (a: string, b: string) => string> = {
  linkedin: (profile, targetRole) => `You are a LinkedIn optimization expert. Rewrite this person's LinkedIn presence for the target role.

CURRENT PROFILE / RESUME TEXT:
${profile}

TARGET ROLE: ${targetRole}

Return ONLY a JSON object:
{
  "headline": "<a 120-220 char keyword-rich LinkedIn headline: role | value proposition | key skills>",
  "about": "<a first-person About section, 3 short paragraphs: hook, proof with achievements from their background, call to action. Recruiter-search keywords woven in naturally.>",
  "skills": ["<the 10-15 skills they should list, ordered by relevance to the target role — only skills their background supports>"],
  "tips": ["<3-4 specific profile tips, e.g. banner, featured section, activity>"]
}
Never invent employers or achievements. No text outside the JSON.`,

  interview: (resume, jobDescription) => `You are an interview coach. Based on this resume and job description, prepare the candidate.

RESUME:
${resume}

JOB DESCRIPTION:
${jobDescription}

Return ONLY a JSON object:
{
  "questions": [
    {"q": "<likely interview question>", "why": "<why they'll ask it, one line>", "answer": "<a strong 3-5 sentence answer using THIS candidate's real background (STAR style where relevant). Where they lack the skill, give an honest bridging answer.>"}
  ],
  "redFlags": ["<2-3 weaknesses in their profile the interviewer may probe, with one-line advice each>"]
}
Provide 8 questions: 2 intro/behavioral, 4 role-specific technical/skills, 2 about gaps in their background. No text outside the JSON.`,
};

function extractJson(text: string): string {
  const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  return start !== -1 && end > start ? cleaned.slice(start, end + 1) : cleaned;
}

/** Repair model JSON: escape raw control chars AND unescaped quotes inside strings.
 * A quote inside a string is treated as CLOSING only if the next non-space char
 * is a JSON structural char (, } ] :) — otherwise it's escaped as content. */
function repairJson(s: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === "\\") { out += ch; esc = true; continue; }
      if (ch === '"') {
        let j = i + 1;
        while (j < s.length && (s[j] === " " || s[j] === "\n" || s[j] === "\r" || s[j] === "\t")) j++;
        const next = s[j] ?? "";
        if (next === "," || next === "}" || next === "]" || next === ":") {
          inStr = false;
          out += ch;
        } else {
          out += '\\"'; // interior quote — escape it
        }
        continue;
      }
      if (ch === "\n") { out += "\\n"; continue; }
      if (ch === "\r") continue;
      if (ch === "\t") { out += "\\t"; continue; }
      out += ch;
    } else {
      if (ch === '"') inStr = true;
      out += ch;
    }
  }
  return out;
}

export async function POST(req: NextRequest) {
  try {
    const { mode, inputA, inputB } = await req.json();
    const promptFn = PROMPTS[mode];
    if (!promptFn) return NextResponse.json({ error: "Unknown tool." }, { status: 400 });
    if (!inputA?.trim() || inputA.length < 50) {
      return NextResponse.json({ error: "Please provide more detail (paste your resume or profile)." }, { status: 400 });
    }
    if (!inputB?.trim() || inputB.length < 3) {
      return NextResponse.json({ error: mode === "linkedin" ? "Please enter your target role." : "Please paste the job description." }, { status: 400 });
    }
    if (inputA.length > 8000 || inputB.length > 4000) {
      return NextResponse.json({ error: "Input too long." }, { status: 400 });
    }

    // Free LLM endpoints need the same abuse cap as /api/optimize.
    if (!allow(`tools:${clientIp(req)}`, 10, 10 * 60 * 1000)) {
      return NextResponse.json({ error: "You're going a bit fast. Please wait a minute and try again." }, { status: 429 });
    }

    const key = process.env.NVIDIA_API_KEY;
    if (!key) throw new Error("NVIDIA_API_KEY is not set");
    const model = process.env.AI_MODEL || "meta/llama-4-maverick-17b-128e-instruct";

    // The free model intermittently returns an error or malformed JSON. Retry
    // once (non-streaming, small output) so a transient failure isn't user-visible.
    let parsed: Record<string, unknown> | null = null;
    let lastErr: unknown = null;
    const t0 = Date.now();
    // Up to 3 attempts — the free model fails ~1/3 of the time with either
    // malformed JSON OR valid-but-empty content (no questions). BOTH must retry.
    for (let attempt = 0; attempt < 3 && !parsed; attempt++) {
      if (attempt > 0 && Date.now() - t0 > 45000) break;
      // Abort a stalled upstream call so it can't hang the whole request for
      // 120s+ under load — cap each attempt at 35s, then retry or fail cleanly.
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 35000);
      try {
        const res = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          signal: ctrl.signal,
          body: JSON.stringify({
            model,
            temperature: 0.5,
            top_p: 0.9,
            max_tokens: 3200, // interview returns 8 Q&A — 2200 truncated it, yielding invalid/empty JSON
            messages: [
              { role: "system", content: "You respond with a single valid JSON object and nothing else. Never include unescaped quotes inside JSON string values." },
              { role: "user", content: promptFn(String(inputA).slice(0, 8000), String(inputB).slice(0, 4000)) },
            ],
          }),
        });
        if (!res.ok) throw new Error(`NVIDIA API ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const data = await res.json();
        const raw = data?.choices?.[0]?.message?.content ?? "";
        if (!raw.trim()) throw new Error("Empty response");
        let candidate: Record<string, unknown>;
        try {
          candidate = JSON.parse(extractJson(raw));
        } catch {
          candidate = JSON.parse(repairJson(extractJson(raw)));
        }
        // Content-level validation — a syntactically-valid but empty/garbled
        // response must ALSO retry, not fall through to a 500.
        if (mode === "interview") {
          const qs = Array.isArray(candidate.questions) ? candidate.questions : Array.isArray(candidate) ? (candidate as unknown[]) : [];
          if (!qs.some((x) => { const it = (x ?? {}) as Record<string, unknown>; return it.q || it.question; })) {
            throw new Error("No usable questions in response");
          }
        } else if (mode === "linkedin") {
          if (!candidate.headline && !candidate.about) throw new Error("No usable LinkedIn content");
        }
        parsed = candidate;
      } catch (e) {
        lastErr = e;
        console.error(`Tools error (attempt ${attempt + 1}):`, e);
      } finally {
        clearTimeout(timer);
      }
    }
    if (!parsed) throw lastErr ?? new Error("Failed to generate");

    // Normalize to the exact shape the UI expects so a slightly-off model
    // response can never crash the client (.map on undefined).
    if (mode === "interview") {
      const rawQ = Array.isArray(parsed.questions) ? parsed.questions
        : Array.isArray(parsed) ? (parsed as unknown[]) : [];
      const questions = rawQ
        .map((x) => {
          const it = (x ?? {}) as Record<string, unknown>;
          return { q: String(it.q ?? it.question ?? ""), why: String(it.why ?? it.reason ?? ""), answer: String(it.answer ?? it.a ?? "") };
        })
        .filter((it) => it.q);
      const redFlags = (Array.isArray(parsed.redFlags) ? parsed.redFlags : []).map(String);
      if (!questions.length) throw new Error("No questions in response");
      return NextResponse.json({ questions, redFlags });
    }
    if (mode === "linkedin") {
      return NextResponse.json({
        headline: String(parsed.headline ?? ""),
        about: String(parsed.about ?? ""),
        skills: (Array.isArray(parsed.skills) ? parsed.skills : []).map(String),
        tips: (Array.isArray(parsed.tips) ? parsed.tips : []).map(String),
      });
    }
    return NextResponse.json(parsed);
  } catch (err) {
    console.error("Tools error:", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
