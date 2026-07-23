import { NextRequest, NextResponse } from "next/server";
import { allow, clientIp } from "@/app/lib/ratelimit";
import { verifyPass, ACCESS_COOKIE } from "@/app/lib/access";
import { readSession, SESSION_COOKIE } from "@/app/lib/session";
import { hasActiveEntitlement } from "@/app/lib/entitlements";

export const maxDuration = 60;

/** The live interview is a PAID feature — a signed-in account with an active
 *  entitlement, or a valid paid device pass on this browser. */
async function isPaid(req: NextRequest): Promise<boolean> {
  const email = readSession(req.cookies.get(SESSION_COOKIE)?.value, Date.now());
  if (email && (await hasActiveEntitlement(email, Date.now()))) return true;
  return !!verifyPass(req.cookies.get(ACCESS_COOKIE)?.value, Date.now());
}

/**
 * Live AI mock-interview engine.
 *   mode "questions" → generate a set of interview questions from resume + role.
 *   mode "feedback"  → score + coach ONE spoken/typed answer to one question.
 * Plain-text delimited output (not JSON) parsed by regex — same reliability
 * approach as /api/optimize, so a slightly-off model reply never breaks the UI.
 */

const QUESTIONS_PROMPT = (resume: string, role: string, uiLang: string) => `You are a senior interviewer at a top company hiring for: ${role || "the candidate's target role"}.
Based on the candidate's background below, produce 6 realistic interview questions they will likely face — a mix of: 1 opening/motivation, 3 behavioral (STAR), 2 role-specific/technical. Order them like a real interview.

CANDIDATE BACKGROUND:
${resume}

${uiLang === "ar" ? "Write each question in clear ARABIC (the candidate will answer aloud in Arabic or English)." : "Write each question in clear English."}

OUTPUT — plain text, EXACTLY one question per line, no numbering, no extra text:
Q: <question 1>
Q: <question 2>
Q: <question 3>
Q: <question 4>
Q: <question 5>
Q: <question 6>`;

const FEEDBACK_PROMPT = (question: string, answer: string, role: string, uiLang: string) => `You are an expert interview coach. The candidate is interviewing for: ${role || "their target role"}.

QUESTION ASKED:
${question}

CANDIDATE'S SPOKEN ANSWER (transcribed, may be rough):
${answer}

Evaluate honestly and coach them. ${uiLang === "ar" ? "Write ALL feedback in ARABIC." : "Write in English."} Be specific and encouraging but real.

OUTPUT — plain text with EXACTLY these markers, in order (no JSON, no markdown):
SCORE: <number 1-10 for this answer>
STRENGTHS: <one sentence on what worked>
IMPROVE: <one specific, actionable thing to fix>
MODEL: <a stronger 2-4 sentence model answer they could have given, using THEIR real background — never invent facts they didn't mention>`;

async function callModel(prompt: string, system: string, maxTokens: number): Promise<string> {
  const key = process.env.NVIDIA_API_KEY;
  if (!key) throw new Error("NVIDIA_API_KEY is not set");
  const model = process.env.AI_MODEL || "meta/llama-4-maverick-17b-128e-instruct";
  const res = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model, temperature: 0.5, top_p: 0.9, max_tokens: maxTokens,
      messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`NVIDIA ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? "";
}

async function withRetry(fn: () => Promise<string>, valid: (s: string) => boolean): Promise<string> {
  let last = "";
  for (let i = 0; i < 3; i++) {
    try {
      const out = await fn();
      if (out.trim() && valid(out)) return out;
      last = out;
    } catch (e) {
      console.error("interview-live attempt failed:", e);
    }
  }
  if (last) return last;
  throw new Error("Model failed after retries");
}

const grab = (raw: string, name: string) => {
  const m = raw.replace(/\*\*/g, "").match(new RegExp(`^${name}:\\s*(.*)$`, "mi"));
  return m ? m[1].trim() : "";
};

export async function POST(req: NextRequest) {
  try {
    if (!allow(`interviewlive:${clientIp(req)}`, 30, 10 * 60 * 1000)) {
      return NextResponse.json({ error: "بطّئ شوي 🙂 — حاول بعد دقيقة." }, { status: 429 });
    }
    const body = await req.json();
    const mode = String(body.mode || "");
    const uiLang = body.uiLang === "ar" ? "ar" : "en";

    // Paid feature — block free users so the client shows the AI-spoken paywall.
    if (!(await isPaid(req))) {
      return NextResponse.json({
        paywall: true,
        spoken: uiLang === "ar"
          ? "أهلاً بك! المقابلة التفاعلية المباشرة ميزة في الحزمة الكاملة، وباقتك الحالية لا تدعمها. افتح الحزمة الكاملة الآن ونبدأ مقابلتك فوراً."
          : "Welcome! The live interactive interview is part of the Complete Pack, and your current plan doesn't include it. Unlock the Complete Pack and we'll start right away.",
        error: uiLang === "ar" ? "المقابلة التفاعلية ميزة مدفوعة." : "The live interview is a paid feature.",
      }, { status: 402 });
    }

    if (mode === "questions") {
      const resume = String(body.resume || "").slice(0, 6000);
      const role = String(body.role || "").slice(0, 120);
      if (resume.trim().length < 30) {
        return NextResponse.json({ error: uiLang === "ar" ? "أضِف نبذة أطول عن خبرتك أولاً." : "Add a bit more about your experience first." }, { status: 400 });
      }
      const raw = await withRetry(
        () => callModel(QUESTIONS_PROMPT(resume, role, uiLang), "You output only 'Q: ...' lines, one question per line. No numbering, no extra text.", 900),
        (s) => (s.match(/^Q:\s*.+/gim)?.length || 0) >= 3,
      );
      const questions = (raw.match(/^Q:\s*(.+)$/gim) || []).map((l) => l.replace(/^Q:\s*/i, "").trim()).filter(Boolean).slice(0, 6);
      if (!questions.length) throw new Error("No questions parsed");
      return NextResponse.json({ questions });
    }

    if (mode === "feedback") {
      const question = String(body.question || "").slice(0, 500);
      const answer = String(body.answer || "").slice(0, 3000);
      const role = String(body.role || "").slice(0, 120);
      if (answer.trim().length < 5) {
        return NextResponse.json({ error: uiLang === "ar" ? "لم نلتقط إجابة — حاول مرة أخرى." : "We didn't catch an answer — try again." }, { status: 400 });
      }
      const raw = await withRetry(
        () => callModel(FEEDBACK_PROMPT(question, answer, role, uiLang), "You are an interview coach. Follow the exact SCORE/STRENGTHS/IMPROVE/MODEL format. Plain text only.", 700),
        (s) => /SCORE:/i.test(s) && /IMPROVE:/i.test(s),
      );
      const score = Math.max(1, Math.min(10, parseInt(grab(raw, "SCORE").replace(/[^0-9]/g, "")) || 6));
      const strengths = grab(raw, "STRENGTHS");
      const improve = grab(raw, "IMPROVE");
      const model = (raw.match(/MODEL:\s*([\s\S]*)$/i)?.[1] || "").trim().replace(/\*\*/g, "");
      return NextResponse.json({ score, strengths, improve, model });
    }

    return NextResponse.json({ error: "Unknown mode" }, { status: 400 });
  } catch (err) {
    console.error("interview-live error:", err);
    return NextResponse.json({ error: "حدث خطأ — حاول مرة أخرى.\nSomething went wrong — please try again." }, { status: 500 });
  }
}
