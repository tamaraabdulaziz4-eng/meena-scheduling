"use client";
import { useState } from "react";
import Link from "next/link";

interface LinkedInResult {
  headline: string;
  about: string;
  skills: string[];
  tips: string[];
}

const inputStyle = { background: "var(--surface)", border: "1px solid var(--line)", color: "var(--fg)" };

export default function LinkedInPage() {
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
    <main className="min-h-screen" style={{ background: "var(--bg)", color: "var(--fg)" }}>
      <nav className="sticky top-0 z-50 backdrop-blur" style={{ background: "rgba(8,9,10,0.7)", borderBottom: "1px solid var(--line)" }}>
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg font-mono text-sm font-bold" style={{ background: "var(--accent)", color: "#05130a" }}>R</div>
            <span className="text-[15px] font-bold tracking-tight">ResumeAI</span>
          </Link>
          <Link href="/optimize" className="btn-accent px-4 py-2 text-sm">Resume optimizer →</Link>
        </div>
      </nav>

      <div className="mx-auto max-w-2xl px-6 py-12">
        <div className="mb-8 text-center">
          <div className="chip mb-4">● LinkedIn Optimizer</div>
          <h1 className="text-4xl font-extrabold tracking-tight">Get found by recruiters</h1>
          <p className="mt-3" style={{ color: "var(--muted)" }}>
            Paste your resume or current LinkedIn text — get a keyword-rich headline, About section, and skills list tuned for recruiter search.
          </p>
        </div>

        {!result ? (
          <form onSubmit={run} className="card space-y-4 p-7">
            <div>
              <label className="mb-2 block font-mono text-xs uppercase tracking-wider" style={{ color: "var(--faint)" }}>Your resume or current LinkedIn profile text</label>
              <textarea value={profile} onChange={(e) => setProfile(e.target.value)} rows={10} required
                placeholder="Paste your resume or your current LinkedIn headline + about + experience..."
                className="w-full resize-none rounded-lg px-4 py-2.5 text-sm focus:outline-none" style={inputStyle} />
            </div>
            <div>
              <label className="mb-2 block font-mono text-xs uppercase tracking-wider" style={{ color: "var(--faint)" }}>Target role</label>
              <input value={targetRole} onChange={(e) => setTargetRole(e.target.value)} required
                placeholder="e.g. Product Manager" className="w-full rounded-lg px-4 py-2.5 text-sm focus:outline-none" style={inputStyle} />
            </div>
            {error && <div className="rounded-lg px-3 py-2 text-xs" style={{ background: "rgba(248,113,113,0.1)", color: "#f87171" }}>{error}</div>}
            <button type="submit" disabled={loading} className="btn-accent w-full py-3 disabled:opacity-50">
              {loading ? (
                <span className="flex items-center justify-center gap-3">
                  <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-black/30 border-t-black" />
                  Optimizing your profile…
                </span>
              ) : "✨ Optimize my LinkedIn"}
            </button>
          </form>
        ) : (
          <div className="space-y-5">
            <div className="card p-6">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="font-bold">Headline</h3>
                <button onClick={() => copy("h", result.headline)} className="text-xs font-semibold" style={{ color: "var(--accent)" }}>{copied === "h" ? "✓ Copied" : "Copy"}</button>
              </div>
              <p className="text-sm leading-relaxed" style={{ color: "rgba(244,245,243,0.85)" }}>{result.headline}</p>
            </div>
            <div className="card p-6">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="font-bold">About section</h3>
                <button onClick={() => copy("a", result.about)} className="text-xs font-semibold" style={{ color: "var(--accent)" }}>{copied === "a" ? "✓ Copied" : "Copy"}</button>
              </div>
              <p className="whitespace-pre-wrap text-sm leading-relaxed" style={{ color: "rgba(244,245,243,0.85)" }}>{result.about}</p>
            </div>
            <div className="card p-6">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="font-bold">Skills to list (in this order)</h3>
                <button onClick={() => copy("s", result.skills.join(", "))} className="text-xs font-semibold" style={{ color: "var(--accent)" }}>{copied === "s" ? "✓ Copied" : "Copy"}</button>
              </div>
              <div className="flex flex-wrap gap-2">
                {result.skills.map((s) => (
                  <span key={s} className="rounded-full px-3 py-1 text-xs font-medium" style={{ background: "rgba(74,222,128,0.14)", color: "var(--accent)" }}>{s}</span>
                ))}
              </div>
            </div>
            {result.tips?.length > 0 && (
              <div className="card p-6" style={{ borderColor: "rgba(251,191,36,0.25)" }}>
                <h3 className="mb-3 font-bold">Profile tips</h3>
                <ul className="space-y-2">
                  {result.tips.map((t) => (
                    <li key={t} className="flex gap-2 text-sm" style={{ color: "var(--muted)" }}><span style={{ color: "#fbbf24" }}>→</span> {t}</li>
                  ))}
                </ul>
              </div>
            )}
            <button onClick={() => setResult(null)} className="mx-auto block text-sm" style={{ color: "var(--faint)" }}>Optimize again</button>
          </div>
        )}
      </div>
    </main>
  );
}
