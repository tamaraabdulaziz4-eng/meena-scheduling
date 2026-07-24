"use client";
import { useState } from "react";
import OrbBrand from "../components/OrbBrand";
import OrbSceneSetter from "../components/orb/OrbSceneSetter";
import Link from "next/link";
import useLang from "../components/useLang";

interface LinkedInResult {
  headline: string;
  about: string;
  skills: string[];
  tips: string[];
}

const inputStyle = { background: "var(--surface)", border: "1px solid var(--line)", color: "var(--fg)" };

export default function LinkedInPage() {
  const ar = useLang();
  const [profile, setProfile] = useState("");
  const [targetRole, setTargetRole] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<LinkedInResult | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setResult(null);
    setLoading(true);
    try {
      const res = await fetch("/api/tools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "linkedin", inputA: profile, inputB: targetRole }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      if (!data.headline && !data.about) throw new Error("Couldn't optimize this time — please try again.");
      setResult({ headline: data.headline || "", about: data.about || "", skills: Array.isArray(data.skills) ? data.skills : [], tips: Array.isArray(data.tips) ? data.tips : [] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  function copy(what: string, text: string) {
    navigator.clipboard.writeText(text);
    setCopied(what);
    setTimeout(() => setCopied(""), 1800);
  }

  return (
    <main dir={ar ? "rtl" : "ltr"} className="min-h-screen" style={{ background: "var(--bg)", color: "var(--fg)" }}>
      <OrbSceneSetter visible mood="idle" top="14vh" left="86%" size={100} />
      <nav className="sticky top-0 z-50" style={{ background: "linear-gradient(180deg, rgba(5,7,13,0.85), transparent)" }}>
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2.5">
            <OrbBrand size={26} />
            <span className="text-[15px] font-bold tracking-tight">Sira</span>
          </Link>
          <Link href="/optimize" className="btn-accent px-4 py-2 text-sm">{ar ? "محسّن السيرة ←" : "Resume optimizer →"}</Link>
        </div>
      </nav>

      <div className="mx-auto max-w-2xl px-6 py-12">
        <div className="mb-8 text-center">
          <div className="chip mb-4">● {ar ? "محسّن لينكدإن" : "LinkedIn Optimizer"}</div>
          <h1 className="text-4xl font-extrabold tracking-tight">{ar ? "ليجدك مسؤولو التوظيف" : "Get found by recruiters"}</h1>
          <p className="mt-3" style={{ color: "var(--muted)" }}>
            {ar ? "الصق سيرتك أو نص لينكدإن الحالي — واحصل على عنوان غني بالكلمات المفتاحية، وقسم «نبذة»، وقائمة مهارات مضبوطة لبحث مسؤولي التوظيف." : "Paste your resume or current LinkedIn text — get a keyword-rich headline, About section, and skills list tuned for recruiter search."}
          </p>
        </div>

        {!result ? (
          <form onSubmit={run} className="card space-y-4 p-7">
            <div>
              <label className="mb-2 block font-mono text-xs uppercase tracking-wider" style={{ color: "var(--faint)" }}>{ar ? "سيرتك أو نص ملف لينكدإن الحالي" : "Your resume or current LinkedIn profile text"}</label>
              <textarea value={profile} onChange={(e) => setProfile(e.target.value)} rows={10} required
                placeholder={ar ? "الصق سيرتك أو العنوان والنبذة والخبرة الحالية…" : "Paste your resume or your current LinkedIn headline + about + experience..."}
                className="w-full resize-none rounded-lg px-4 py-2.5 text-sm focus:outline-none" style={inputStyle} />
            </div>
            <div>
              <label className="mb-2 block font-mono text-xs uppercase tracking-wider" style={{ color: "var(--faint)" }}>{ar ? "الدور المستهدف" : "Target role"}</label>
              <input value={targetRole} onChange={(e) => setTargetRole(e.target.value)} required
                placeholder={ar ? "مثال: مدير منتج" : "e.g. Product Manager"} className="w-full rounded-lg px-4 py-2.5 text-sm focus:outline-none" style={inputStyle} />
            </div>
            {error && <div className="rounded-lg px-3 py-2 text-xs" style={{ background: "rgba(248,113,113,0.1)", color: "#f87171" }}>{error}</div>}
            <button type="submit" disabled={loading} className="btn-accent w-full py-3 disabled:opacity-50">
              {loading ? (
                <span className="flex items-center justify-center gap-3">
                  <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-black/30 border-t-black" />
                  {ar ? "جارٍ تحسين ملفك…" : "Optimizing your profile…"}
                </span>
              ) : (ar ? "حسّن لينكدإن" : "Optimize my LinkedIn")}
            </button>
          </form>
        ) : (
          <div className="space-y-5">
            <div className="card p-6">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="font-bold">{ar ? "العنوان" : "Headline"}</h3>
                <button onClick={() => copy("h", result.headline)} className="text-xs font-semibold" style={{ color: "var(--accent)" }}>{copied === "h" ? (ar ? "نُسخ" : "Copied") : (ar ? "نسخ" : "Copy")}</button>
              </div>
              <p className="text-sm leading-relaxed" style={{ color: "rgba(244,245,243,0.85)" }}>{result.headline}</p>
            </div>
            <div className="card p-6">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="font-bold">{ar ? "قسم النبذة" : "About section"}</h3>
                <button onClick={() => copy("a", result.about)} className="text-xs font-semibold" style={{ color: "var(--accent)" }}>{copied === "a" ? (ar ? "نُسخ" : "Copied") : (ar ? "نسخ" : "Copy")}</button>
              </div>
              <p className="whitespace-pre-wrap text-sm leading-relaxed" style={{ color: "rgba(244,245,243,0.85)" }}>{result.about}</p>
            </div>
            <div className="card p-6">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="font-bold">{ar ? "المهارات المطلوب إدراجها (بهذا الترتيب)" : "Skills to list (in this order)"}</h3>
                <button onClick={() => copy("s", result.skills.join(", "))} className="text-xs font-semibold" style={{ color: "var(--accent)" }}>{copied === "s" ? (ar ? "نُسخ" : "Copied") : (ar ? "نسخ" : "Copy")}</button>
              </div>
              <div className="flex flex-wrap gap-2">
                {result.skills.map((s, i) => (
                  <span key={`${s}-${i}`} className="rounded-full px-3 py-1 text-xs font-medium" style={{ background: "rgba(139,92,246,0.14)", color: "var(--accent)" }}>{s}</span>
                ))}
              </div>
            </div>
            {result.tips?.length > 0 && (
              <div className="card p-6" style={{ borderColor: "rgba(251,191,36,0.25)" }}>
                <h3 className="mb-3 font-bold">{ar ? "نصائح للملف" : "Profile tips"}</h3>
                <ul className="space-y-2">
                  {result.tips.map((t, i) => (
                    <li key={`${t}-${i}`} className="flex gap-2 text-sm" style={{ color: "var(--muted)" }}><span style={{ color: "#fbbf24" }}>→</span> {t}</li>
                  ))}
                </ul>
              </div>
            )}
            <button onClick={() => setResult(null)} className="mx-auto block text-sm" style={{ color: "var(--faint)" }}>{ar ? "تحسين مرة أخرى" : "Optimize again"}</button>
          </div>
        )}
      </div>
    </main>
  );
}
