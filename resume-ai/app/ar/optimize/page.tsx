"use client";
import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import PdfExport from "../../components/PdfExport";
import BeforeAfter from "../../components/BeforeAfter";
import AuthNav from "../../components/AuthNav";
import { addScan, saveResume } from "../../lib/localdata";

interface OptimizeResult {
  matchScore: number;
  afterScore?: number;
  matchSummary: string;
  missingKeywords: string[];
  presentKeywords: string[];
  skillsGap: string[];
  improvements: { area: string; issue: string; fix: string }[];
  optimizedResume: string;
  locked?: boolean;
}

const inputStyle = { background: "var(--surface)", border: "1px solid var(--line)", color: "var(--fg)" };

// تجربة نموذجية: يشوف الزائر النتيجة كاملة بدون ما يرفع بياناته.
const SAMPLE_RESUME = `سارة العتيبي
sara.alotaibi@email.com · 05x xxx xxxx · الرياض

اشتغلت منسقة تسويق في شركة تجزئة ثلاث سنوات. كنت أدير حسابات التواصل الاجتماعي وحملات الإيميل وأساعد في تنظيم إطلاق المنتجات. قبلها متدربة تسويق سنة في وكالة صغيرة أسوي محتوى وتقارير.

المهارات: سوشال ميديا، إيميل ماركتنق، إكسل، كانفا، شوي قوقل أناليتكس

التعليم: بكالوريوس إعلام، جامعة الملك سعود، ٢٠٢٠`;

const SAMPLE_JD = `أخصائي تسويق رقمي — علامة تجارة إلكترونية
نبحث عن مسوّق يعتمد على البيانات لإدارة قنوات الإيميل والسوشال. المتطلبات: خبرة سنتين+ في التسويق الرقمي، خبرة عملية بأتمتة الإيميل (Klaviyo/Mailchimp)، حملات إعلانات مدفوعة، Google Analytics، اختبارات A/B، وتقارير معدلات التحويل. مهارات كتابة قوية. خبرة التجارة الإلكترونية أفضلية.`;

export default function ArOptimizePage() {
  const [resume, setResume] = useState("");
  const [jobDescription, setJobDescription] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<OptimizeResult | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [thinking, setThinking] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadedName, setUploadedName] = useState("");
  const [coverLetter, setCoverLetter] = useState("");
  const [coverLoading, setCoverLoading] = useState(false);
  const [coverCopied, setCoverCopied] = useState(false);
  const [hasAccess, setHasAccess] = useState(false);
  const [mode, setMode] = useState<"general" | "target">("general");
  const thinkRef = useRef<HTMLDivElement>(null);

  // هل هذا المتصفح عنده وصول مدفوع؟ المشترك اللي فحص قبل الدفع لسه معه
  // النتيجة المقصوصة القديمة — يحتاج زر إعادة فحص، مو بطاقة دفع ثانية.
  useEffect(() => {
    fetch("/api/auth/me").then((r) => r.json()).then((d) => setHasAccess(!!d.hasAccess)).catch(() => {});
  }, []);

  useEffect(() => {
    thinkRef.current?.scrollTo({ top: thinkRef.current.scrollHeight });
  }, [thinking]);

  // الخروج أثناء التوليد يقطع الطلب — نحذّر قبل الخروج بالغلط.
  useEffect(() => {
    if (!loading) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [loading]);

  // حفظ تلقائي للمسودة والنتيجة — التحديث أو الخروج مايضيّع شي.
  useEffect(() => {
    try {
      const saved = localStorage.getItem("ra_ar_optimize_draft");
      if (saved) {
        const d = JSON.parse(saved);
        if (typeof d.resume === "string") setResume(d.resume);
        if (typeof d.jobDescription === "string") setJobDescription(d.jobDescription);
        // نحفظ الوضع أيضاً — عشان إعادة الفحص بعد الدفع ما تسقط إعلان الوظيفة.
        // نرجّع وضع «التخصيص» فقط إذا كان الوضع المحفوظ فعلاً «target» ومعه إعلان —
        // وجود نص إعلان قديم وحده ما يفرض وضع التخصيص على مسودة اختار فيها المستخدم «تقييم عام».
        if (d.mode === "target" && typeof d.jobDescription === "string" && d.jobDescription.trim().length >= 30) {
          setMode("target");
        }
      }
      const savedResult = localStorage.getItem("ra_ar_optimize_result");
      if (savedResult) setResult(JSON.parse(savedResult));
    } catch { /* تجاهل */ }
  }, []);

  useEffect(() => {
    try {
      if (resume || jobDescription) {
        localStorage.setItem("ra_ar_optimize_draft", JSON.stringify({ resume, jobDescription, mode }));
      } else {
        // فرّغ المستخدم الحقلين — نحذف المسودة المحفوظة حتى لا يعيد التحديث نصاً حذفه للتو.
        localStorage.removeItem("ra_ar_optimize_draft");
      }
    } catch { /* تجاهل */ }
  }, [resume, jobDescription, mode]);

  useEffect(() => {
    try {
      if (result) localStorage.setItem("ra_ar_optimize_result", JSON.stringify(result));
      else localStorage.removeItem("ra_ar_optimize_result");
    } catch { /* تجاهل */ }
  }, [result]);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError("");
    setUploading(true);
    setUploadedName("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/extract", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error("تعذّرت قراءة الملف — الصق النص يدوياً.");
      // الـ maxLength يحد الكتابة فقط، لا النص المستخرَج — نقصّه ونحذّر بالعربي
      // قبل الفحص بدل رسالة «Input too long» الإنجليزية من الخادم.
      if (typeof data.text === "string" && data.text.length > 8000) {
        setResume(data.text.slice(0, 8000));
        setError("سيرتك طويلة — اقتصرنا على أول ٨٠٠٠ حرف. راجع النص قبل الفحص.");
      } else {
        setResume(data.text);
      }
      setUploadedName(file.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذّرت قراءة الملف.");
    } finally {
      setUploading(false);
      e.target.value = "";
    }
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

  const [coverError, setCoverError] = useState("");
  const [coverPaywalled, setCoverPaywalled] = useState(false);

  async function generateCoverLetter() {
    setCoverLoading(true);
    setCoverError("");
    setCoverPaywalled(false);
    try {
      const res = await fetch("/api/cover-letter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resume, jobDescription }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 402 || data.paywall) {
          setCoverPaywalled(true);
          throw new Error("انتهت صلاحية وصولك — افتح الوصول من جديد لإنشاء خطابات التعريف.");
        }
        // لا نعرض رسالة الخادم الإنجليزية داخل الواجهة العربية — رسالة عربية موحّدة.
        throw new Error("تعذّر إنشاء خطاب التعريف — حاول مرة أخرى.");
      }
      setCoverLetter(data.coverLetter);
    } catch (err) {
      setCoverError(err instanceof Error ? err.message : "تعذّر إنشاء خطاب التعريف.");
    } finally {
      setCoverLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await runScan();
  }

  async function runScan() {
    // وضع الاستهداف يوعد بتفصيل السيرة على الوظيفة — الإعلان إلزامي فيه.
    if (mode === "target" && jobDescription.trim().length < 30) {
      setError("وضع «تخصيص لوظيفة» يحتاج إعلان الوظيفة — الصقه، أو بدّل إلى «تقييم عام».");
      return;
    }
    setError("");
    setResult(null);
    setCoverLetter("");
    setThinking("");
    setLoading(true);
    // ملاحظة: بدون إعادة محاولة من المتصفح — السيرفر يعيد المحاولة داخلياً.
    try {
      const res = await fetch("/api/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // «تقييم عام» يتجاهل الإعلان فعلاً — الوضع يَعِد بذلك فنلتزم به.
        body: JSON.stringify({ resume, jobDescription: mode === "target" ? jobDescription : "", uiLang: "ar" }),
      });
      const ctype = res.headers.get("content-type") || "";
      if (!ctype.includes("ndjson")) {
        // رسائل الخادم كلها إنجليزية — لا نعرضها داخل واجهة عربية. رسالة موحّدة.
        await res.json().catch(() => ({}));
        throw new Error("تعذّر الفحص — تأكد أن سيرتك مكتملة (بضعة أسطر على الأقل) وضمن الحد الأقصى ٨٠٠٠ حرف، ثم حاول مجدداً.");
      }
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let got: OptimizeResult | null = null;
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
            else if (msg.t === "error") throw new Error("حدث خطأ أثناء التحليل، حاول مرة أخرى.");
          } catch (e2) {
            if (e2 instanceof Error && e2.message !== line) throw e2;
          }
        }
      }
      if (!got) throw new Error("لم يكتمل التحليل — حاول مرة أخرى.");
      setResult(got);
      try {
        addScan({
          score: got.matchScore,
          mode,
          jobTitle: mode === "target" ? (jobDescription.split("\n")[0].slice(0, 80) || "فحص مخصص") : "تقييم عام",
          lang: "ar",
          result: got,
        });
        if (!got.locked && got.optimizedResume) {
          saveResume({ title: `محسّنة — ${new Date().toLocaleDateString("ar-SA")}`, source: "optimized", text: got.optimizedResume });
        }
      } catch { /* noop */ }
    } catch (err) {
      setError(err instanceof Error ? err.message : "حدث خطأ، حاول مرة أخرى.");
    } finally {
      setLoading(false);
    }
  }

  const score = result?.matchScore ?? 0;
  const scoreColor = score >= 75 ? "#4ade80" : score >= 55 ? "#fbbf24" : "#f87171";
  // كلمة «تطابق» ما لها معنى إلا مقابل وظيفة. في التقييم العام (بدون إعلان) ما فيه
  // شي نطابقه — نستخدم صياغة محايدة عن جودة السيرة بدلاً منها.
  const verdict = mode === "target"
    ? (score >= 75 ? "تطابق قوي ✓" : score >= 55 ? "على الحد" : "تحتاج تقوية")
    : (score >= 75 ? "سيرة قوية ✓" : score >= 55 ? "بداية جيدة" : "تحتاج تقوية");

  return (
    <main dir="rtl" lang="ar" className="min-h-screen" style={{ background: "var(--bg)", color: "var(--fg)" }}>
      <nav className="sticky top-0 z-50 backdrop-blur" style={{ background: "rgba(8,9,10,0.7)", borderBottom: "1px solid var(--line)" }}>
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/ar" className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg font-mono text-sm font-bold" style={{ background: "var(--accent)", color: "#05130a" }}>R</div>
            <span className="text-[15px] font-bold tracking-tight">ResumeAI</span>
          </Link>
          <div className="flex items-center gap-5">
            <Link href="/optimize" className="text-sm" style={{ color: "var(--muted)" }}
              onClick={() => { try { localStorage.setItem("ra_optimize_draft", JSON.stringify({ resume, jobDescription, mode })); } catch { /* noop */ } }}>
              English
            </Link>
            <AuthNav ar />
          </div>
        </div>
      </nav>

      <div className="mx-auto max-w-6xl px-6 py-12">
        {loading && (
          <div className="card mx-auto mb-8 max-w-2xl overflow-hidden" style={{ borderColor: "rgba(74,222,128,0.35)" }}>
            <div className="flex items-center gap-2 px-5 py-3" style={{ borderBottom: "1px solid var(--line)", background: "rgba(74,222,128,0.05)" }}>
              <span className="inline-block h-2 w-2 animate-pulse rounded-full" style={{ background: "var(--accent)", boxShadow: "0 0 8px var(--accent)" }} />
              <span className="font-mono text-xs tracking-wider" style={{ color: "var(--accent)" }}>الذكاء الاصطناعي يحلل سيرتك — مباشرة</span>
            </div>
            <div ref={thinkRef} className="max-h-64 min-h-20 overflow-y-auto whitespace-pre-wrap px-5 py-4 font-mono text-xs leading-relaxed" style={{ color: "rgba(244,245,243,0.75)" }}>
              {thinking.replace(/^ANALYSIS\s*/i, "") || "جارٍ قراءة سيرتك…"}
              <span className="animate-pulse text-accent">▌</span>
            </div>
          </div>
        )}

        {!result && !loading && (
          <div className="mb-10 text-center">
            <div className="chip mb-4">● فحص مجاني</div>
            <h1 className="text-4xl font-extrabold tracking-tight">افحص سيرتك ضد نظام التوظيف</h1>
            <p className="mt-3" style={{ color: "var(--muted)" }}>ارفع أو الصق سيرتك القديمة (عربي أو إنجليزي) — نحسّنها ونعطيك سيرة إنجليزية جديدة. إعلان الوظيفة اختياري.</p>
            {/* وش بتحصل — توقعات واضحة قبل طلب البيانات */}
            <div className="mx-auto mt-5 flex max-w-2xl flex-wrap justify-center gap-x-5 gap-y-2 font-mono text-xs" style={{ color: "var(--faint)" }}>
              <span>✓ نسبة التطابق وسببها</span>
              <span>✓ الكلمات الناقصة</span>
              <span>✓ فجوة المهارات</span>
              <span>✓ الجمل الضعيفة</span>
              <span>✓ النسخة المحسّنة</span>
            </div>
            {!resume && !loading && (
              <button
                onClick={() => { setResume(SAMPLE_RESUME); setJobDescription(SAMPLE_JD); setMode("target"); }}
                className="btn-ghost mt-5 px-5 py-2 text-sm font-semibold" style={{ color: "var(--fg)" }}>
                👀 جرّب بسيرة نموذجية — بدون ما ترفع بياناتك
              </button>
            )}
          </div>
        )}

        {!result && !loading && (
          <div className="mb-6 flex justify-center gap-2">
            {([
              { id: "general" as const, label: "تقييم عام" },
              { id: "target" as const, label: "تخصيص لوظيفة محددة" },
            ]).map((m) => (
              <button key={m.id} type="button" onClick={() => setMode(m.id)}
                className="rounded-lg px-5 py-2 text-sm font-semibold transition-all"
                style={mode === m.id
                  ? { background: "var(--accent)", color: "#05130a" }
                  : { background: "var(--surface)", color: "var(--muted)", border: "1px solid var(--line)" }}>
                {m.label}
              </button>
            ))}
          </div>
        )}
        {!result ? (
          <form onSubmit={handleSubmit} className="grid gap-6 md:grid-cols-2">
            <div>
              <div className="mb-3 flex items-center justify-between">
                <label className="font-mono text-xs tracking-wider" style={{ color: "var(--faint)" }}>سيرتك الحالية (عربي أو إنجليزي)</label>
                <label className="cursor-pointer rounded-lg px-3 py-1.5 text-xs font-semibold"
                  style={{ background: "rgba(74,222,128,0.12)", color: "var(--accent)", border: "1px solid rgba(74,222,128,0.3)" }}>
                  {uploading ? "جارٍ القراءة…" : uploadedName ? `✓ ${uploadedName.slice(0, 18)}` : "↑ رفع PDF / Word"}
                  <input type="file" accept=".pdf,.docx,.txt,.md" onChange={handleFile} className="hidden" disabled={uploading} />
                </label>
              </div>
              <textarea value={resume} onChange={(e) => setResume(e.target.value)} rows={14} maxLength={8000} required
                placeholder="الصق سيرتك هنا بأي لغة — أو ارفع ملف PDF/Word من الزر أعلاه..."
                className="w-full resize-y rounded-xl px-4 py-3 text-sm focus:outline-none" style={{ ...inputStyle, minHeight: "12rem" }} />
              <p className="mt-2 font-mono text-xs" dir="ltr" style={{ color: resume.length > 7500 ? "#fbbf24" : "var(--faint)", textAlign: "right" }}>
                {resume.length}/8000{resume.length >= 8000 ? " — وصلت الحد الأقصى" : ""}
              </p>
              <p className="mt-2 text-xs leading-relaxed" style={{ color: "var(--faint)" }}>
                🔒 سيرتك تُعالَج فوراً <strong>ولا تُخزَّن على خوادمنا</strong> — المسودة تبقى على جهازك فقط، ولا نستخدم بياناتك لتدريب النماذج. بالفحص أنت توافق على{" "}
                <Link href="/privacy" className="underline" style={{ color: "var(--muted)" }}>سياسة الخصوصية</Link> و
                <Link href="/terms" className="underline" style={{ color: "var(--muted)" }}>الشروط</Link>.
              </p>
            </div>
            <div>
              <label className="mb-3 block font-mono text-xs tracking-wider" style={{ color: "var(--faint)" }}>
                إعلان الوظيفة {mode === "target" ? "(إلزامي للتخصيص)" : "(لا يُستخدم في التقييم العام — بدّل الوضع للتخصيص)"}
              </label>
              <textarea value={jobDescription} onChange={(e) => setJobDescription(e.target.value)} rows={14} maxLength={4000}
                placeholder="اختياري — الصق إعلان وظيفة لتفصيل السيرة عليه، أو اتركه فارغاً لتحسين شامل للسيرة."
                className="w-full resize-y rounded-xl px-4 py-3 text-sm focus:outline-none" style={{ ...inputStyle, minHeight: "12rem" }} />
              <p className="mt-2 font-mono text-xs" dir="ltr" style={{ color: jobDescription.length > 3700 ? "#fbbf24" : "var(--faint)", textAlign: "right" }}>
                {jobDescription.length}/4000
              </p>
            </div>
            <div className="text-center md:col-span-2">
              {error && <div className="mb-4 rounded-xl px-4 py-3 text-sm" style={{ background: "rgba(248,113,113,0.1)", border: "1px solid rgba(248,113,113,0.3)", color: "#f87171" }}>{error}</div>}
              <button type="submit" disabled={loading || !resume.trim()}
                className="btn-accent px-12 py-4 text-lg disabled:cursor-not-allowed disabled:opacity-40">
                {loading ? "جارٍ الفحص والتحسين…" : "⚡ افحص وحسّن"}
              </button>
              <p className="mt-3 font-mono text-xs" style={{ color: "var(--faint)" }}>~١٠ ثوانٍ فقط ⚡</p>
            </div>
          </form>
        ) : (
          <div>
            <div className="card mb-8 p-8 text-center" style={{ borderColor: `${scoreColor}55`, background: `${scoreColor}0d` }}>
              <div className="font-mono text-xs tracking-[0.2em]" style={{ color: "var(--faint)" }}>{mode === "target" ? "نسبة التطابق ATS" : "تقييم جودة السيرة"}</div>
              <div className="my-2 flex items-baseline justify-center gap-1" dir="ltr">
                <span className="font-mono text-7xl font-bold tabular-nums" style={{ color: scoreColor }}>{score}</span>
                <span className="font-mono text-2xl" style={{ color: "var(--faint)" }}>%</span>
              </div>
              <div className="mb-4 inline-block rounded-lg px-3 py-1 font-mono text-xs font-bold" style={{ background: `${scoreColor}1a`, color: scoreColor, border: `1px solid ${scoreColor}40` }}>{verdict}</div>
              <p className="mx-auto max-w-xl text-sm" style={{ color: "var(--muted)" }}>{result.matchSummary}</p>
              <a href={`/score/${score}?lang=ar`} target="_blank" rel="noopener noreferrer"
                className="mt-5 inline-block rounded-lg px-5 py-2 text-sm font-semibold"
                style={{ background: "rgba(74,222,128,0.12)", color: "var(--accent)", border: "1px solid rgba(74,222,128,0.3)" }}>
                📣 شارك نتيجتي
              </a>
            </div>

            {typeof result.afterScore === "number" && (
              <BeforeAfter before={score} after={result.afterScore} ar />
            )}

            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <h2 className="text-xl font-bold">سيرتك المحسّنة (بالإنجليزية)</h2>
                <button onClick={() => { setResult(null); setCoverLetter(""); setCoverError(""); }}
                  className="btn-ghost px-3 py-1.5 text-xs font-semibold" style={{ color: "var(--fg)" }}>
                  فحص جديد ←
                </button>
              </div>
              {!result.locked && (
                <div className="flex gap-2">
                  <button onClick={() => { navigator.clipboard.writeText(result.optimizedResume); setCopied(true); setTimeout(() => setCopied(false), 1800); }}
                    className="rounded-lg px-4 py-2 text-sm font-semibold" style={{ background: "rgba(74,222,128,0.12)", color: "var(--accent)", border: "1px solid rgba(74,222,128,0.3)" }}>
                    {copied ? "✓ نُسخت" : "نسخ"}
                  </button>
                  <button onClick={() => download("optimized-resume.txt", result.optimizedResume)}
                    className="rounded-lg px-4 py-2 text-sm font-semibold" style={{ background: "rgba(74,222,128,0.12)", color: "var(--accent)", border: "1px solid rgba(74,222,128,0.3)" }}>
                    ↓ نص
                  </button>
                  <PdfExport text={result.optimizedResume} label="↓ تنزيل PDF" />
                </div>
              )}
            </div>

            {result.locked ? (
              <div>
                <div dir="ltr" className="card whitespace-pre-wrap p-6 text-left font-mono text-sm leading-relaxed" style={{ color: "rgba(244,245,243,0.85)" }}>
                  {result.optimizedResume}
                  <div className="pointer-events-none mt-2 select-none blur-sm" style={{ color: "rgba(244,245,243,0.5)" }}>
                    {"• Rewrote every bullet with strong action verbs and quantified impact\n• Front-loaded the exact ATS keywords\n• …the full rewritten resume continues…"}
                  </div>
                </div>
                {hasAccess ? (
                  <div className="card mt-4 p-8 text-center" style={{ borderColor: "rgba(74,222,128,0.5)", background: "rgba(74,222,128,0.07)" }}>
                    <div className="chip mb-3">✓ اشتراكك مفعّل</div>
                    <h3 className="text-xl font-bold">الدفع مؤكّد — استلم سيرتك الكاملة</h3>
                    <p className="mx-auto mt-2 max-w-md text-sm" style={{ color: "var(--muted)" }}>
                      هذي النتيجة انولدت قبل ماتدفع فماتحمل إلا المعاينة. أعد الفحص الآن (~١٠ ثوانٍ) وتستلم السيرة الكاملة المعاد كتابتها.
                    </p>
                    <button onClick={runScan} disabled={loading || !resume.trim()} className="btn-accent mt-5 inline-block px-8 py-3 disabled:opacity-50">
                      {loading ? "جارٍ الفتح…" : "⚡ استلم سيرتي الكاملة الآن"}
                    </button>
                    {!resume.trim() && (
                      <p className="mt-3 text-xs" style={{ color: "#fbbf24" }}>نص سيرتك مو محفوظ على هذا الجهاز — الصقه فوق أولاً.</p>
                    )}
                  </div>
                ) : (
                  <div className="card mt-4 p-8 text-center" style={{ borderColor: "rgba(74,222,128,0.4)", background: "rgba(74,222,128,0.05)" }}>
                    <div className="chip mb-3">🔒 سيرتك الجديدة جاهزة</div>
                    <h3 className="text-xl font-bold">افتح سيرتك الكاملة المحسّنة</h3>
                    <p className="mx-auto mt-2 max-w-md text-sm" style={{ color: "var(--muted)" }}>
                      شفت نتيجتك ووش الناقص بالضبط. افتح الوصول للسيرة الكاملة المعاد كتابتها — كل نقطة مصلّحة والكلمات المفتاحية مضافة وجاهزة للتحميل. ٣٥ ريال لمرة واحدة، أو الحزمة الكاملة ٩٩ ريال دفعة واحدة بدون اشتراك.
                    </p>
                    <a href="/ar#pricing" className="btn-accent mt-5 inline-block px-8 py-3">افتح سيرتي ←</a>
                  </div>
                )}
              </div>
            ) : (
              <div dir="ltr" className="card whitespace-pre-wrap p-6 text-left font-mono text-sm leading-relaxed" style={{ color: "rgba(244,245,243,0.85)" }}>
                {result.optimizedResume}
              </div>
            )}

            {/* خطاب التعريف */}
            <div className="card mt-6 p-6" style={{ borderColor: "rgba(74,222,128,0.25)" }}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="font-bold">خطاب تعريف مطابق</h3>
                  <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
                    {jobDescription.trim().length < 30
                      ? "ألصق إعلان الوظيفة في وضع «تخصيص لوظيفة» لإنشاء خطاب تعريف مطابق"
                      : "خطاب تعريف مفصّل على نفس إعلان الوظيفة."}
                  </p>
                </div>
                {result.locked ? (
                  <a href="/ar#pricing" className="btn-accent px-5 py-2.5 text-sm">🔒 افتح الوصول لإنشائه</a>
                ) : !coverLetter ? (
                  <button onClick={generateCoverLetter} disabled={coverLoading || jobDescription.trim().length < 30} className="btn-accent px-5 py-2.5 text-sm disabled:opacity-50">
                    {coverLoading ? "جارٍ الكتابة…" : "✨ أنشئ خطاب التعريف"}
                  </button>
                ) : (
                  <div className="flex gap-2">
                    <button onClick={() => { navigator.clipboard.writeText(coverLetter); setCoverCopied(true); setTimeout(() => setCoverCopied(false), 1800); }}
                      className="rounded-lg px-4 py-2 text-sm font-semibold" style={{ background: "rgba(74,222,128,0.12)", color: "var(--accent)", border: "1px solid rgba(74,222,128,0.3)" }}>
                      {coverCopied ? "✓ نُسخ" : "نسخ"}
                    </button>
                    <button onClick={() => download("cover-letter.txt", coverLetter)}
                      className="rounded-lg px-4 py-2 text-sm font-semibold" style={{ background: "var(--accent)", color: "#05130a" }}>
                      ↓ تنزيل
                    </button>
                  </div>
                )}
              </div>
              {coverError && (
                <div className="mt-3 rounded-lg px-4 py-3 text-sm" style={{ background: "rgba(248,113,113,0.1)", border: "1px solid rgba(248,113,113,0.3)", color: "#f87171" }}>
                  {coverError}
                  {coverPaywalled && (
                    <a href="/ar#pricing" className="mr-2 font-semibold underline" style={{ color: "var(--accent)" }}>شاهد الباقات ←</a>
                  )}
                </div>
              )}
              {coverLetter && (
                <div dir="ltr" className="card mt-4 whitespace-pre-wrap p-5 text-left text-sm leading-relaxed" style={{ background: "rgba(255,255,255,0.02)", color: "rgba(244,245,243,0.85)" }}>
                  {coverLetter}
                </div>
              )}
            </div>

            <div className="card mt-8 p-8 text-center" style={{ borderColor: "rgba(74,222,128,0.4)", background: "rgba(74,222,128,0.05)" }}>
              <h3 className="text-2xl font-bold">تقدّم على أكثر من وظيفة؟</h3>
              <p className="mx-auto mt-2 max-w-md text-sm" style={{ color: "var(--muted)" }}>الحزمة الكاملة بـ ٩٩ ريال دفعة واحدة — خطاب تعريف ولينكدإن وتحضير مقابلة، بدون اشتراك.</p>
              <div className="mt-6 flex flex-wrap justify-center gap-4">
                <a href="/ar#pricing" className="btn-accent px-8 py-3">اشترك الآن ←</a>
                <button onClick={() => { setResult(null); setResume(""); setJobDescription(""); setCoverLetter(""); try { localStorage.removeItem("ra_ar_optimize_draft"); } catch { /* تجاهل */ } }}
                  className="btn-ghost px-8 py-3 font-semibold" style={{ color: "var(--fg)" }}>
                  حسّن سيرة أخرى
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
