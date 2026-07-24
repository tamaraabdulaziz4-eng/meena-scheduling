import { NextRequest, NextResponse } from "next/server";
import { allow, clientIp } from "@/app/lib/ratelimit";

export const maxDuration = 60;

/**
 * Conversational-builder helper: polishes ONE field of the CV at a time.
 * Takes the user's casual (often Arabic) answer and returns the professional
 * English version + a short Arabic note explaining what changed. Powers the
 * step-by-step "approve each answer" flow in /ar/builder.
 */

const FIELD_RULES: Record<string, string> = {
  name: "Transliterate this person's name into its standard English spelling (e.g. عبدالعزيز خلف العنزي -> Abdulaziz Khalaf Alenezi). Nothing else.",
  role: "Translate this job title into its standard professional English form (e.g. أخصائي أشعة -> Radiology Specialist). Use the industry-standard title.",
  company: "Give this employer's common English name. Well-known Saudi organizations have official English names (مستشفى دلة -> Dallah Hospital, أرامكو -> Saudi Aramco). If unknown, transliterate sensibly.",
  achievements: "Turn this casual description of work into 2-4 strong CV bullets in English: action verbs first, concrete outcomes. NEVER invent numbers — where a metric would help but wasn't given, write [add your real number]. Keep every fact the user stated, add none.",
  education: "Translate this education into standard English CV form (degree, field, institution, year if given).",
  skills: "Translate these skills into their standard English resume terms, comma-separated, deduplicated.",
  extras: "Translate these certifications/languages/courses into standard English names (keep official acronyms as-is).",
  contact: "Format this contact info cleanly on one line (phone · email · city). Transliterate the city to English. Keep numbers exactly as given.",
};

export async function POST(req: NextRequest) {
  try {
    const { field, text, targetRole } = await req.json();
    const rule = FIELD_RULES[String(field)];
    if (!rule) return NextResponse.json({ error: "Unknown field." }, { status: 400 });
    const input = String(text ?? "").trim();
    if (!input || input.length < 2) return NextResponse.json({ error: "Empty input." }, { status: 400 });
    if (input.length > 1200) return NextResponse.json({ error: "Too long." }, { status: 400 });

    if (!allow(`refine:${clientIp(req)}`, 40, 10 * 60 * 1000)) {
      return NextResponse.json({ error: "بطّئ شوي 🙂 — حاول بعد دقيقة." }, { status: 429 });
    }

    const key = process.env.NVIDIA_API_KEY;
    if (!key) throw new Error("NVIDIA_API_KEY is not set");
    const model = process.env.AI_MODEL || "meta/llama-4-maverick-17b-128e-instruct";

    const prompt = `You are helping build a CV field-by-field. ${rule}
${targetRole ? `The person's target role is: ${targetRole}.` : ""}
USER'S ANSWER (may be Arabic, casual): ${input}

Reply in EXACTLY this format, nothing else:
EN: <the polished English version — plain text, no markdown>
NOTE: <ملاحظة قصيرة جداً بالعربية الفصحى عما فعلته (مثال: "ترجمت المسمى للصيغة المعتمدة") — أو "جاهز" إن لم يحتج تغييراً>`;

    let out = "";
    for (let attempt = 0; attempt < 2 && !out; attempt++) {
      try {
        const res = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            temperature: 0.3,
            max_tokens: 400,
            messages: [{ role: "user", content: prompt }],
          }),
        });
        if (!res.ok) throw new Error(`NVIDIA ${res.status}`);
        const data = await res.json();
        out = (data?.choices?.[0]?.message?.content ?? "").trim();
      } catch (e) {
        if (attempt === 1) throw e;
      }
    }

    const en = (out.match(/EN:\s*([\s\S]*?)(?:\nNOTE:|$)/i)?.[1] ?? "").trim().replace(/\*\*/g, "");
    const note = (out.match(/NOTE:\s*([\s\S]*)$/i)?.[1] ?? "").trim().replace(/\*\*/g, "");
    if (!en) throw new Error("empty refine");

    return NextResponse.json({ en, note: note || "جاهز ✓" });
  } catch (err) {
    console.error("Refine error:", err);
    return NextResponse.json({ error: "تعذّر التحسين — حاول مرة أخرى." }, { status: 500 });
  }
}
