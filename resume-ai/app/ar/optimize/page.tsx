"use client";
import AiOrb from "../../components/AiOrb";
import OrbBrand from "../../components/OrbBrand";
import OrbSceneSetter from "../../components/orb/OrbSceneSetter";
import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import PdfExport from "../../components/PdfExport";
import DocxExport from "../../components/DocxExport";
import BeforeAfter from "../../components/BeforeAfter";
import ResumeTemplate from "../../components/ResumeTemplate";
import { TEMPLATE_CATALOG } from "../../lib/templateCatalog";
import ScoreOrb from "../../components/orb/ScoreOrb";
import ResultCoaching from "../../components/ResultCoaching";
import GapFiller from "../../components/GapFiller";
import CheckoutButton from "../../components/CheckoutButton";
import AuthNav from "../../components/AuthNav";
import { addScan, saveResume } from "../../lib/localdata";
import { useBackToForm, useCountUp } from "../../lib/resultUx";

interface OptimizeResult {
  matchScore: number;
  afterScore?: number;
  matchSummary: string;
  missingKeywords: string[];
  presentKeywords: string[];
  skillsGap: string[];
  improvements: { area: string; issue: string; fix: string; source?: string }[];
  optimizedResume: string;
  locked?: boolean;
  watermark?: boolean;
}

const inputStyle = { background: "var(--surface)", border: "1px solid var(--line)", color: "var(--fg)" };

// علامة مائية لتنزيل النص المجاني (.txt).
function wmTxt(text: string): string {
  const line = "— أُنشئت مجاناً عبر cv.rabit.sa —";
  return `${line}\n\n${text}\n\n${line}`;
}

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
  const [mode, setMode] = useState<"general" | "target">("general");
  const [resumeView, setResumeView] = useState<"text" | "designed">("text");
  const [tplSlug, setTplSlug] = useState("ats-pro");
  const [outLang, setOutLang] = useState<"en" | "ar" | "both">("ar");
  const [step, setStep] = useState(1); // معالج نظيف: ١ السيرة · ٢ الوظيفة · ٣ اللغة والبدء
  const thinkRef = useRef<HTMLDivElement>(null);

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

  async function runScan(resumeOverride?: string) {
    const resumeText = typeof resumeOverride === "string" ? resumeOverride : resume;
    // وضع الاستهداف يوعد بتفصيل السيرة على الوظيفة — الإعلان إلزامي فيه.
    if (mode === "target" && jobDescription.trim().length < 30) {
      setError("وضع «تخصيص لوظيفة» يحتاج إعلان الوظيفة — الصقه، أو بدّل إلى «تقييم عام».");
      return;
    }
    setError("");
    setResult(null);
    setCoverLetter("");
    setThinking("");
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
    setLoading(true);
    // ملاحظة: بدون إعادة محاولة من المتصفح — السيرفر يعيد المحاولة داخلياً.
    try {
      const res = await fetch("/api/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // «تقييم عام» يتجاهل الإعلان فعلاً — الوضع يَعِد بذلك فنلتزم به.
        body: JSON.stringify({ resume: resumeText, jobDescription: mode === "target" ? jobDescription : "", uiLang: "ar", outLang }),
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
  const scoreColor = score >= 75 ? "#a78bfa" : score >= 55 ? "#fbbf24" : "#f87171";
  // زر الرجوع في صفحة النتيجة يرجع لنموذج الفحص بدل الخروج من الموقع، مع عدّاد
  // تصاعدي على النتيجة (لحظة 32→72 لازم تنبض مو تظهر فجأة).
  useBackToForm(!!result, () => setResult(null));
  const displayScore = useCountUp(result ? score : 0);
  // كلمة «تطابق» ما لها معنى إلا مقابل وظيفة. في التقييم العام (بدون إعلان) ما فيه
  // شي نطابقه — نستخدم صياغة محايدة عن جودة السيرة بدلاً منها.
  const verdict = mode === "target"
    ? (score >= 75 ? "تطابق قوي ✓" : score >= 55 ? "على الحد" : "تحتاج تقوية")
    : (score >= 75 ? "سيرة قوية ✓" : score >= 55 ? "بداية جيدة" : "تحتاج تقوية");

  return (
    <main dir="rtl" lang="ar" className="min-h-screen" style={{ background: "var(--bg)", color: "var(--fg)" }}>
      <OrbSceneSetter visible mood="idle" top="14vh" left="14%" size={100} />
      <nav className="sticky top-0 z-50" style={{ background: "linear-gradient(180deg, rgba(5,7,13,0.85), transparent)" }}>
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/ar" className="flex items-center gap-2.5">
            <OrbBrand size={26} />
            <span className="text-[15px] font-bold tracking-tight">سيرة</span>
          </Link>
          <div className="flex items-center gap-5">
            <Link href="/optimize" className="rounded-lg px-3 py-2 text-sm" style={{ color: "var(--muted)", border: "1px solid var(--line)" }}
              onClick={() => { try { localStorage.setItem("ra_optimize_draft", JSON.stringify({ resume, jobDescription, mode })); localStorage.setItem("ra_lang", "en"); } catch { /* noop */ } }}>
              English
            </Link>
            <AuthNav ar />
          </div>
        </div>
      </nav>

      <div className="mx-auto max-w-6xl px-6 py-12">
        {/* التحميل يُعرض داخل المعالج بالأسفل */}

        {!result ? (
          <div className="mx-auto max-w-2xl">
            {/* شريط تقدّم — قرار واحد كل شاشة */}
            {!loading && (
              <div className="mb-8">
                <div className="mb-2 flex items-center justify-between">
                  <div className="font-mono text-xs" style={{ color: "var(--faint)" }}>الخطوة {step} من ٣</div>
                  {step > 1 && <button onClick={() => setStep(step - 1)} className="text-xs font-semibold" style={{ color: "var(--muted)" }}>→ رجوع</button>}
                </div>
                <div className="flex gap-2">
                  {[1, 2, 3].map((s) => (
                    <div key={s} className="h-1.5 flex-1 rounded-full" style={{ background: s <= step ? "var(--accent)" : "var(--line)" }} />
                  ))}
                </div>
              </div>
            )}

            {loading ? (
              <div className="card mx-auto max-w-2xl overflow-hidden" style={{ borderColor: "rgba(139,92,246,0.35)" }}>
                <div className="flex items-center gap-2 px-5 py-3" style={{ borderBottom: "1px solid var(--line)", background: "rgba(139,92,246,0.05)" }}>
                  <AiOrb size={22} thinking />
                  <span className="font-mono text-xs tracking-[0.2em]" style={{ color: "var(--accent)" }}>جارٍ التحليل — مباشر</span>
                </div>
                <div className="px-5 py-4 font-mono text-xs leading-relaxed" style={{ color: "rgba(244,245,243,0.75)" }}>
                  {thinking.replace(/^ANALYSIS\s*/i, "") || "نقرأ سيرتك…"}<span className="animate-pulse text-accent">▌</span>
                </div>
              </div>
            ) : step === 1 ? (
              <div>
                <h1 className="text-3xl font-extrabold tracking-tight">أضف سيرتك</h1>
                <p className="mt-2 mb-5 text-sm" style={{ color: "var(--muted)" }}>ارفع ملفاً أو الصق النص. لن نغيّر أي كلمة بدون موافقتك.</p>
                <div className="mb-3 flex flex-wrap gap-2">
                  <label className="cursor-pointer rounded-lg px-4 py-2 text-sm font-semibold" style={{ background: "rgba(139,92,246,0.12)", color: "var(--accent)", border: "1px solid rgba(139,92,246,0.3)" }}>
                    {uploading ? "جارٍ القراءة…" : uploadedName ? `${uploadedName.slice(0, 18)}` : "↑ رفع PDF / Word"}
                    <input type="file" accept=".pdf,.docx,.txt,.md" onChange={handleFile} className="hidden" disabled={uploading} />
                  </label>
                  {!resume && <button onClick={() => { setResume(SAMPLE_RESUME); setJobDescription(SAMPLE_JD); setMode("target"); }} className="btn-ghost px-4 py-2 text-sm font-semibold" style={{ color: "var(--fg)" }}>👀 جرّب نموذج</button>}
                </div>
                <textarea value={resume} onChange={(e) => setResume(e.target.value)} rows={12} maxLength={8000}
                  placeholder="الصق سيرتك هنا بأي لغة — الخبرات، التعليم، المهارات، معلومات التواصل…"
                  className="w-full resize-y rounded-xl px-4 py-3 text-sm focus:outline-none" style={{ ...inputStyle, minHeight: "11rem" }} />
                <p className="mt-2 font-mono text-xs" dir="ltr" style={{ color: resume.length > 7500 ? "#fbbf24" : "var(--faint)", textAlign: "right" }}>{resume.length}/8000</p>
                <button disabled={resume.trim().length < 50} onClick={() => setStep(2)} className="btn-accent mt-5 w-full py-3.5 text-base disabled:cursor-not-allowed disabled:opacity-40">متابعة ←</button>
                <p className="mt-3 text-center text-[11px]" style={{ color: "var(--faint)" }}>🔒 تُعالَج فوراً · لا تُخزَّن على خوادمنا</p>
              </div>
            ) : step === 2 ? (
              <div>
                <h1 className="text-3xl font-extrabold tracking-tight">الوظيفة (اختياري)</h1>
                <p className="mt-2 mb-5 text-sm" style={{ color: "var(--muted)" }}>أضف الإعلان لنفصّل السيرة عليه، أو تخطّاه لتحسين شامل.</p>
                <textarea value={jobDescription} onChange={(e) => { const v = e.target.value; setJobDescription(v); if (v.trim().length >= 30) setMode("target"); else setMode("general"); }}
                  rows={10} maxLength={4000}
                  placeholder="الصق إعلان الوظيفة هنا."
                  className="w-full resize-y rounded-xl px-4 py-3 text-sm focus:outline-none" style={{ ...inputStyle, minHeight: "9rem" }} />
                <div className="mt-5 flex gap-2">
                  <button onClick={() => { setMode("general"); setStep(3); }} className="btn-ghost flex-1 py-3 text-sm font-semibold" style={{ color: "var(--fg)" }}>تخطّي</button>
                  <button onClick={() => setStep(3)} className="btn-accent flex-[2] py-3 text-base">متابعة ←</button>
                </div>
              </div>
            ) : (
              <div>
                <h1 className="text-3xl font-extrabold tracking-tight">لغة السيرة</h1>
                <p className="mt-2 mb-5 text-sm" style={{ color: "var(--muted)" }}>بأي لغة تريد السيرة المحسّنة؟</p>
                <div className="mb-6 grid grid-cols-3 gap-2">
                  {([{ id: "ar", label: "العربية" }, { id: "en", label: "الإنجليزية" }, { id: "both", label: "الاثنتان" }] as const).map((o) => (
                    <button key={o.id} onClick={() => setOutLang(o.id)} className="rounded-xl py-3 text-sm font-semibold transition-all"
                      style={outLang === o.id ? { background: "var(--accent)", color: "#ffffff" } : { background: "var(--surface)", color: "var(--muted)", border: "1px solid var(--line)" }}>{o.label}</button>
                  ))}
                </div>
                <div className="mb-4 rounded-xl p-4 text-sm" style={{ background: "rgba(139,92,246,0.05)", border: "1px solid rgba(139,92,246,0.2)", color: "var(--muted)" }}>
                  <div className="mb-1 font-semibold" style={{ color: "var(--fg)" }}>{mode === "target" ? "مخصّصة لإعلان الوظيفة" : "تحسين شامل"}</div>
                  مجاناً: درجة الملاءمة، الكلمات الناقصة، فجوة المهارات، معاينة. <span style={{ color: "var(--accent)" }}>السيرة الكاملة بعد الفتح.</span>
                </div>
                {error && (
                  <div className="mb-4 rounded-xl px-4 py-3 text-sm" style={{ background: "rgba(248,113,113,0.1)", border: "1px solid rgba(248,113,113,0.3)", color: "#f87171" }}>
                    <div>{error}</div>
                    {resume.trim() && <button type="button" onClick={() => runScan()} className="mt-2 inline-block rounded-lg px-4 py-1.5 text-xs font-semibold" style={{ background: "rgba(139,92,246,0.15)", color: "var(--accent)", border: "1px solid rgba(139,92,246,0.4)" }}>↻ إعادة</button>}
                  </div>
                )}
                <button onClick={() => runScan()} disabled={resume.trim().length < 50} className="btn-accent w-full py-4 text-lg disabled:opacity-40">⚡ حلّل سيرتي مجاناً</button>
                <p className="mt-3 text-center font-mono text-xs" style={{ color: "var(--faint)" }}>~١٠ ثوانٍ ⚡</p>
              </div>
            )}
          </div>
        ) : (
          <div>
            <div className="card mb-8 p-8 text-center" style={{ borderColor: `${scoreColor}55`, background: `${scoreColor}0d` }}>
              <div className="font-mono text-xs tracking-[0.2em]" style={{ color: "var(--faint)" }}>{mode === "target" ? "درجة الملاءمة مع الوظيفة" : "تقييم جودة السيرة"}</div>
              {mode === "target" && <div className="mb-1 text-xs" style={{ color: "var(--faint)" }}>مدى قرب سيرتك من الإعلان — ليست ضماناً لاجتياز أي نظام توظيف</div>}
              <div className="my-3 flex justify-center">
                <ScoreOrb value={displayScore} color={scoreColor} animate={false} size={150} />
              </div>
              <div className="mb-4 inline-block rounded-lg px-3 py-1 font-mono text-xs font-bold" style={{ background: `${scoreColor}1a`, color: scoreColor, border: `1px solid ${scoreColor}40` }}>{verdict}</div>
              <p className="mx-auto max-w-xl text-sm" style={{ color: "var(--muted)" }}>{result.matchSummary}</p>
              <a href={`/score/${score}?lang=ar`} target="_blank" rel="noopener noreferrer"
                className="mt-5 inline-block rounded-lg px-5 py-2 text-sm font-semibold"
                style={{ background: "rgba(139,92,246,0.12)", color: "var(--accent)", border: "1px solid rgba(139,92,246,0.3)" }}>
                📣 شارك نتيجتي
              </a>
            </div>

            {typeof result.afterScore === "number" && (
              <BeforeAfter before={score} after={result.afterScore} ar />
            )}

            <ResultCoaching
              before={score}
              after={result.afterScore ?? score}
              improvements={result.improvements || []}
              missingKeywords={result.missingKeywords || []}
              skillsGap={result.skillsGap || []}
              hasPlaceholders={/\[(add|أضف)[^\]]*\]/i.test(result.optimizedResume || "")}
              ar
            />

            <GapFiller
              missingKeywords={result.missingKeywords || []}
              skillsGap={result.skillsGap || []}
              ar
              busy={loading}
              onApply={(additions) => { const enriched = resume + additions; setResume(enriched); runScan(enriched); }}
            />

            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <h2 className="text-xl font-bold">سيرتك المحسّنة</h2>
                <button onClick={() => { setResult(null); setCoverLetter(""); setCoverError(""); }}
                  className="btn-ghost px-3 py-1.5 text-xs font-semibold" style={{ color: "var(--fg)" }}>
                  فحص جديد ←
                </button>
              </div>
              {!result.locked && (
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => { navigator.clipboard.writeText(result.optimizedResume); setCopied(true); setTimeout(() => setCopied(false), 1800); }}
                    className="rounded-lg px-4 py-2 text-sm font-semibold" style={{ background: "rgba(139,92,246,0.12)", color: "var(--accent)", border: "1px solid rgba(139,92,246,0.3)" }}>
                    {copied ? "نُسخت" : "نسخ"}
                  </button>
                  <button onClick={() => download("optimized-resume.txt", result.watermark ? wmTxt(result.optimizedResume) : result.optimizedResume)}
                    className="rounded-lg px-4 py-2 text-sm font-semibold" style={{ background: "rgba(139,92,246,0.12)", color: "var(--accent)", border: "1px solid rgba(139,92,246,0.3)" }}>
                    ↓ نص
                  </button>
                  <PdfExport text={result.optimizedResume} label="↓ تنزيل PDF" watermark={result.watermark} lang="ar" />
                  <DocxExport text={result.optimizedResume} label="↓ تنزيل Word" filename="resume-ar.docx" watermark={result.watermark} lang="ar" />
                </div>
              )}
            </div>

            {!result.locked && (
              <div className="mb-3 flex gap-2">
                {(["text", "designed"] as const).map((v) => (
                  <button key={v} onClick={() => setResumeView(v)}
                    className="rounded-lg px-4 py-2 text-sm font-semibold"
                    style={resumeView === v ? { background: "var(--accent)", color: "#ffffff" } : { background: "var(--surface)", color: "var(--muted)", border: "1px solid var(--line)" }}>
                    {v === "text" ? "نص (ATS)" : "قالب مصمّم"}
                  </button>
                ))}
              </div>
            )}
            {!result.locked && resumeView === "designed" ? (
              <div>
                <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
                  {TEMPLATE_CATALOG.map((tp) => (
                    <button key={tp.slug} onClick={() => setTplSlug(tp.slug)}
                      className="shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold"
                      style={tplSlug === tp.slug ? { background: "var(--accent)", color: "#ffffff" } : { background: "var(--surface)", color: "var(--muted)", border: "1px solid var(--line)" }}>
                      {tp.nameAr}{tp.best ? " ★" : ""}
                    </button>
                  ))}
                </div>
                {(() => {
                  const tp = TEMPLATE_CATALOG.find((x) => x.slug === tplSlug) || TEMPLATE_CATALOG[0];
                  return <ResumeTemplate text={result.optimizedResume} name="resume" variant={tp.variant} accent={tp.accent} fitWidth />;
                })()}
              </div>
            ) : (
              <div dir="ltr" className="card whitespace-pre-wrap p-6 text-left font-mono text-sm leading-relaxed" style={{ color: "rgba(244,245,243,0.85)" }}>
                {result.optimizedResume}
              </div>
            )}
            {result.watermark && (
              <div className="card mt-4 p-8 text-center" style={{ borderColor: "rgba(139,92,246,0.4)", background: "rgba(139,92,246,0.05)" }}>
                <div className="chip mb-3">سيرتك جاهزة — مجاناً</div>
                <h3 className="text-xl font-bold">
                  {typeof result.afterScore === "number"
                    ? `حمّل نسخة نظيفة — ارفع نتيجتك من ${score} إلى ${result.afterScore} (متوقّعة).`
                    : "حمّل نسخة نظيفة بدون علامة مائية"}
                </h3>
                <p className="mx-auto mt-2 max-w-md text-sm" style={{ color: "var(--muted)" }}>
                  تنزيلك المجاني (PDF/Word) عليه علامة صغيرة «cv.rabit.sa». أزلها — وافتح خطاب التعريف ولينكدإن وتحضير المقابلة — بـ٣٥ ريال مرة واحدة، أو الحزمة الكاملة ٩٩ ريال. بدون اشتراك.
                </p>
                <div className="mx-auto mt-5 max-w-xs space-y-3">
                  <CheckoutButton ar plan="single" label="أزل العلامة — ٣٥ ريالاً" variant="accent" />
                  <CheckoutButton ar plan="complete" label="الحزمة الكاملة (٩٩ ريالاً)" variant="ghost" />
                </div>
                <p className="mt-4 text-xs" style={{ color: "var(--faint)" }}>
                  <a href="/terms" className="underline underline-offset-2">ضمان استرجاع خلال ٧ أيام</a>
                </p>
              </div>
            )}

            {/* خطاب التعريف */}
            <div className="card mt-6 p-6" style={{ borderColor: "rgba(139,92,246,0.25)" }}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="font-bold">خطاب تعريف مطابق</h3>
                  <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
                    {jobDescription.trim().length < 30
                      ? "اضغط «فحص جديد ←»، أضِف إعلان الوظيفة، ثم أعد الفحص لإنشاء خطاب تعريف مطابق"
                      : "خطاب تعريف مفصّل على نفس إعلان الوظيفة."}
                  </p>
                </div>
                {result.watermark ? (
                  <a href="/ar#pricing" className="btn-accent px-5 py-2.5 text-sm">🔒 افتح الوصول لإنشائه</a>
                ) : !coverLetter ? (
                  <button onClick={generateCoverLetter} disabled={coverLoading || jobDescription.trim().length < 30} className="btn-accent px-5 py-2.5 text-sm disabled:opacity-50">
                    {coverLoading ? "جارٍ الكتابة…" : "إنشاء خطاب التعريف"}
                  </button>
                ) : (
                  <div className="flex gap-2">
                    <button onClick={() => { navigator.clipboard.writeText(coverLetter); setCoverCopied(true); setTimeout(() => setCoverCopied(false), 1800); }}
                      className="rounded-lg px-4 py-2 text-sm font-semibold" style={{ background: "rgba(139,92,246,0.12)", color: "var(--accent)", border: "1px solid rgba(139,92,246,0.3)" }}>
                      {coverCopied ? "نُسخ" : "نسخ"}
                    </button>
                    <button onClick={() => download("cover-letter.txt", coverLetter)}
                      className="rounded-lg px-4 py-2 text-sm font-semibold" style={{ background: "var(--accent)", color: "#ffffff" }}>
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

            <div className="card mt-8 p-8 text-center" style={{ borderColor: "rgba(139,92,246,0.4)", background: "rgba(139,92,246,0.05)" }}>
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
