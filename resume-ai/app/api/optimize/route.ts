import { NextRequest, NextResponse } from "next/server";
import { verifyPass, ACCESS_COOKIE } from "@/app/lib/access";
import { readSession, SESSION_COOKIE } from "@/app/lib/session";
import { hasActiveEntitlement } from "@/app/lib/entitlements";
import { allow, clientIp } from "@/app/lib/ratelimit";

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
export const maxDuration = 300;

const PROVIDER = (process.env.AI_PROVIDER || "nvidia").toLowerCase();

const PROMPT = (resume: string, jobDescription: string, uiLang?: string) => {
  const hasJd = jobDescription.trim().length >= 30;
  return `You are a senior ATS (applicant tracking system) analyst and executive resume writer. ${hasJd ? "Perform a rigorous, honest analysis of this resume against this job description." : "The user provided ONLY a resume (no target job). Perform a rigorous GENERAL improvement: infer their likely target role from the resume itself and make the resume as strong as possible for that role."}

LANGUAGE HANDLING: The resume or job description may be in Arabic, English, or mixed. Understand both. The optimizedResume must ALWAYS be 100% professional ENGLISH — translate EVERYTHING including Arabic job titles and role names (never leave an Arabic word inside an English sentence). ${uiLang === "ar" ? "The user is on the ARABIC interface: write matchSummary, improvements (issue/fix), and ANALYSIS bullets in ARABIC." : "If the user's resume was mostly Arabic, write matchSummary, improvements, and ANALYSIS bullets in Arabic; otherwise in English."} Keywords stay in English (that's what ATS systems match on).

RESUME:
${resume}

${hasJd ? `JOB DESCRIPTION:
${jobDescription}

ANALYSIS METHOD (do this carefully before writing the JSON):
1. Extract from the JOB DESCRIPTION: the exact job title, 8-15 hard skills/tools/technologies, 3-5 soft skills, required years of experience, required qualifications/certifications, and domain-specific terminology.
2. Check each extracted item against the RESUME (including synonyms and abbreviations — e.g. "JS" = "JavaScript").
3. Score honestly using this weighted rubric:
   - Hard skills & tools match: 40 points
   - Job title / seniority alignment: 15 points
   - Relevant experience & achievements: 20 points
   - Required qualifications/certifications: 10 points
   - Keyword & terminology coverage: 15 points
   Do NOT inflate the score. A resume missing most hard skills must score below 50.` : `NO JOB DESCRIPTION — GENERAL MODE:
1. Infer the candidate's target role from their experience and skills.
2. Score the resume's overall QUALITY honestly on this rubric:
   - Impact & quantification of bullets: 30 points
   - ATS-safe structure & standard headings: 20 points
   - Skills coverage for the inferred role (industry-standard keywords): 25 points
   - Professional summary strength & clarity: 15 points
   - Conciseness / no filler: 10 points
   Do NOT inflate. A vague, unquantified resume must score below 50.
3. For "missingKeywords": list industry-standard keywords for the inferred role that the resume lacks.
4. For "presentKeywords": strong keywords already in the resume.`}

Rules for the rewritten resume — NO-FABRICATION CONTRACT (absolute, overrides everything):
- FORBIDDEN: writing ANY number, percentage, metric, team size, user count, revenue figure, employer, role, date, degree, certification, technology, or achievement that does not appear in the source resume. This is the product's core promise to the user.
- Where a metric would strengthen a bullet but the user gave none, write exactly: [add your real number] — never estimate, never make one up.
- You may only: rephrase, reorganize, translate, use stronger verbs, and surface the user's OWN facts more clearly.
- Where a required skill is missing, surface adjacent/transferable experience from the source — never claim the missing skill.
- Structure: Name/contact, PROFESSIONAL SUMMARY (3 lines, contains the job title), SKILLS (grouped, front-loading required skills the candidate genuinely has), EXPERIENCE (reverse-chronological), EDUCATION
- Plain text, standard headings, ATS-parseable

OUTPUT FORMAT — plain text with EXACTLY these section markers, in this order (NO JSON, no markdown):
ANALYSIS
<8-12 short bullet lines of your reasoning, one finding per line, e.g. "• Job requires React — NOT in resume". Shown live to the user.>
SCORE: <number 0-100 from the rubric — the CURRENT resume as submitted>
AFTER: <number 0-100 — the projected score the REWRITTEN resume below would honestly achieve on the SAME rubric. A rewrite can only reorganize, reword, and surface the candidate's OWN facts more clearly — it CANNOT add skills, tools, or experience the candidate lacks. So the gain is real but bounded: never claim a perfect 100, and if the candidate is genuinely missing most hard skills the after-score must stay modest. Must be >= SCORE.>
SUMMARY: <2-3 honest sentences on one line: score drivers, biggest gap, is it worth pursuing>
MISSING: <comma-separated keywords absent from the resume>
PRESENT: <comma-separated keywords genuinely present>
GAPS: <comma-separated skills the candidate truly lacks>
IMPROVEMENTS:
<4-6 lines, each exactly: area | specific problem | specific actionable fix>
RESUME:
<the COMPLETE rewritten resume as plain text, under 350 words. Nothing after it.>`;
};

/** Parse the delimited plain-text model output into the result shape. */
function parseSections(rawInput: string) {
  // The model sometimes bolds the markers (**SCORE:**) — strip markdown first.
  const raw = rawInput.replace(/\*\*/g, "").replace(/^#+\s*/gm, "");
  const grab = (name: string) => {
    const m = raw.match(new RegExp(`^${name}:?\\s*:?\\s*(.*)$`, "mi"));
    return m ? m[1].trim() : "";
  };
  const list = (s: string) =>
    s.split(/[,،]/).map((x) => x.trim().replace(/^[-•*]\s*/, "")).filter((x) => x && x.length < 80);

  const score = parseInt(grab("SCORE").replace(/[^0-9]/g, "")) || 0;
  // Projected score for the rewritten resume (before/after proof). Clamp so it
  // never drops below the current score or exceeds 100 — a rewrite only helps.
  const afterRaw = parseInt(grab("AFTER").replace(/[^0-9]/g, ""));
  const improvementsBlock = raw.match(/IMPROVEMENTS:\s*\n([\s\S]*?)\nRESUME:/i)?.[1] ?? "";
  const improvements = improvementsBlock
    .split("\n")
    .map((l) => l.trim().replace(/^[-•*]\s*/, ""))
    .filter((l) => l.includes("|"))
    .map((l) => {
      const [area = "", issue = "", fix = ""] = l.split("|").map((p) => p.trim());
      return { area, issue, fix };
    });
  const resume = (raw.match(/\nRESUME:\s*\n?([\s\S]*)$/i)?.[1] ?? "").trim().replace(/\*\*/g, "");

  // The rewritten resume IS the core deliverable. If the model ran out of tokens
  // before writing the RESUME: section (truncated response), treat it as a failure
  // so the retry actually fires — otherwise the user gets a score with a blank resume.
  if (!resume) throw new Error("Model output missing the RESUME section (likely truncated)");
  if (!score) throw new Error("Could not parse model output");
  const clampedScore = Math.min(100, Math.max(0, score));
  // If the model omitted/garbled AFTER, fall back to a conservative bounded lift
  // rather than fabricating a big jump: close ~40% of the gap to 100, capped at 95.
  const afterScore = Number.isFinite(afterRaw)
    ? Math.min(100, Math.max(clampedScore, afterRaw))
    : Math.min(95, clampedScore + Math.round((100 - clampedScore) * 0.4));
  return {
    matchScore: clampedScore,
    afterScore,
    matchSummary: grab("SUMMARY"),
    missingKeywords: list(grab("MISSING")),
    presentKeywords: list(grab("PRESENT")),
    skillsGap: list(grab("GAPS")),
    improvements,
    optimizedResume: resume,
  };
}

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

/**
 * Streams the NVIDIA completion. Calls onDelta for each text chunk and
 * resolves with the full accumulated text.
 */
async function streamNvidia(
  resume: string,
  jobDescription: string,
  onDelta: (text: string) => void,
  uiLang?: string
): Promise<string> {
  const key = process.env.NVIDIA_API_KEY;
  if (!key) throw new Error("NVIDIA_API_KEY is not set");
  const model = process.env.AI_MODEL || "meta/llama-4-maverick-17b-128e-instruct";

  const res = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 3600,
      stream: true,
      messages: [
        { role: "system", content: "You are an expert ATS resume analyst. ABSOLUTE RULE: never invent any number, employer, date, degree, certification, or achievement not present in the user's input — write [add your real number] where a metric is missing. Follow the user's OUTPUT FORMAT exactly: ANALYSIS bullets, then the SCORE/SUMMARY/MISSING/PRESENT/GAPS/IMPROVEMENTS/RESUME sections as plain text. Never output JSON or markdown." },
        { role: "user", content: PROMPT(resume, jobDescription, uiLang) },
      ],
    }),
  });

  if (!res.ok || !res.body) {
    const body = await res.text();
    throw new Error(`NVIDIA API ${res.status}: ${body.slice(0, 300)}`);
  }

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
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          onDelta(delta);
        }
      } catch {
        /* ignore malformed SSE lines */
      }
    }
  }
  return full;
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
    const { resume, jobDescription, uiLang } = await req.json();

    if (!resume) {
      return NextResponse.json({ error: "Resume is required." }, { status: 400 });
    }
    if (resume.trim().length < 50) {
      return NextResponse.json({ error: "Please paste a fuller resume (at least a few lines)." }, { status: 400 });
    }
    // Job description is OPTIONAL: with one we match against it; without, general improvement.
    const jd = String(jobDescription ?? "");
    if (jd.trim().length > 0 && jd.trim().length < 30) {
      return NextResponse.json({ error: "That job description looks too short — paste the full posting, or leave it empty for a general improvement." }, { status: 400 });
    }
    if (resume.length > 8000 || jd.length > 4000) {
      return NextResponse.json({ error: "Input too long. Please trim your resume or job description." }, { status: 400 });
    }

    // Abuse guard: the scan is free, so cap per-IP volume (each is an LLM call).
    if (!allow(`optimize:${clientIp(req)}`, 15, 10 * 60 * 1000)) {
      return NextResponse.json({ error: "You're going a bit fast. Please wait a minute and try again." }, { status: 429 });
    }

    // ── Freemium gate ──
    // The ATS score + full analysis (missing/present keywords, gaps, improvements)
    // is ALWAYS free — that's the hook that pulls traffic and creates the desire
    // to fix the gaps. The rewritten resume itself is the paid unlock. Paid if:
    // signed-in account with an active entitlement, OR a valid paid cookie pass.
    const email = readSession(req.cookies.get(SESSION_COOKIE)?.value, Date.now());
    const accountUnlimited = email ? await hasActiveEntitlement(email, Date.now()) : false;
    const hasPass = accountUnlimited || !!verifyPass(req.cookies.get(ACCESS_COOKIE)?.value, Date.now());

    // ── Streaming response: NDJSON lines ──
    //   {"t":"think","d":"<chunk of the AI's live analysis>"}
    //   {"t":"result","d":{...final structured result...}}
    //   {"t":"error","d":"<message>"}
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (obj: object) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        // The model occasionally emits malformed JSON — retry once; only the
        // first attempt streams thinking to the user (the retry is silent).
        let done = false;
        const t0 = Date.now();
        for (let attempt = 0; attempt < 2 && !done; attempt++) {
          // A full generation takes ~40s; don't start a retry we can't finish
          // inside the platform's 60s cap.
          if (attempt > 0 && Date.now() - t0 > 12000) break;
          try {
            let inThinking = attempt === 0;
            let pending = "";
            let lastPing = Date.now();
            const keepAlive = (delta: string) => {
              if (!inThinking) {
                if (Date.now() - lastPing > 3000) {
                  send({ t: "ping" });
                  lastPing = Date.now();
                }
                return;
              }
              pending += delta;
              // Stop forwarding once the model transitions to the JSON part.
              const cut = pending.search(/SCORE:/);
              if (cut !== -1) {
                const visible = pending.slice(0, cut);
                if (visible) send({ t: "think", d: visible });
                inThinking = false;
              } else {
                send({ t: "think", d: pending });
                pending = "";
              }
            };
            const raw = await (PROVIDER === "anthropic"
              ? callAnthropic(resume, jd)
              : streamNvidia(resume, jd, keepAlive, uiLang === "ar" ? "ar" : undefined));

            if (!raw.trim()) throw new Error("Empty response from AI provider");
            const result = parseSections(raw);
            // Freemium: free users see the score + full analysis, but the
            // rewritten resume is locked behind payment. Send only a short
            // teaser (never the full text — can't be unlocked from the network).
            if (!hasPass) {
              const full = result.optimizedResume;
              const preview = full.split("\n").slice(0, 6).join("\n");
              send({
                t: "result",
                d: { ...result, optimizedResume: preview, locked: true },
              });
            } else {
              send({ t: "result", d: { ...result, locked: false } });
            }
            done = true;
          } catch (err) {
            console.error(`Optimize stream error (attempt ${attempt + 1}):`, err);
          }
        }
        if (!done) send({ t: "error", d: "Failed to optimize resume. Please try again." });
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
    console.error("Optimize error:", err);
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: "Failed to optimize resume. Please try again.", detail: msg },
      { status: 500 }
    );
  }
}
