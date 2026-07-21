"use client";
import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import PdfExport from "../../components/PdfExport";

interface Exp {
  role: string;
  company: string;
  dates: string;
  duties: string;
}

const inputStyle = { background: "var(--surface)", border: "1px solid var(--line)", color: "var(--fg)" };

export default function ArBuildPage() {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [targetRole, setTargetRole] = useState("");
  const [exps, setExps] = useState<Exp[]>([{ role: "", company: "", dates: "", duties: "" }]);
  const [education, setEducation] = useState("");
  const [skills, setSkills] = useState("");
  const [extras, setExtras] = useState("");
  const [jobDescription, setJobDescription] = useState("");

  const [loading, setLoading] = useState(false);
  const [thinking, setThinking] = useState("");
  const [cv, setCv] = useState("");
  const [tips, setTips] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const thinkRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    thinkRef.current?.scrollTo({ top: thinkRef.current.scrollHeight });
  }, [thinking]);

  function setExp(i: number, field: keyof Exp, v: string) {
    setExps((prev) => prev.map((e, j) => (j === i ? { ...e, [field]: v } : e)));
  }

  async function generate() {
    setError("");
    setThinking("");
    setCv("");
    setTips([]);
    setLoading(true);
    try {
      const res = await fetch("/api/build-cv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name, contact, targetRole,
          experiences: exps.filter((e) => e.role.trim() || e.company.trim()),
          education, skills, extras, jobDescription,
        }),
      });
      const ctype = res.headers.get("content-type") || "";
      if (!ctype.includes("ndjson")) {
        const data = await res.json();
        throw new Error(data.error || "حدث خطأ، حاول مرة أخرى.");
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
            else if (msg.t === "error") throw new Error("حدث خطأ أثناء الإنشاء، حاول مرة أخرى.");
          } catch (e2) {
            if (e2 instanceof Error && e2.message !== line) throw e2;
          }
        }
      }
      if (!got) throw new Error("لم يكتمل الإنشاء — حاول مرة أخرى.");
      setCv(got.cv);
      setTips(got.tips);
    } catch (err) {
      setError(err instanceof Error ? err.message : "حدث خطأ.");
    } finally {
      setLoading(false);
    }
  }

  const steps = ["عنك", "خبراتك", "تعليمك ومهاراتك", "الوظيفة المستهدفة"];
  const canNext =
    step === 0 ? name.trim().length > 1 && targetRole.trim().length > 1
    : step === 1 ? true
    : step === 2 ? education.trim().length > 0 || exps.some((e) => e.role.trim())
    : true;

  return (
    <main dir="rtl" lang="ar" className="min-h-screen" style={{ background: "var(--bg)", color: "var(--fg)" }}>
      <nav className="sticky top-0 z-50 backdrop-blur" style={{ background: "rgba(8,9,10,0.7)", borderBottom: "1px solid var(--line)" }}>
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/ar" className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg font-mono text-sm font-bold" style={{ background: "var(--accent)", color: "#05130a" }}>R</div>
            <span className="text-[15px] font-bold tracking-tight">ResumeAI</span>
          </Link>
          <div className="flex items-center gap-5">
            <Link href="/build" className="text-sm" style={{ color: "var(--muted)" }}>English</Link>
            <Link href="/ar/optimize" className="text-sm" style={{ color: "var(--muted)" }}>عندك سيرة؟ حسّنها ←</Link>
          </div>
        </div>
      </nav>

      <div className="mx-auto max-w-2xl px-6 py-12">
        {!cv && !loading && (
          <>
            <div className="mb-8 text-center">
              <div className="chip mb-4">● إنشاء سيرة ذاتية</div>
              <h1 className="text-4xl font-extrabold tracking-tight">اكتب بالعربي — واستلم سيرة إنجليزية احترافية</h1>
              <p className="mt-3" style={{ color: "var(--muted)" }}>
                جاوب بكلامك العادي وبأي لغة. الذكاء الاصطناعي يترجم ويصيغ ويضبط كل شيء بصياغة احترافية تعبر أنظمة التوظيف.
              </p>
            </div>

            <div className="mb-8 flex items-center justify-center gap-2">
              {steps.map((s, i) => (
                <div key={s} className="flex items-center gap-2">
                  <div className="flex h-7 w-7 items-center justify-center rounded-full font-mono text-xs font-bold"
                    style={i <= step ? { background: "var(--accent)", color: "#05130a" } : { background: "var(--surface)", color: "var(--faint)", border: "1px solid var(--line)" }}>
                    {i + 1}
                  </div>
                  <span className="hidden text-xs sm:block" style={{ color: i <= step ? "var(--fg)" : "var(--faint)" }}>{s}</span>
                  {i < steps.length - 1 && <div className="h-px w-6" style={{ background: "var(--line)" }} />}
                </div>
              ))}
            </div>

            <div className="card space-y-4 p-7">
              {step === 0 && (
                <>
                  <div>
                    <label className="mb-2 block text-xs font-semibold" style={{ color: "var(--faint)" }}>اسمك الكامل</label>
                    <input value={name} onChange={(e) => setName(e.target.value)} placeholder="أحمد العلي" className="w-full rounded-lg px-4 py-2.5 text-sm focus:outline-none" style={inputStyle} />
                  </div>
                  <div>
                    <label className="mb-2 block text-xs font-semibold" style={{ color: "var(--faint)" }}>التواصل (إيميل، جوال، مدينة، لينكدإن)</label>
                    <input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="ahmed@email.com · 05xxxxxxxx · الرياض" className="w-full rounded-lg px-4 py-2.5 text-sm focus:outline-none" style={inputStyle} />
                  </div>
                  <div>
                    <label className="mb-2 block text-xs font-semibold" style={{ color: "var(--faint)" }}>وش الوظيفة اللي تبيها؟</label>
                    <input value={targetRole} onChange={(e) => setTargetRole(e.target.value)} placeholder="مثال: محاسب، مهندس برمجيات، مدير مبيعات" className="w-full rounded-lg px-4 py-2.5 text-sm focus:outline-none" style={inputStyle} />
                  </div>
                </>
              )}

              {step === 1 && (
                <>
                  <p className="text-sm" style={{ color: "var(--muted)" }}>
                    اكتب عن كل وظيفة اشتغلتها بكلامك العادي — وش كنت تسوي؟ وش حسّنت؟ كم شخص/عميل/مشروع؟ لا تهتم بالصياغة، هذي شغلة الذكاء الاصطناعي. ما عندك خبرة؟ تجاوز هذه الخطوة.
                  </p>
                  {exps.map((e, i) => (
                    <div key={i} className="space-y-3 rounded-xl p-4" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid var(--line)" }}>
                      <div className="grid gap-3 sm:grid-cols-3">
                        <input value={e.role} onChange={(ev) => setExp(i, "role", ev.target.value)} placeholder="المسمى الوظيفي" className="rounded-lg px-3 py-2 text-sm focus:outline-none" style={inputStyle} />
                        <input value={e.company} onChange={(ev) => setExp(i, "company", ev.target.value)} placeholder="الشركة" className="rounded-lg px-3 py-2 text-sm focus:outline-none" style={inputStyle} />
                        <input value={e.dates} onChange={(ev) => setExp(i, "dates", ev.target.value)} placeholder="٢٠٢١ – ٢٠٢٤" className="rounded-lg px-3 py-2 text-sm focus:outline-none" style={inputStyle} />
                      </div>
                      <textarea value={e.duties} onChange={(ev) => setExp(i, "duties", ev.target.value)} rows={3}
                        placeholder="مثال: كنت أخدم العملاء وأرد على الشكاوى، دربت موظفين جدد، المبيعات ارتفعت وأنا موجود..."
                        className="w-full resize-none rounded-lg px-3 py-2 text-sm focus:outline-none" style={inputStyle} />
                      {exps.length > 1 && (
                        <button onClick={() => setExps((p) => p.filter((_, j) => j !== i))} className="text-xs" style={{ color: "#f87171" }}>حذف</button>
                      )}
                    </div>
                  ))}
                  {exps.length < 8 && (
                    <button onClick={() => setExps((p) => [...p, { role: "", company: "", dates: "", duties: "" }])}
                      className="btn-ghost w-full py-2.5 text-sm font-semibold" style={{ color: "var(--fg)" }}>
                      + أضف وظيفة أخرى
                    </button>
                  )}
                </>
              )}

              {step === 2 && (
                <>
                  <div>
                    <label className="mb-2 block text-xs font-semibold" style={{ color: "var(--faint)" }}>التعليم</label>
                    <textarea value={education} onChange={(e) => setEducation(e.target.value)} rows={2}
                      placeholder="مثال: بكالوريوس علوم حاسب، جامعة الملك سعود، ٢٠٢٢" className="w-full resize-none rounded-lg px-4 py-2.5 text-sm focus:outline-none" style={inputStyle} />
                  </div>
                  <div>
                    <label className="mb-2 block text-xs font-semibold" style={{ color: "var(--faint)" }}>مهاراتك (اكتبها بأي ترتيب)</label>
                    <textarea value={skills} onChange={(e) => setSkills(e.target.value)} rows={2}
                      placeholder="مثال: إكسل، خدمة عملاء، بايثون، عمل جماعي، عربي وإنجليزي" className="w-full resize-none rounded-lg px-4 py-2.5 text-sm focus:outline-none" style={inputStyle} />
                  </div>
                  <div>
                    <label className="mb-2 block text-xs font-semibold" style={{ color: "var(--faint)" }}>شهادات، لغات، مشاريع (اختياري)</label>
                    <textarea value={extras} onChange={(e) => setExtras(e.target.value)} rows={2}
                      placeholder="مثال: شهادة PMP، آيلتس ٧، سويت متجر إلكتروني صغير" className="w-full resize-none rounded-lg px-4 py-2.5 text-sm focus:outline-none" style={inputStyle} />
                  </div>
                </>
              )}

              {step === 3 && (
                <>
                  <label className="mb-2 block text-xs font-semibold" style={{ color: "var(--faint)" }}>تقدّم على وظيفة محددة؟ الصق الإعلان (اختياري لكنه قوي)</label>
                  <textarea value={jobDescription} onChange={(e) => setJobDescription(e.target.value)} rows={7}
                    placeholder="الصق إعلان الوظيفة هنا وستُفصَّل السيرة عليه — أو اتركه فارغاً لسيرة عامة." className="w-full resize-none rounded-lg px-4 py-2.5 text-sm focus:outline-none" style={inputStyle} />
                </>
              )}

              {error && <div className="rounded-lg px-3 py-2 text-xs" style={{ background: "rgba(248,113,113,0.1)", color: "#f87171" }}>{error}</div>}

              <div className="flex justify-between pt-2">
                <button onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}
                  className="btn-ghost px-6 py-2.5 text-sm font-semibold disabled:opacity-30" style={{ color: "var(--fg)" }}>
                  → رجوع
                </button>
                {step < 3 ? (
                  <button onClick={() => setStep((s) => s + 1)} disabled={!canNext} className="btn-accent px-6 py-2.5 text-sm disabled:opacity-40">
                    التالي ←
                  </button>
                ) : (
                  <button onClick={generate} className="btn-accent px-8 py-2.5 text-sm">✨ ابنِ سيرتي</button>
                )}
              </div>
            </div>
          </>
        )}

        {loading && (
          <div className="card overflow-hidden" style={{ borderColor: "rgba(74,222,128,0.35)" }}>
            <div className="flex items-center gap-2 px-5 py-3" style={{ borderBottom: "1px solid var(--line)", background: "rgba(74,222,128,0.05)" }}>
              <span className="inline-block h-2 w-2 animate-pulse rounded-full" style={{ background: "var(--accent)", boxShadow: "0 0 8px var(--accent)" }} />
              <span className="font-mono text-xs tracking-wider" style={{ color: "var(--accent)" }}>الذكاء الاصطناعي يكتب سيرتك — مباشرة</span>
            </div>
            <div ref={thinkRef} className="max-h-72 min-h-24 overflow-y-auto whitespace-pre-wrap px-5 py-4 font-mono text-xs leading-relaxed" style={{ color: "rgba(244,245,243,0.75)" }}>
              {thinking.replace(/^ANALYSIS\s*/i, "") || "جارٍ قراءة إجاباتك…"}
              <span className="animate-pulse text-accent">▌</span>
            </div>
          </div>
        )}

        {cv && !loading && (
          <div>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-2xl font-bold">سيرتك جاهزة 🎉</h2>
              <div className="flex gap-2">
                <button onClick={() => { navigator.clipboard.writeText(cv); setCopied(true); setTimeout(() => setCopied(false), 1800); }}
                  className="rounded-lg px-4 py-2 text-sm font-semibold" style={{ background: "rgba(74,222,128,0.12)", color: "var(--accent)", border: "1px solid rgba(74,222,128,0.3)" }}>
                  {copied ? "✓ نُسخت" : "نسخ"}
                </button>
                <PdfExport text={cv} label="↓ تنزيل PDF" />
              </div>
            </div>
            <div dir="ltr" className="card whitespace-pre-wrap p-6 text-left font-mono text-sm leading-relaxed" style={{ color: "rgba(244,245,243,0.85)" }}>{cv}</div>

            {tips.length > 0 && (
              <div className="card mt-6 p-6" style={{ borderColor: "rgba(251,191,36,0.25)" }}>
                <h3 className="mb-3 font-bold">نصائح لتقويتها أكثر</h3>
                <ul className="space-y-2">
                  {tips.map((t) => (
                    <li key={t} className="flex gap-2 text-sm" style={{ color: "var(--muted)" }}><span style={{ color: "#fbbf24" }}>←</span> {t}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="card mt-6 p-7 text-center" style={{ borderColor: "rgba(74,222,128,0.4)", background: "rgba(74,222,128,0.05)" }}>
              <h3 className="text-xl font-bold">الحين خلّها تعبر أنظمة التوظيف</h3>
              <p className="mx-auto mt-2 max-w-md text-sm" style={{ color: "var(--muted)" }}>
                افحص سيرتك الجديدة ضد إعلان وظيفة حقيقي واعرف نسبة تطابقك.
              </p>
              <Link href="/ar/optimize" className="btn-accent mt-5 inline-block px-8 py-3">افحصها الآن — مجاناً ←</Link>
            </div>

            <button onClick={() => { setCv(""); setTips([]); setStep(0); }} className="mx-auto mt-6 block text-sm" style={{ color: "var(--faint)" }}>
              ابدأ من جديد
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
