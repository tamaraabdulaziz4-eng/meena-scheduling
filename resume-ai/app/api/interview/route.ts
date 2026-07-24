import { NextRequest, NextResponse } from "next/server";
import { allow, clientIp } from "@/app/lib/ratelimit";

export const maxDuration = 60;

/**
 * "المستشار" — the Advisor's conversation BRAIN (not a rephraser). Three actions,
 * one strict-JSON contract, one governing law: TRUTH. The model extracts the
 * user's real facts in their most beautiful form and asks when a fact is
 * missing — it never invents.
 *
 * - action="turn"     → full ANALYZE→DECIDE→ACT loop. Returns think/action/say/
 *                       profile_patch/resume_lines/chips/progress.
 * - action="rephrase" → legacy compatibility for the current UI, but under the
 *                       SAME truth rules (preserve every number/currency, no
 *                       forced 4 bullets, no spurious placeholders).
 * - action="gaps"     → up to 4 honest gap questions.
 *
 * Proven bugs this fixes (all from live evidence): fabrication of specifics,
 * placeholders overwriting numbers that EXIST, forced 4 generic bullets,
 * dropped currency (40 مليون ريال → "40 million").
 */

const SYSTEM_PROMPT = `You are "المستشار" — a senior Saudi career advisor and professional resume
STRATEGIST inside cv.rabit.sa. You are NOT a casual chatbot: you run a tight,
planned interview whose sole output is a COMPLETE, ATS-ready resume built
from the user's real words.

# LANGUAGE
- Mirror the user's language instantly. Arabic users: clear, professional
  Modern Standard Arabic — warm in tone, never slangy. English users: clean professional
  English. Resume lines follow the output language ("en" default | "ar" | "both").

# THE ATS MAP — your interview plan (walk it in order, one axis at a time)
You build the canonical ATS resume: header (name+contact) → professional
summary → work experience (reverse-chronological) → skills → education &
certifications. Six axes:
1. ROLE & YEARS — exact target title, years of experience, industry/niche.
2. CURRENT ROLE — exact job title, company, start date (Month Year), then 2-4
   achievement bullets. Every bullet: action verb + ATS keyword + MEASURABLE
   result (number, %, scope, currency). Always chase the number once:
   "كم؟ نسبة؟ حجم؟ مدة؟ — حتى تقدير بسيط".
3. PAST ROLES — same craft, reverse-chronological. Fresh graduate? Swap to
   graduation projects / internships with the same bullet craft.
4. SKILLS — 6-10 HARD skills/tools/systems that ATS scans for in THEIR role
   (accountant → IFRS, SAP/QuickBooks, reconciliations, Zakat/tax; engineer →
   stack/tools; sales → CRM, quota attainment...). No soft-skill fluff.
5. EDUCATION & CERTS — degree, university, graduation year; certifications
   (CPA, CMA, PMP, AWS...) if they exist — ask, never assume.
6. IDENTITY — full name + phone or email for the header.
Once axes 1-3 have real content, SILENTLY compose the professional summary
(3 parts: title+years+specialization | 2-3 hard skills + one quantified
achievement | the value they offer an employer) and include it as
profile_patch.summary — you write it, you don't ask about it.

# THE ONE LAW — TRUTH
You NEVER invent facts. No companies, titles, degrees, dates, tools, metrics,
or achievements the user did not state or clearly approximate themselves.
- RICH input -> preserve EVERY number, currency, date, and proper noun exactly
  (40 مليون ريال -> "SAR 40M" or "40 million riyals" — never drop the currency;
  15 فرع -> "15 branches"; جائزتين -> "two awards").
- VAGUE input ("مبيعات وعملاء", "backend stuff") -> DO NOT pad with invented
  specifics. Either DEEPEN (ask one targeted follow-up) or write ONE modest
  truthful line from what exists ("Handled sales and client relationships").
- Bullets count = what the content supports: 1-4, never a forced 4.
- Placeholders like [add your number] are FORBIDDEN when the number exists in
  the input. Use them ONLY when a metric is genuinely missing AND the user
  already declined to provide it — max 1 per resume, phrased naturally in the
  target language ([أضف الرقم] / [add the figure]).

# DEEPEN JUDGMENT
Mark an answer VAGUE when it lacks scope/numbers/specifics. On vague answers:
- If the current axis hasn't had its ONE follow-up yet -> DEEPEN with a
  precise, easy question with a concrete example answer they can copy
  ("مثلاً: أقفل قيود ١٥ فرع شهرياً").
- If already deepened or the user declined -> accept gracefully, write modest
  truthful lines, advance to the next axis. Never interrogate.
Tailor everything to THEIR role: accountant->audits/software (SAP, QuickBooks);
engineer->projects/stack; sales->quota/growth%; teacher->class size/outcomes;
fresh grad->projects/internship/GPA-if-strong. Saudi market awareness
(Jadarat/Taqat keywords, Saudization context) where natural.

# REPHRASING CRAFT
Action verb + scope + number (if it exists) + outcome. Weave in ATS keywords
from the job ad when present. English lines by default; Arabic lines use
correct professional terminology when the output language is Arabic.`;

interface Msg { role: "system" | "user" | "assistant"; content: string }

async function callLLM(messages: Msg[], maxTokens: number): Promise<string> {
  const key = process.env.NVIDIA_API_KEY;
  if (!key) throw new Error("no-key");
  const model = process.env.AI_MODEL || "meta/llama-4-maverick-17b-128e-instruct";
  let out = "";
  // One silent retry — the live interview must survive a transient upstream blip.
  for (let attempt = 0; attempt < 2 && !out; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    try {
      const res = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({ model, temperature: 0.4, top_p: 0.9, max_tokens: maxTokens, messages }),
      });
      if (res.ok) {
        const data = await res.json();
        out = String(data?.choices?.[0]?.message?.content || "").trim();
      } else {
        console.error(`Interview upstream ${res.status} (attempt ${attempt + 1})`);
      }
    } catch (e) {
      console.error(`Interview error (attempt ${attempt + 1}):`, e instanceof Error ? e.message : e);
    } finally {
      clearTimeout(timer);
    }
  }
  return out;
}

/** Pull the first balanced JSON object out of a model reply (handles code fences). */
function extractJson(raw: string): Record<string, unknown> | null {
  const cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < cleaned.length; i++) {
    if (cleaned[i] === "{") depth++;
    else if (cleaned[i] === "}") { depth--; if (depth === 0) { try { return JSON.parse(cleaned.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

/**
 * Honesty guard (the automated truth check, applied at runtime, not just CI):
 * when the user's own words already contain digits, a bracketed [add …]
 * placeholder in the output is spurious (bug R2/R3) — strip it. Also cap
 * placeholders to at most one per response.
 */
function guardLines(lines: string[], sourceText: string): string[] {
  const hasDigits = /\d|[٠-٩]/.test(sourceText);
  let placeholders = 0;
  return lines
    .map((l) => {
      let s = l.trim();
      if (/\[[^\]]*(?:add|أضف|رقم|number|figure)[^\]]*\]/i.test(s)) {
        if (hasDigits || placeholders >= 1) {
          // remove the placeholder fragment and any dangling connective before it
          s = s.replace(/[,،]?\s*(?:by|بنسبة|of)?\s*\[[^\]]*\]/gi, "").replace(/\s{2,}/g, " ").replace(/[\s,،-]+$/, "").trim();
        } else {
          placeholders++;
        }
      }
      return s;
    })
    .filter((l) => l.replace(/^[-•*]\s*/, "").length > 2);
}

export async function POST(req: NextRequest) {
  try {
    if (!allow(`interview:${clientIp(req)}`, 60, 10 * 60 * 1000)) {
      return NextResponse.json({ error: "Slow down a little — try again in a minute." }, { status: 429 });
    }

    let body;
    try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }
    const action = body?.action === "turn" ? "turn" : body?.action === "gaps" ? "gaps" : "rephrase";
    const outputLang = body?.lang === "ar" ? "ar" : body?.lang === "both" ? "both" : "en";
    const langWord = outputLang === "ar" ? "Arabic (فصحى professional)" : outputLang === "both" ? "English, then an Arabic version" : "English";
    const targetRole = String(body?.targetRole || body?.profile?.role || "").slice(0, 120);
    const text = String(body?.text || body?.answer || "").slice(0, 1500);
    const stateSummary = String(body?.stateSummary || "").slice(0, 2500);

    if (!process.env.NVIDIA_API_KEY) return NextResponse.json({ error: "Service unavailable." }, { status: 503 });

    /* ── action="turn" — the full conversation brain ── */
    if (action === "turn") {
      const history = Array.isArray(body?.history) ? body.history.slice(-12) : [];
      const profile = body?.profile && typeof body.profile === "object" ? body.profile : {};
      const userMsg = `OUTPUT LANGUAGE for resume_lines: ${langWord}.
CURRENT PROFILE (JSON): ${JSON.stringify(profile).slice(0, 2000)}
RECENT CONVERSATION: ${history.map((h: { who?: string; role?: string; text?: string; content?: string }) => `${h.who || h.role}: ${h.text || h.content}`).join("\n").slice(0, 1500)}
THE USER JUST SAID: "${text || "(start the interview)"}"

Run ANALYZE -> DECIDE (ASK|DEEPEN|REPHRASE|SUGGEST|FINISH) -> ACT, following THE ATS MAP:
- Identify the current axis (1 ROLE&YEARS | 2 CURRENT ROLE | 3 PAST ROLES | 4 SKILLS | 5 EDUCATION&CERTS | 6 IDENTITY), capture the user's facts into it, then either DEEPEN it once or ADVANCE to the next incomplete axis.
- The CURRENT PROFILE already contains wovenLines (the resume lines written so far) and summary. NEVER restate, reword, or recap a line that already exists.
- resume_lines = ONLY brand-new EXPERIENCE-section lines (headers + bullets) for facts the user JUST provided. Education, skills, summary, name, contact travel ONLY inside profile_patch — NEVER in resume_lines. At FINISH, resume_lines must be [] unless a genuinely new fact just arrived.
- Experience entries also go to profile_patch.experiences:[{header:{title,company,start_date},bullets[]}] so the client can lay them out; when refining an EXISTING entry, re-emit that whole entry (the client replaces it).
- Emit profile_patch.summary once axes 1-3 have content (rewrite it silently as facts grow — preserving stated years EXACTLY: ٦ سنوات stays ٦, never becomes ٤).
- progress = percentage of the six axes with real content (role | summary | experience | skills | education | identity), rounded.
- FINISH only when role + summary + at least one quantified experience + skills + education + name + contact ALL exist — and you MUST have emitted profile_patch.summary by then (compose it from real facts; if the material is incomplete, ASK for the missing piece instead of finishing). When you FINISH, "say" is a warm one-line farewell announcing the build — never a question.

Respond with STRICT JSON ONLY, exactly this shape:
{"think":"1-2 sentence private analysis","axis":2,"action":"ASK|DEEPEN|REPHRASE|SUGGEST|FINISH","say":"warm, <=40 words, one question max, aimed at the NEXT missing axis","profile_patch":{only changed fields},"resume_lines":["- ..."],"chips":[{"label":"...","patch":{}}],"progress":0}
Honor THE ONE LAW: preserve every number/currency/proper-noun the user gave; never invent; bullets 1-4 as content supports; no placeholder when the number exists. One question per message, max 10 questions, one DEEPEN per axis.`;

      const raw = await callLLM([{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userMsg }], 700);
      if (!raw) return NextResponse.json({ error: "busy" }, { status: 502 });
      const j = extractJson(raw);
      if (!j) return NextResponse.json({ error: "busy" }, { status: 502 });
      const resumeLines = Array.isArray(j.resume_lines) ? guardLines((j.resume_lines as string[]).map(String), text) : [];
      const axis = Math.max(1, Math.min(6, Number(j.axis) || 1));
      return NextResponse.json({
        think: String(j.think || ""),
        axis,
        action: ["ASK", "DEEPEN", "REPHRASE", "SUGGEST", "FINISH"].includes(String(j.action)) ? j.action : "ASK",
        // never dead-air the user: if the model returned an empty say, fall back
        // (a farewell when finishing, a nudge otherwise)
        say: String(j.say || "").trim() || (String(j.action) === "FINISH"
          ? (outputLang === "ar" ? "تمام — سيرتك اكتملت. أبنيها الآن وأحسب درجتك…" : "Done — your resume is complete. Building it and scoring it now…")
          : (outputLang === "ar" ? "أخبرني المزيد عن دورك ومهامك اليومية." : "Tell me more about your role and daily tasks.")),
        profile_patch: j.profile_patch && typeof j.profile_patch === "object" ? j.profile_patch : {},
        resume_lines: resumeLines,
        chips: Array.isArray(j.chips) ? j.chips.slice(0, 4) : [],
        progress: Math.max(0, Math.min(100, Number(j.progress) || 0)),
      });
    }

    /* ── action="gaps" — honest follow-up questions ── */
    if (action === "gaps") {
      const userMsg = `List up to 4 SHORT gap questions that would genuinely strengthen this CV IF the candidate has a real answer (a certification, a concrete number, a language, a tool). Never assume they have these — ask.
Language: ${outputLang === "ar" ? "professional Modern Standard Arabic" : "professional English"}.
One per line, format exactly: question | field   (field ∈ extras, skills, duties, education).
Target role: ${targetRole || "not given"}
${stateSummary}
Output ONLY the lines.`;
      const raw = await callLLM([{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userMsg }], 400);
      if (!raw) return NextResponse.json({ error: "busy" }, { status: 502 });
      const gaps = raw.split("\n").map((l) => l.trim().replace(/^[-•*]\s*/, "")).filter((l) => l.includes("|"))
        .map((l) => { const [q = "", f = ""] = l.split("|").map((p) => p.trim()); const field = ["extras", "skills", "duties", "education"].includes(f) ? f : "extras"; return { q, field }; })
        .filter((g) => g.q.length > 3).slice(0, 4);
      return NextResponse.json({ gaps });
    }

    /* ── action="rephrase" — legacy UI mode, new truth rules ── */
    if (!text.trim()) return NextResponse.json({ error: "Nothing to rephrase." }, { status: 400 });
    const userMsg = `Rewrite the candidate's casual description into professional CV bullet lines under THE ONE LAW.
OUTPUT LANGUAGE: ${langWord}. Target role: ${targetRole || "not given"}.
Rules recap: each line starts "- "; preserve EVERY number/currency/proper-noun exactly; do NOT invent specifics; write only as many bullets (1-4) as the content truly supports; NO [placeholder] when a number already exists.

Examples:
input: "مبيعات وعملاء" (role: مندوب مبيعات) -> {"lines":["- Managed day-to-day sales activities and client relationships."]}
input: "أسوي تقارير لـ15 فرع وفزت بجائزتين" -> {"lines":["- Prepared recurring financial reports covering 15 branches with full accuracy and on-time delivery.","- Earned two company awards recognizing outstanding performance."]}

CANDIDATE'S OWN WORDS:
${text}

Respond with STRICT JSON ONLY: {"lines":["- ...", "..."]}`;
    const raw = await callLLM([{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userMsg }], 500);
    if (!raw) return NextResponse.json({ error: "busy" }, { status: 502 });
    const j = extractJson(raw);
    let lines: string[] = [];
    if (j && Array.isArray(j.lines)) lines = (j.lines as string[]).map(String);
    else lines = raw.split("\n").map((l) => l.trim()).filter((l) => /^[-•*]/.test(l)); // tolerant fallback
    lines = guardLines(lines, text).slice(0, 4);
    if (!lines.length) return NextResponse.json({ error: "busy" }, { status: 502 });
    return NextResponse.json({ lines });
  } catch {
    return NextResponse.json({ error: "busy" }, { status: 502 });
  }
}
