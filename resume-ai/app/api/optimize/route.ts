import { NextRequest, NextResponse } from "next/server";
import { verifyPass, ACCESS_COOKIE, FREE_COOKIE, FREE_LIMIT } from "@/app/lib/access";

/**
 * Provider-agnostic optimizer.
 * Defaults to NVIDIA's free OpenAI-compatible endpoint; set AI_PROVIDER=anthropic
 * to switch to Claude without touching this file's logic.
 *
 *   AI_PROVIDER   "nvidia" (default) | "anthropic"
 *   AI_MODEL      override the model (defaults per provider)
 *   NVIDIA_API_KEY / ANTHROPIC_API_KEY   the credential for the chosen provider
 */

// Allow up to 60s — LLM generation of a full rewritten resume can take a while.
export const maxDuration = 60;

const PROVIDER = (process.env.AI_PROVIDER || "nvidia").toLowerCase();

const PROMPT = (resume: string, jobDescription: string) =>
  `You are an expert ATS resume optimizer and career coach. Analyze the resume and job description below, then provide a complete optimization.

RESUME:
${resume}

JOB DESCRIPTION:
${jobDescription}

Return a JSON object with exactly this structure:
{
  "matchScore": <number 0-100>,
  "matchSummary": "<2-sentence summary of how well the resume matches>",
  "missingKeywords": ["keyword1", "keyword2"],
  "presentKeywords": ["keyword1", "keyword2"],
  "skillsGap": ["skill1", "skill2"],
  "improvements": [
    {"area": "area name", "issue": "what's wrong", "fix": "how to fix it"}
  ],
  "optimizedResume": "<complete rewritten resume with all improvements applied, ATS keywords injected naturally, bullets strengthened with metrics and strong verbs>"
}

Requirements for optimizedResume:
- Keep the candidate's real experience and facts — never invent
- Inject relevant keywords from the job description naturally
- Rewrite bullet points to start with strong action verbs and include metrics where plausible
- Ensure every section is ATS-friendly (clear headings, no tables/graphics)
- Make it professional and compelling

Return only the JSON, no other text.`;

/** Flatten a resume that came back as a nested object into readable plain text. */
function objectToResumeText(obj: unknown, depth = 0): string {
  if (obj == null) return "";
  if (typeof obj === "string") return obj;
  if (typeof obj === "number" || typeof obj === "boolean") return String(obj);
  const pad = "  ".repeat(depth);
  if (Array.isArray(obj)) {
    return obj.map((v) => `${pad}• ${objectToResumeText(v, depth + 1).trim()}`).join("\n");
  }
  if (typeof obj === "object") {
    return Object.entries(obj as Record<string, unknown>)
      .map(([k, v]) => {
        const val = objectToResumeText(v, depth + 1);
        const isBlock = typeof v === "object" && v !== null;
        return isBlock ? `${pad}${k}:\n${val}` : `${pad}${k}: ${val}`;
      })
      .join("\n");
  }
  return String(obj);
}

/** Force a field into a string[] no matter what the model returned. */
function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : String(x)));
  if (typeof v === "string" && v.trim()) return v.split(/,\s*/).map((s) => s.trim());
  return [];
}

/** Normalize a raw parsed result into the exact shape the UI expects. */
function normalizeResult(r: Record<string, unknown>) {
  const improvementsRaw = Array.isArray(r.improvements) ? r.improvements : [];
  return {
    matchScore: typeof r.matchScore === "number" ? r.matchScore : parseInt(String(r.matchScore)) || 0,
    matchSummary: typeof r.matchSummary === "string" ? r.matchSummary : "",
    missingKeywords: toStringArray(r.missingKeywords),
    presentKeywords: toStringArray(r.presentKeywords),
    skillsGap: toStringArray(r.skillsGap),
    improvements: improvementsRaw.map((i) => {
      const it = (i ?? {}) as Record<string, unknown>;
      return {
        area: String(it.area ?? ""),
        issue: String(it.issue ?? ""),
        fix: String(it.fix ?? ""),
      };
    }),
    optimizedResume:
      typeof r.optimizedResume === "string"
        ? r.optimizedResume
        : objectToResumeText(r.optimizedResume),
  };
}

/** Robustly pull the first complete JSON object out of a model response. */
function extractJson(text: string): string {
  const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    return cleaned.slice(start, end + 1);
  }
  return cleaned;
}

async function callNvidia(resume: string, jobDescription: string): Promise<string> {
  const key = process.env.NVIDIA_API_KEY;
  if (!key) throw new Error("NVIDIA_API_KEY is not set");
  const model = process.env.AI_MODEL || "meta/llama-3.1-8b-instruct";

  const res = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.4,
      top_p: 0.9,
      max_tokens: 3000,
      // Force the model to emit a single syntactically valid JSON object.
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You are an expert ATS resume optimizer. You always respond with a single valid JSON object and nothing else. Never include unescaped quotes or newlines inside JSON string values." },
        { role: "user", content: PROMPT(resume, jobDescription) },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`NVIDIA API ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? "";
}

async function callAnthropic(resume: string, jobDescription: string): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
  const model = process.env.AI_MODEL || "claude-sonnet-5";

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [{ role: "user", content: PROMPT(resume, jobDescription) }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return data?.content?.[0]?.text ?? "";
}

export async function POST(req: NextRequest) {
  try {
    const { resume, jobDescription } = await req.json();

    if (!resume || !jobDescription) {
      return NextResponse.json({ error: "Resume and job description are required." }, { status: 400 });
    }
    if (resume.trim().length < 50) {
      return NextResponse.json({ error: "Please paste a fuller resume (at least a few lines)." }, { status: 400 });
    }
    if (jobDescription.trim().length < 30) {
      return NextResponse.json({ error: "Please paste the full job description, not just a title or code — the AI needs the requirements to match against." }, { status: 400 });
    }
    if (resume.length > 8000 || jobDescription.length > 4000) {
      return NextResponse.json({ error: "Input too long. Please trim your resume or job description." }, { status: 400 });
    }

    // ── Access gate ──
    // Paid pass → unlimited. Otherwise allow FREE_LIMIT free scans, then require payment.
    const hasPass = !!verifyPass(req.cookies.get(ACCESS_COOKIE)?.value, Date.now());
    const freeUsed = parseInt(req.cookies.get(FREE_COOKIE)?.value || "0") || 0;
    if (!hasPass && freeUsed >= FREE_LIMIT) {
      return NextResponse.json(
        { error: "You've used your free optimization. Unlock unlimited access to continue.", paywall: true },
        { status: 402 }
      );
    }

    const generate = () =>
      PROVIDER === "anthropic"
        ? callAnthropic(resume, jobDescription)
        : callNvidia(resume, jobDescription);

    // Small models occasionally emit malformed JSON. Try twice before giving up.
    let result;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await generate();
        if (!raw.trim()) throw new Error("Empty response from AI provider");
        result = normalizeResult(JSON.parse(extractJson(raw)));
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!result) throw lastErr ?? new Error("Failed to parse AI response");

    const response = NextResponse.json(result);
    // Count the free scan only on a successful, non-paid run.
    if (!hasPass) {
      response.cookies.set(FREE_COOKIE, String(freeUsed + 1), {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
        maxAge: 365 * 24 * 60 * 60,
      });
    }
    return response;
  } catch (err) {
    console.error("Optimize error:", err);
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: "Failed to optimize resume. Please try again.", detail: msg },
      { status: 500 }
    );
  }
}
