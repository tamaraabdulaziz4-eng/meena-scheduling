"use client";
import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import PdfExport from "../../components/PdfExport";
import DocxExport from "../../components/DocxExport";
import ResumeTemplate from "../../components/ResumeTemplate";
import PublishLink from "../../components/PublishLink";
import { saveResume } from "../../lib/localdata";

/**
 * البناء التفاعلي: محادثة خطوة بخطوة — المستخدم يجاوب بالعربي براحته،
 * الذكاء يحسّن كل إجابة فوراً (إنجليزي احترافي + ملاحظة)، المستخدم يعتمدها،
 * وننتقل للي بعدها. بالنهاية تتولد السيرة كاملة.
 */

interface Msg {
  who: "ai" | "user" | "suggest";
  text: string;
  note?: string;
}

interface Exp { role: string; company: string; dates: string; duties: string }

type StepId =
  | "name" | "contact" | "personal" | "targetRole"
  | "company" | "jobTitle" | "dates" | "duties" | "moreJobs"
  | "education" | "skills" | "extras" | "generate";

const QUESTIONS: Record<string, { q: string; refine?: string; multiline?: boolean }> = {
  name: { q: "أهلاً! أنا مساعدك لبناء سيرة إنجليزية احترافية. بنمشي خطوة خطوة وكل إجابة أحسّنها لك وتعتمدها قبل ما ننتقل.\n\nأول شي — وش اسمك الكامل؟", refine: "name" },
  contact: { q: "تمام! عطني وسائل التواصل: رقم جوالك، إيميلك، ومدينتك.", refine: "contact" },
  personal: { q: "بعض جهات التوظيف الخليجية تحب معلومات إضافية في السيرة (اختياري):\nالجنسية · تاريخ الميلاد · الحالة الاجتماعية · حالة الإقامة/الإقامة النظامية.\n\nاكتبها إذا تبي تضيفها، أو اكتب «تخطي»." },
  targetRole: { q: "وش الوظيفة اللي تستهدفها؟ (اكتبها بالعربي عادي وأنا أطلع لك مسماها المعتمد بالإنجليزي)", refine: "role" },
  company: { q: "الحين خبرتك العملية 💼\nوين تشتغل حالياً أو آخر جهة اشتغلت فيها؟ اكتب اسمها حتى لو ما تعرف اسمها بالإنجليزي — أنا أجيبه لك.", refine: "company" },
  jobTitle: { q: "وش كان مسماك الوظيفي هناك؟", refine: "role" },
  dates: { q: "من متى إلى متى؟ (مثال: 2020 - الآن)" },
  duties: { q: "الحين أهم جزء — احكِ لي وش كنت تسوي: مهامك، إنجازاتك، أي أرقام تذكرها (عدد الفريق، نسبة تحسّن، عدد العملاء…). اكتب براحتك بالعامية وأنا أحوّلها لنقاط قوية.", refine: "achievements", multiline: true },
  moreJobs: { q: "أضفتها ✓ — عندك وظيفة سابقة ثانية تبي تضيفها؟ (اكتب: نعم / لا)" },
  education: { q: "وش تعليمك؟ (الشهادة، التخصص، الجامعة، السنة)", refine: "education" },
  skills: { q: "اذكر مهاراتك — تقنية أو شخصية، بأي لغة، وأنا أرتّبها.", refine: "skills" },
  extras: { q: "آخر سؤال: عندك شهادات مهنية، دورات، أو لغات؟ (اكتب «لا يوجد» إذا ما عندك)", refine: "extras" },
};

export default function ArChatBuilderPage() {
  const [msgs, setMsgs] = useState<Msg[]>([{ who: "ai", text: QUESTIONS.name.q }]);
  const [step, setStep] = useState<StepId>("name");
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<{ en: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [thinking, setThinking] = useState("");
  const [cv, setCv] = useState("");
  const [tips, setTips] = useState<string[]>([]);
  const [genError, setGenError] = useState("");
  const [copied, setCopied] = useState(false);
  const [view, setView] = useState<"text" | "designed">("text");

  // البيانات المتراكمة
  const [data, setData] = useState({ name: "", contact: "", personalDetails: "", targetRole: "", education: "", skills: "", extras: "" });
  const [exps, setExps] = useState<Exp[]>([]);
  const [curExp, setCurExp] = useState<Exp>({ role: "", company: "", dates: "", duties: "" });

  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, pending, busy, cv]);

  // حفظ/استرجاع الجلسة
  useEffect(() => {
    try {
      const saved = localStorage.getItem("ra_ar_chat");
      if (saved) {
        const s = JSON.parse(saved);
        if (s.msgs?.length > 1) {
          setMsgs(s.msgs); setStep(s.step); setData(s.data); setExps(s.exps || []); setCurExp(s.curExp || { role: "", company: "", dates: "", duties: "" });
          // Restore the pending suggestion too — otherwise a reload leaves the
          // "✨ اقتراحي" bubble on screen with no accept/edit buttons (orphaned).
          if (s.pending?.en) setPending(s.pending);
          // On reload the persisted step can be 'generate' (persistence fires while
          // generation is in flight/errored), but generate() only refires via ask() —
          // so surface the retry button instead of a dead, spinner-less screen.
          if (s.step === "generate") setGenError("تعذّر توليد السيرة — اضغط «حاول مرة أخرى».");
        }
      }
    } catch { /* تجاهل */ }
  }, []);
  useEffect(() => {
    try {
      if (msgs.length > 1 && !cv) localStorage.setItem("ra_ar_chat", JSON.stringify({ msgs, step, data, exps, curExp, pending }));
    } catch { /* تجاهل */ }
  }, [msgs, step, data, exps, curExp, cv, pending]);

  function ask(next: StepId, extraMsgs: Msg[] = [], snapshot?: typeof data) {
    setStep(next);
    if (next === "generate") {
      setMsgs((m) => [...m, ...extraMsgs, { who: "ai", text: "ممتاز — عندي كل شي! جارٍ كتابة سيرتك الاحترافية الآن… ✨" }]);
      void generate(snapshot);
    } else {
      setMsgs((m) => [...m, ...extraMsgs, { who: "ai", text: QUESTIONS[next].q }]);
    }
  }

  /** يخزّن القيمة المعتمدة للخطوة الحالية وينتقل */
  function commit(value: string) {
    switch (step) {
      case "name": setData((d) => ({ ...d, name: value })); ask("contact"); break;
      case "contact": setData((d) => ({ ...d, contact: value })); ask("personal"); break;
      case "personal": {
        const skip = /^(تخطي|تخطى|لا|no|skip|لا يوجد|مافي|ما عندي)/i.test(value.trim());
        setData((d) => ({ ...d, personalDetails: skip ? "" : value }));
        ask("targetRole");
        break;
      }
      case "targetRole": setData((d) => ({ ...d, targetRole: value })); ask("company"); break;
      case "company": setCurExp((e) => ({ ...e, company: value })); ask("jobTitle"); break;
      case "jobTitle": setCurExp((e) => ({ ...e, role: value })); ask("dates"); break;
      case "dates": setCurExp((e) => ({ ...e, dates: value })); ask("duties"); break;
      case "duties": {
        const done = { ...curExp, duties: value };
        setExps((x) => [...x, done]);
        setCurExp({ role: "", company: "", dates: "", duties: "" });
        ask("moreJobs");
        break;
      }
      case "education": setData((d) => ({ ...d, education: value })); ask("skills"); break;
      case "skills": setData((d) => ({ ...d, skills: value })); ask("extras"); break;
      case "extras": {
        // setData + generate() fire in the same tick, so generate() would read the
        // stale `data` closure (empty extras). Thread a merged snapshot through.
        const extras = /^(لا|no|none|لا يوجد|ما عندي|مافي)/i.test(value.trim()) ? "" : value;
        const merged = { ...data, extras };
        setData(merged);
        ask("generate", [], merged);
        break;
      }
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setMsgs((m) => [...m, { who: "user", text }]);

    // فرع «وظيفة ثانية؟»
    if (step === "moreJobs") {
      if (/^(نعم|اي|ايه|yes|y|أجل)/i.test(text)) {
        if (exps.length >= 3) { ask("education", [{ who: "ai", text: "وصلنا الحد الأقصى (٣ وظائف) — نكمل 👍" }]); return; }
        ask("company");
      } else {
        ask("education");
      }
      return;
    }

    const q = QUESTIONS[step];
    if (!q?.refine) { commit(text); return; }

    // تحسين بالذكاء ثم انتظار الاعتماد
    setBusy(true);
    try {
      const res = await fetch("/api/refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ field: q.refine, text, targetRole: data.targetRole }),
      });
      const d = await res.json();
      if (!res.ok || !d.en) throw new Error(d.error || "فشل التحسين");
      setPending({ en: d.en });
      setMsgs((m) => [...m, { who: "suggest", text: d.en, note: d.note }]);
    } catch {
      // لو فشل التحسين ما نوقف المستخدم — نكمل بالنص كما هو
      setMsgs((m) => [...m, { who: "ai", text: "ما قدرت أحسّنها الآن — سجّلتها مثل ما كتبتها ونكمل 👍" }]);
      commit(text);
    } finally {
      setBusy(false);
    }
  }

  function approve() {
    if (!pending) return;
    const v = pending.en;
    setPending(null);
    commit(v);
  }
  function editSuggestion() {
    if (!pending) return;
    setInput(pending.en);
    setPending(null);
    setMsgs((m) => [...m, { who: "ai", text: "عدّل النص بالأسفل وأرسله — بيُعتمد مثل ما تكتبه." }]);
  }

  function download(filename: string, text: string) {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function generate(snap = data) {
    setBusy(true);
    setGenError("");
    setThinking("");
    try {
      const res = await fetch("/api/build-cv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...snap, experiences: exps, jobDescription: "", outLang: "ar" }),
      });
      const ctype = res.headers.get("content-type") || "";
      if (!ctype.includes("ndjson")) {
        const d = await res.json();
        throw new Error(d.error || "حدث خطأ");
      }
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let got: { cv: string; tips: string[] } | null = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.t === "think") setThinking((p) => p + msg.d);
            else if (msg.t === "result") got = msg.d;
            else if (msg.t === "error") throw new Error("فشل التوليد");
          } catch (e2) {
            if (e2 instanceof Error && e2.message !== line) throw e2;
          }
        }
      }
      if (!got) throw new Error("فشل التوليد");
      setCv(got.cv);
      setTips(got.tips);
      const title = `${data.name || "سيرتي"} — ${data.targetRole || "تفاعلي"}`;
      try {
        localStorage.removeItem("ra_ar_chat");
        saveResume({ title, source: "built", text: got.cv });
      } catch { /* تجاهل */ }
      // حفظ سحابي للمستخدم المسجّل (بدون انتظار؛ يفشل بصمت إن لم يكن مسجّلاً).
      fetch("/api/resumes", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, text: got.cv, source: "built", savedAt: Date.now() }) }).catch(() => {});
    } catch (e) {
      // Surface the server's specific message (e.g. a 429 rate-limit) so the user
      // isn't misled by a generic retry prompt that will just fail again.
      setGenError(e instanceof Error && e.message ? e.message : "تعذّر توليد السيرة — اضغط «حاول مرة أخرى».");
    } finally {
      setBusy(false);
    }
  }

  const bubbleAi = { background: "var(--surface)", border: "1px solid var(--line)" };
  const bubbleUser = { background: "rgba(139,92,246,0.12)", border: "1px solid rgba(139,92,246,0.3)" };

  return (
    <main dir="rtl" lang="ar" className="flex min-h-screen flex-col" style={{ background: "var(--bg)", color: "var(--fg)" }}>
      <nav className="sticky top-0 z-50 backdrop-blur" style={{ background: "rgba(8,9,10,0.7)", borderBottom: "1px solid var(--line)" }}>
        <div className="mx-auto flex max-w-2xl items-center justify-between px-6 py-4">
          <Link href="/ar" className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg font-mono text-sm font-bold" style={{ background: "var(--accent)", color: "#05130a" }}>R</div>
            <span className="text-[15px] font-bold tracking-tight">ResumeAI</span>
          </Link>
          <Link href="/ar/build" className="text-sm" style={{ color: "var(--muted)" }}>الوضع الكلاسيكي</Link>
        </div>
      </nav>

      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 py-6">
        {!cv ? (
          <>
            <div className="flex-1 space-y-3 overflow-y-auto pb-4">
              {msgs.map((m, i) =>
                m.who === "suggest" ? (
                  <div key={i} className="rounded-2xl p-4" style={{ background: "rgba(99,102,241,0.08)", border: "1px solid rgba(99,102,241,0.3)" }}>
                    <div className="mb-1 font-mono text-[11px]" style={{ color: "#a5b4fc" }}>✨ اقتراحي بالإنجليزي{m.note ? ` — ${m.note}` : ""}</div>
                    <div dir="ltr" className="whitespace-pre-wrap text-left font-mono text-sm" style={{ color: "rgba(244,245,243,0.9)" }}>{m.text}</div>
                  </div>
                ) : (
                  <div key={i} className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-relaxed ${m.who === "user" ? "mr-auto" : "ml-auto"}`}
                    style={m.who === "user" ? bubbleUser : bubbleAi}>
                    {m.text}
                  </div>
                )
              )}
              {busy && step !== "generate" && (
                <div className="ml-auto max-w-[85%] rounded-2xl px-4 py-3 text-sm" style={bubbleAi}>
                  <span className="animate-pulse">…أحسّن إجابتك</span>
                </div>
              )}
              {step === "generate" && busy && (
                <div className="rounded-2xl p-4" style={bubbleAi}>
                  <div className="mb-2 flex items-center gap-2">
                    <span className="inline-block h-2 w-2 animate-pulse rounded-full" style={{ background: "var(--accent)" }} />
                    <span className="font-mono text-xs" style={{ color: "var(--accent)" }}>جارٍ كتابة سيرتك…</span>
                  </div>
                  <div dir="ltr" className="max-h-40 overflow-y-auto whitespace-pre-wrap text-left font-mono text-xs" style={{ color: "rgba(244,245,243,0.6)" }}>
                    {thinking || "…"}
                  </div>
                </div>
              )}
              {genError && (
                <div className="rounded-2xl p-4 text-sm" style={{ background: "rgba(248,113,113,0.1)", border: "1px solid rgba(248,113,113,0.3)", color: "#f87171" }}>
                  {genError}
                  <button onClick={() => generate()} className="mr-3 rounded px-3 py-1 font-semibold" style={{ background: "var(--accent)", color: "#05130a" }}>حاول مرة أخرى</button>
                </div>
              )}
              <div ref={bottomRef} />
            </div>

            {/* أزرار الاعتماد */}
            {pending && (
              <div className="mb-3 flex gap-2">
                <button onClick={approve} className="btn-accent flex-1 py-3 font-bold">✓ اعتماد وانتقال</button>
                <button onClick={editSuggestion} className="btn-ghost px-5 py-3 text-sm font-semibold" style={{ color: "var(--fg)" }}>تعديل</button>
              </div>
            )}

            {/* الإدخال */}
            {step !== "generate" && !pending && (
              <div className="flex gap-2">
                {QUESTIONS[step]?.multiline ? (
                  <textarea value={input} onChange={(e) => setInput(e.target.value)} rows={3} disabled={busy}
                    placeholder="اكتب هنا…"
                    className="flex-1 resize-none rounded-xl px-4 py-3 text-sm focus:outline-none"
                    style={{ background: "var(--surface)", border: "1px solid var(--line)", color: "var(--fg)" }} />
                ) : (
                  <input value={input} onChange={(e) => setInput(e.target.value)} disabled={busy}
                    onKeyDown={(e) => { if (e.key === "Enter") send(); }}
                    placeholder="اكتب هنا…"
                    className="flex-1 rounded-xl px-4 py-3 text-sm focus:outline-none"
                    style={{ background: "var(--surface)", border: "1px solid var(--line)", color: "var(--fg)" }} />
                )}
                <button onClick={send} disabled={busy || !input.trim()} className="btn-accent px-6 py-3 disabled:opacity-40">إرسال</button>
              </div>
            )}
          </>
        ) : (
          <div>
            <h2 className="mb-4 text-2xl font-bold">سيرتك جاهزة 🎉</h2>
            <div className="mb-3 flex gap-2">
              {(["text", "designed"] as const).map((v) => (
                <button key={v} onClick={() => setView(v)}
                  className="rounded-lg px-4 py-2 text-sm font-semibold"
                  style={view === v ? { background: "var(--accent)", color: "#05130a" } : { background: "var(--surface)", color: "var(--muted)", border: "1px solid var(--line)" }}>
                  {v === "text" ? "نص (ATS)" : "📄 قالب مصمّم"}
                </button>
              ))}
            </div>
            {view === "designed" ? (
              <ResumeTemplate text={cv} name={data.name || "resume"} />
            ) : (
              <div dir="ltr" className="card whitespace-pre-wrap p-6 text-left font-mono text-sm leading-relaxed" style={{ color: "rgba(244,245,243,0.9)" }}>{cv}</div>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              <button onClick={() => { navigator.clipboard.writeText(cv).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 1800); }} className="rounded-lg px-4 py-2 text-sm font-semibold" style={{ background: "rgba(139,92,246,0.12)", color: "var(--accent)", border: "1px solid rgba(139,92,246,0.3)" }}>{copied ? "✓ نُسخت" : "نسخ"}</button>
              <button onClick={() => download('cv.txt', cv)} className="rounded-lg px-4 py-2 text-sm font-semibold" style={{ background: "rgba(139,92,246,0.12)", color: "var(--accent)", border: "1px solid rgba(139,92,246,0.3)" }}>↓ تنزيل .txt</button>
              <PdfExport text={cv} label="↓ تنزيل PDF" />
              <DocxExport text={cv} label="↓ تنزيل Word" filename="resume-ar.docx" />
            </div>
            <PublishLink ar text={cv} name={data.name} role={data.targetRole} />
            {tips.length > 0 && (
              <div className="card mt-6 p-5">
                <h3 className="mb-2 font-bold">نصائح لتقويتها أكثر</h3>
                <ul className="space-y-1.5 text-sm" style={{ color: "var(--muted)" }}>
                  {tips.map((t) => <li key={t}>← {t}</li>)}
                </ul>
              </div>
            )}
            <div className="mt-6 flex flex-wrap gap-3">
              <Link href="/ar/optimize" className="btn-accent px-6 py-3">افحصها ضد وظيفة حقيقية ←</Link>
              <button onClick={() => window.location.reload()} className="btn-ghost px-6 py-3 text-sm font-semibold" style={{ color: "var(--fg)" }}>سيرة جديدة</button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
