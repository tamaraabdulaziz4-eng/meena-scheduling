import { NextRequest, NextResponse } from "next/server";
import { allow, clientIp } from "@/app/lib/ratelimit";

export const maxDuration = 60;

/**
 * The Advisor's per-turn brain (landing v2 "المستشار"). Two actions, one LLM
 * call each — the question flow itself is a deterministic client state machine,
 * so a model failure can never strand the interview:
 *
 * - rephrase: the visitor's casual answer ("افتح المحل الساعة 6 وأرتب الرفوف")
 *   → 2-4 professional CV bullet lines. NO-FABRICATION: only reword what they
 *   said; missing numbers become [bracket placeholders].
 * - gaps: from the collected state, propose up to 4 honest gap questions
 *   (certification? a real number? languages?) the visitor can answer or skip.
 *
 * Output is delimited plain text (project convention — no JSON parsing to fail).
 */

export async function POST(req: NextRequest) {
  try {
    if (!allow(`interview:${clientIp(req)}`, 40, 10 * 60 * 1000)) {
      return NextResponse.json({ error: "Slow down a little — try again in a minute." }, { status: 429 });
    }

    let body;
    try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }
    const action = body?.action === "gaps" ? "gaps" : "rephrase";
    const lang = body?.lang === "ar" ? "ar" : "en";
    const targetRole = String(body?.targetRole || "").slice(0, 120);
    const text = String(body?.text || "").slice(0, 1500);
    const stateSummary = String(body?.stateSummary || "").slice(0, 2500);

    const key = process.env.NVIDIA_API_KEY;
    if (!key) return NextResponse.json({ error: "Service unavailable." }, { status: 503 });
    const model = process.env.AI_MODEL || "meta/llama-4-maverick-17b-128e-instruct";

    let prompt: string;
    if (action === "rephrase") {
      if (!text.trim()) return NextResponse.json({ error: "Nothing to rephrase." }, { status: 400 });
      prompt = `You are a CV writing advisor. The candidate described their work casually. Rewrite it as 2-4 professional CV bullet lines.

RULES (absolute):
- Language: ${lang === "ar" ? "professional Modern Standard Arabic" : "professional English"}. The candidate may have answered in Arabic, English, or a mix — understand it all, output only the target language.
- Each line starts with "- " and a strong action verb.
- NEVER invent numbers, employers, tools, or achievements they did not state. Where a metric would strengthen a line but wasn't given, write ${lang === "ar" ? "[أضف رقمك الحقيقي: حجم الفريق، نسبة التحسّن…]" : "[add your real number: team size, % improvement…]"}.
- Target role for context: ${targetRole || "not given"}.

CANDIDATE'S OWN WORDS:
${text}

Output ONLY the bullet lines — no intro, no explanation, no markdown bold.`;
    } else {
      prompt = `You are a CV advisor. Based on what this candidate has provided so far, list up to 4 SHORT gap questions that would genuinely strengthen the CV if the candidate has a real answer (certifications, a concrete metric, languages, a tool). Never assume they have these — the questions ask.

- Language: ${lang === "ar" ? "Saudi-friendly Arabic (خفيفة وودّية)" : "friendly English"}.
- One per line, format exactly: question | field   (field is one of: extras, skills, duties, education)
- Questions must be answerable in one short sentence.

CANDIDATE STATE:
- Target role: ${targetRole || "not given"}
${stateSummary}

Output ONLY the lines — nothing else.`;
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    let res: Response;
    try {
      res = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          model,
          temperature: 0.5,
          top_p: 0.9,
          max_tokens: 400,
          messages: [{ role: "user", content: prompt }],
        }),
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return NextResponse.json({ error: "busy" }, { status: 502 });
    const data = await res.json();
    const out = String(data?.choices?.[0]?.message?.content || "").replace(/\*\*/g, "").trim();
    if (!out) return NextResponse.json({ error: "busy" }, { status: 502 });

    if (action === "rephrase") {
      const lines = out.split("\n").map((l) => l.trim()).filter((l) => l.length > 2).slice(0, 4);
      return NextResponse.json({ lines });
    }
    const gaps = out
      .split("\n")
      .map((l) => l.trim().replace(/^[-•*]\s*/, ""))
      .filter((l) => l.includes("|"))
      .map((l) => {
        const [q = "", f = ""] = l.split("|").map((p) => p.trim());
        const field = ["extras", "skills", "duties", "education"].includes(f) ? f : "extras";
        return { q, field };
      })
      .filter((g) => g.q.length > 3)
      .slice(0, 4);
    return NextResponse.json({ gaps });
  } catch {
    return NextResponse.json({ error: "busy" }, { status: 502 });
  }
}
