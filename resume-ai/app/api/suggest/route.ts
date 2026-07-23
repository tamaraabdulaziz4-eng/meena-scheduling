import { NextRequest, NextResponse } from "next/server";
import { allow, clientIp } from "@/app/lib/ratelimit";

export const maxDuration = 60;

/**
 * Per-field AI phrasing assistant for the CV builder. The user taps the orb
 * next to a field and the AI drafts that field's content in their place —
 * they then edit or delete it freely in the same input (interactive AI on
 * every line, not a black-box rewrite at the end).
 *
 * NO-FABRICATION: suggestions may only rephrase and structure what the user
 * already gave (role/company/target + their current draft). Numbers they did
 * not state come out as [placeholders], never invented.
 */

type Kind = "duties" | "summary" | "skills" | "extras" | "education";

const KIND_RULES: Record<Kind, string> = {
  duties:
    "Write 3-4 CV bullet lines for this work experience. Each starts with '- ' and a strong action verb. Where a metric would help but was not given, write the bracket placeholder instead of inventing one.",
  summary:
    "Write a 3-line professional summary containing the target role title and the candidate's strongest angle from what is known. No invented facts.",
  skills:
    "Write 6-10 skills as a comma-separated list, inferred ONLY from the target role's standard toolkit and anything the candidate already wrote. Generic-but-real skills for the role are fine; niche tools they never mentioned are not.",
  extras:
    "Write 2-3 short lines suggesting what certifications/languages/projects sections typically contain for this target role, phrased as fill-in prompts with [placeholders] — never as claimed facts.",
  education:
    "Write 1-2 education lines in standard CV format (degree — institution, year) using ONLY what the candidate wrote, reformatted; if nothing was given, output a single template line with [placeholders].",
};

export async function POST(req: NextRequest) {
  try {
    if (!allow(`suggest:${clientIp(req)}`, 30, 10 * 60 * 1000)) {
      return NextResponse.json({ error: "Slow down a little — try again in a minute." }, { status: 429 });
    }

    let body;
    try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }
    const kind: Kind = ["duties", "summary", "skills", "extras", "education"].includes(body?.kind) ? body.kind : "duties";
    const lang = body?.lang === "ar" ? "ar" : "en";
    const targetRole = String(body?.targetRole || "").slice(0, 120);
    const role = String(body?.role || "").slice(0, 100);
    const company = String(body?.company || "").slice(0, 100);
    const current = String(body?.current || "").slice(0, 1200);

    if (!targetRole && !role && !current) {
      return NextResponse.json({ error: lang === "ar" ? "اكتب المسمى الوظيفي أولاً عشان أقدر أقترح." : "Fill in the role first so I have something to work from." }, { status: 400 });
    }

    const key = process.env.NVIDIA_API_KEY;
    if (!key) return NextResponse.json({ error: "Service unavailable." }, { status: 503 });
    const model = process.env.AI_MODEL || "meta/llama-4-maverick-17b-128e-instruct";

    const prompt = `You are a CV writing assistant embedded in a form field. ${KIND_RULES[kind]}

LANGUAGE: write the output in ${lang === "ar" ? "professional Modern Standard Arabic. Placeholders like [أضف رقمك الحقيقي: حجم الفريق، نسبة التحسّن…] in Arabic." : "professional English. Placeholders like [add your real number: team size, % improvement…]."}

KNOWN FACTS (use ONLY these — never invent employers, dates, numbers, degrees, or achievements):
- Target role: ${targetRole || "not given"}
- This job's title: ${role || "not given"}
- Company: ${company || "not given"}
- What the candidate already wrote in this field: ${current || "nothing yet"}

Output ONLY the field content itself — no intro, no explanation, no markdown bold, no quotes.`;

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
          temperature: 0.6,
          top_p: 0.9,
          max_tokens: 400,
          messages: [{ role: "user", content: prompt }],
        }),
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return NextResponse.json({ error: "The assistant is busy — try again." }, { status: 502 });
    const data = await res.json();
    const text = String(data?.choices?.[0]?.message?.content || "").replace(/\*\*/g, "").trim();
    if (!text) return NextResponse.json({ error: "The assistant is busy — try again." }, { status: 502 });

    return NextResponse.json({ text });
  } catch {
    return NextResponse.json({ error: "The assistant is busy — try again." }, { status: 502 });
  }
}
