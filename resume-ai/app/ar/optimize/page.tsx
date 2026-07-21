"use client";
import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import PdfExport from "../../components/PdfExport";

interface OptimizeResult {
  matchScore: number;
  matchSummary: string;
  missingKeywords: string[];
  presentKeywords: string[];
  skillsGap: string[];
  improvements: { area: string; issue: string; fix: string }[];
  optimizedResume: string;
}

const inputStyle = { background: "var(--surface)", border: "1px solid var(--line)", color: "var(--fg)" };

export default function ArOptimizePage() {
  const [resume, setResume] = useState("");
  const [jobDescription, setJobDescription] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<OptimizeResult | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [paywall, setPaywall] = useState(false);
  const [thinking, setThinking] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadedName, setUploadedName] = useState("");
  const thinkRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    thinkRef.current?.scrollTo({ top: thinkRef.current.scrollHeight });
  }, [thinking]);

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
      setResume(data.text);
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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setResult(null);
    setPaywall(false);
    setThinking("");
    setLoading(true);
    try {
      const res = await fetch("/api/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resume, jobDescription }),
      });
      const ctype = res.headers.get("content-type") || "";
      if (!ctype.includes("ndjson")) {
        const data = await res.json();
        if (res.status === 402 || data.paywall) {
          setPaywall(true);
          return;
        }
        throw new Error(data.error || "حدث خطأ، حاول مرة أخرى.");
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
    } catch (err) {
      setError(err instanceof Error ? err.message : "حدث خطأ، حاول مرة أخرى.");
    } finally {
      setLoading(false);
    }
  }

  const score = result?.matchScore ?? 0;
  const scoreColor = score >= 75 ? "#4ade80" : score >= 55 ? "#fbbf24" : "#f87171";
  const verdict = score >= 75 ? "ستصل للمقابلة ✓" : score >= 55 ? "على الحد" : "سيرفضها النظام ✕";

  return (
    <main dir="rtl" lang="ar" className="min-h-screen" style={{ background: "var(--bg)", color: "var(--fg)" }}>
      <nav className="sticky top-0 z-50 backdrop-blur" style={{ background: "rgba(8,9,10,0.7)", borderBottom: "1px solid var(--line)" }}>
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/ar" className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg font-mono text-sm font-bold" style={{ background: "var(--accent)", color: "#05130a" }}>R</div>
            <span className="text-[15px] font-bold tracking-tight">ResumeAI</span>
          </Link>
          <div className="flex items-center gap-5">
            <Link href="/optimize" className="text-sm" style={{ color: "var(--muted)" }}>English</Link>
            <a href="/ar#pricing" className="btn-accent px-4 py-2 text-sm">فتح غير محدود ←</a>
          </div>
        </div>
      </nav>

      <div className="mx-auto max-w-6xl px-6 py-12">
        {loading && thinking && (
          <div className="card mx-auto mb-8 max-w-2xl overflow-hidden" style={{ borderColor: "rgba(74,222,128,0.35)" }}>
            <div className="flex items-center gap-2 px-5 py-3" style={{ borderBottom: "1px solid var(--line)", background: "rgba(74,222,128,0.05)" }}>
              <span className="inline-block h-2 w-2 animate-pulse rounded-full" style={{ background: "var(--accent)", boxShadow: "0 0 8px var(--accent)" }} />
              <span className="font-mono text-xs tracking-wider" style={{ color: "var(--accent)" }}>الذكاء الاصطناعي يحلل سيرتك — مباشرة</span>
            </div>
            <div ref={thinkRef} className="max-h-64 overflow-y-auto whitespace-pre-wrap px-5 py-4 font-mono text-xs leading-relaxed" style={{ color: "rgba(244,245,243,0.75)" }}>
              {thinking.replace(/^ANALYSIS\s*/i, "")}
              <span className="animate-pulse text-accent">▌</span>
            </div>
          </div>
        )}

        {paywall && (
          <div className="card mx-auto mb-8 max-w-2xl p-8 text-center" style={{ borderColor: "rgba(74,222,128,0.4)", background: "rgba(74,222,128,0.05)" }}>
            <div className="chip mb-4">● انتهى الفحص المجاني</div>
            <h2 className="text-2xl font-bold">افتح التحسينات غير المحدودة</h2>
            <p className="mx-auto mt-2 max-w-md text-sm" style={{ color: "var(--muted)" }}>
              استخدمت فحصك المجاني. احصل على فحص واحد بـ ٩ دولار أو غير محدود بـ ١٩ دولار شهرياً.
            </p>
            <a href="/ar#pricing" className="btn-accent mt-6 inline-block px-8 py-3">شاهد الباقات ←</a>
          </div>
        )}

        {!result && !loading && (
          <div className="mb-10 text-center">
            <div className="chip mb-4">● فحص مجاني</div>
            <h1 className="text-4xl font-extrabold tracking-tight">افحص سيرتك ضد نظام التوظيف</h1>
            <p className="mt-3" style={{ color: "var(--muted)" }}>ارفع أو الصق سيرتك القديمة (عربي أو إنجليزي) — نحسّنها ونعطيك سيرة إنجليزية جديدة. إعلان الوظيفة اختياري.</p>
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
              <textarea value={resume} onChange={(e) => setResume(e.target.value)} rows={18} required
                placeholder="الصق سيرتك هنا بأي لغة — أو ارفع ملف PDF/Word من الزر أعلاه..."
                className="w-full resize-none rounded-xl px-4 py-3 text-sm focus:outline-none" style={inputStyle} />
            </div>
            <div>
              <label className="mb-3 block font-mono text-xs tracking-wider" style={{ color: "var(--faint)" }}>إعلان الوظيفة (اختياري)</label>
              <textarea value={jobDescription} onChange={(e) => setJobDescription(e.target.value)} rows={18}
                placeholder="اختياري — الصق إعلان وظيفة لتفصيل السيرة عليه، أو اتركه فارغاً لتحسين شامل للسيرة."
                className="w-full resize-none rounded-xl px-4 py-3 text-sm focus:outline-none" style={inputStyle} />
            </div>
            <div className="text-center md:col-span-2">
              {error && <div className="mb-4 rounded-xl px-4 py-3 text-sm" style={{ background: "rgba(248,113,113,0.1)", border: "1px solid rgba(248,113,113,0.3)", color: "#f87171" }}>{error}</div>}
              <button type="submit" disabled={loading || !resume.trim()}
                className="btn-accent px-12 py-4 text-lg disabled:cursor-not-allowed disabled:opacity-40">
                {loading ? "جارٍ الفحص والتحسين…" : "⚡ افحص وحسّن"}
              </button>
              <p className="mt-3 font-mono text-xs" style={{ color: "var(--faint)" }}>٣٠–٦٠ ثانية تقريباً</p>
            </div>
          </form>
        ) : (
          <div>
            <div className="card mb-8 p-8 text-center" style={{ borderColor: `${scoreColor}55`, background: `${scoreColor}0d` }}>
              <div className="font-mono text-xs tracking-[0.2em]" style={{ color: "var(--faint)" }}>نسبة التطابق ATS</div>
              <div className="my-2 flex items-baseline justify-center gap-1" dir="ltr">
                <span className="font-mono text-7xl font-bold tabular-nums" style={{ color: scoreColor }}>{score}</span>
                <span className="font-mono text-2xl" style={{ color: "var(--faint)" }}>%</span>
              </div>
              <div className="mb-4 inline-block rounded-lg px-3 py-1 font-mono text-xs font-bold" style={{ background: `${scoreColor}1a`, color: scoreColor, border: `1px solid ${scoreColor}40` }}>{verdict}</div>
              <p className="mx-auto max-w-xl text-sm" style={{ color: "var(--muted)" }}>{result.matchSummary}</p>
            </div>

            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-xl font-bold">سيرتك المحسّنة (بالإنجليزية)</h2>
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
            </div>
            <div dir="ltr" className="card whitespace-pre-wrap p-6 text-left font-mono text-sm leading-relaxed" style={{ color: "rgba(244,245,243,0.85)" }}>
              {result.optimizedResume}
            </div>

            <div className="mt-6 grid gap-6 md:grid-cols-2">
              <div className="card p-6" style={{ borderColor: "rgba(248,113,113,0.2)" }}>
                <h3 className="mb-4 font-bold">كلمات مفتاحية ناقصة ({result.missingKeywords.length})</h3>
                <div className="flex flex-wrap gap-2" dir="ltr">
                  {result.missingKeywords.map((k) => (
                    <span key={k} className="rounded-full px-3 py-1 text-xs font-medium" style={{ background: "rgba(248,113,113,0.14)", color: "#f87171" }}>{k}</span>
                  ))}
                </div>
              </div>
              <div className="card p-6" style={{ borderColor: "rgba(74,222,128,0.2)" }}>
                <h3 className="mb-4 font-bold">كلمات موجودة ({result.presentKeywords.length})</h3>
                <div className="flex flex-wrap gap-2" dir="ltr">
                  {result.presentKeywords.map((k) => (
                    <span key={k} className="rounded-full px-3 py-1 text-xs font-medium" style={{ background: "rgba(74,222,128,0.14)", color: "var(--accent)" }}>{k}</span>
                  ))}
                </div>
              </div>
            </div>

            <div className="card mt-8 p-8 text-center" style={{ borderColor: "rgba(74,222,128,0.4)", background: "rgba(74,222,128,0.05)" }}>
              <h3 className="text-2xl font-bold">تقدّم على أكثر من وظيفة؟</h3>
              <p className="mx-auto mt-2 max-w-md text-sm" style={{ color: "var(--muted)" }}>غير محدود بـ ١٩ دولار شهرياً — كل تقديم بسيرة مخصصة.</p>
              <div className="mt-6 flex flex-wrap justify-center gap-4">
                <a href="/ar#pricing" className="btn-accent px-8 py-3">اشترك الآن ←</a>
                <button onClick={() => { setResult(null); setResume(""); setJobDescription(""); }}
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
