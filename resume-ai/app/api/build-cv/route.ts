import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 300;

/**
 * CV Builder — takes plain-language answers from the wizard and writes a
 * complete, ATS-safe CV following the research-backed formula:
 * reverse-chronological, single column, 3-5 line summary, quantified bullets,
 * standard headings, one page. Streams thinking then the finished CV.
 */

interface Experience {
  role: string;
  company: string;
  dates: string;
  duties: string;
}

const PROMPT = (d: {
  name: string;
  contact: string;
  targetRole: string;
  experiences: Experience[];
  education: string;
  skills: string;
  extras: string;
  jobDescription: string;
}) => `You are an executive CV writer. Write a COMPLETE, professional CV for this person from their plain-language answers. They may have written casually — your job is to transform their words into polished, high-impact CV language.

IMPORTANT — LANGUAGE HANDLING:
- The candidate may answer in Arabic, English, or a mix. Understand it all.
- The CV itself must ALWAYS be written in professional ENGLISH (global ATS systems and Gulf employers require English CVs) — translate and professionally rephrase any Arabic input.
- Keep proper nouns sensible: transliterate Arabic names/companies to their common English forms.
- If the candidate wrote mostly in Arabic, write the "tips" array in Arabic; otherwise in English.
- In your ANALYSIS section, use the candidate's language (Arabic if they wrote Arabic).

CANDIDATE ANSWERS:
- Name: ${d.name}
- Contact: ${d.contact}
- Target role: ${d.targetRole}
- Work history (their own words):
${d.experiences.map((e, i) => `  ${i + 1}. ${e.role} at ${e.company} (${e.dates}): ${e.duties}`).join("\n")}
- Education: ${d.education}
- Skills: ${d.skills}
- Extra (certifications/languages/projects): ${d.extras || "none given"}
${d.jobDescription ? `- TARGET JOB POSTING (tailor the CV to this):\n${d.jobDescription}` : ""}

CV FORMULA (research-backed — follow exactly):
- Reverse-chronological, single column, plain text, standard headings — ATS-parseable
- PROFESSIONAL SUMMARY: 3-4 lines, contains the target role title, their strongest selling points
- SKILLS: grouped by category, front-loading what matters for the target role
- EXPERIENCE: each role 3-5 bullets; every bullet starts with a strong action verb. NO-FABRICATION CONTRACT (absolute): NEVER write any number, metric, team size, percentage, employer, date, degree, certification, or achievement the candidate did not state. Where the candidate gave a number, use it. Where a metric would help but wasn't given, write exactly: [add your real number: e.g. team size, % improvement, customers served].
- EDUCATION after experience (unless they have no experience — then education first)
- Include certifications/languages/projects sections only if they gave content for them
- Concise enough to fit one page; cut filler, keep impact
- You may only rephrase, translate, and organize the candidate's OWN facts — polish, never fabricate

OUTPUT FORMAT — two parts in this order:
1. A section starting with the exact line "ANALYSIS" — 6-10 short bullet lines about the choices you're making (e.g. "• Leading with retail management experience — matches target role", "• Converting 'helped customers' into quantified service bullets"). Shown live to the user.
2. Then the exact line "RESULT" followed by a JSON object: {"cv": "<the complete CV as plain text>", "tips": ["<3-5 short personalized tips to strengthen this CV further>"]}

No other text after the JSON.`;

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

function parseModelJson(raw: string): Record<string, unknown> {
  const extracted = extractJson(raw);
  try {
    return JSON.parse(extracted);
  } catch {
    return JSON.parse(repairJson(extracted));
  }
}

async function streamNvidia(prompt: string, onDelta: (t: string) => void): Promise<string> {
  const key = process.env.NVIDIA_API_KEY;
  if (!key) throw new Error("NVIDIA_API_KEY is not set");
  const model = process.env.AI_MODEL || "meta/llama-4-maverick-17b-128e-instruct";

  const res = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0.5,
      top_p: 0.9,
      max_tokens: 3600,
      stream: true,
      messages: [
        { role: "system", content: "You are an expert CV writer. Follow the OUTPUT FORMAT exactly: ANALYSIS bullets, then RESULT and one valid JSON object. Never include unescaped quotes inside JSON string values." },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok || !res.body) throw new Error(`NVIDIA API ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let full = "";
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const p = t.slice(5).trim();
      if (p === "[DONE]") continue;
      try {
        const delta = JSON.parse(p)?.choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          onDelta(delta);
        }
      } catch {
        /* ignore */
      }
    }
  }
  return full;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { name, contact, targetRole, experiences, education, skills, extras, jobDescription } = body;

    if (!name?.trim() || !targetRole?.trim()) {
      return NextResponse.json({ error: "Name and target role are required." }, { status: 400 });
    }
    if (!Array.isArray(experiences)) {
      return NextResponse.json({ error: "Experiences must be a list." }, { status: 400 });
    }
    if (!education?.trim() && experiences.length === 0) {
      return NextResponse.json({ error: "Add at least your education or one work experience." }, { status: 400 });
    }
    if (JSON.stringify(body).length > 12000) {
      return NextResponse.json({ error: "Input too long — please shorten your answers." }, { status: 400 });
    }

    const prompt = PROMPT({
      name: String(name).slice(0, 100),
      contact: String(contact || "").slice(0, 200),
      targetRole: String(targetRole).slice(0, 120),
      experiences: experiences.slice(0, 8).map((e: Experience) => ({
        role: String(e.role || "").slice(0, 100),
        company: String(e.company || "").slice(0, 100),
        dates: String(e.dates || "").slice(0, 60),
        duties: String(e.duties || "").slice(0, 800),
      })),
      education: String(education || "").slice(0, 500),
      skills: String(skills || "").slice(0, 500),
      extras: String(extras || "").slice(0, 500),
      jobDescription: String(jobDescription || "").slice(0, 3000),
    });

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (o: object) => controller.enqueue(encoder.encode(JSON.stringify(o) + "\n"));
        // Retry once on a transient model/JSON failure — only the first attempt
        // streams thinking to the user (the retry is silent).
        let done = false;
        const t0 = Date.now();
        for (let attempt = 0; attempt < 2 && !done; attempt++) {
          if (attempt > 0 && Date.now() - t0 > 12000) break;
          try {
            let inThinking = attempt === 0;
            let pending = "";
            let lastPing = Date.now();
            const raw = await streamNvidia(prompt, (delta) => {
              if (!inThinking) {
                if (Date.now() - lastPing > 3000) {
                  send({ t: "ping" });
                  lastPing = Date.now();
                }
                return;
              }
              pending += delta;
              const cut = pending.search(/RESULT|\{/);
              if (cut !== -1) {
                const visible = pending.slice(0, cut);
                if (visible) send({ t: "think", d: visible });
                inThinking = false;
              } else {
                send({ t: "think", d: pending });
                pending = "";
              }
            });

            if (!raw.trim()) throw new Error("Empty response");
            const parsed = parseModelJson(raw);
            // Plain text only — strip any markdown bold the model added.
            const cv = (typeof parsed.cv === "string" ? parsed.cv : String(parsed.cv ?? "")).replace(/\*\*/g, "");
            const tips = Array.isArray(parsed.tips) ? parsed.tips.map(String) : [];
            if (!cv.trim()) throw new Error("No CV in response");
            send({ t: "result", d: { cv, tips } });
            done = true;
          } catch (err) {
            console.error(`Build CV error (attempt ${attempt + 1}):`, err);
          }
        }
        if (!done) send({ t: "error", d: "Failed to build the CV. Please try again." });
        controller.close();
      },
    });

    return new NextResponse(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (err) {
    console.error("Build CV error:", err);
    return NextResponse.json({ error: "Failed to build the CV. Please try again." }, { status: 500 });
  }
}
