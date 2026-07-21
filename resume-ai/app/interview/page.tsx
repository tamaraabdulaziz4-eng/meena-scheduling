"use client";
import { useState } from "react";
import Link from "next/link";

interface InterviewResult {
  questions: { q: string; why: string; answer: string }[];
  redFlags: string[];
}

const inputStyle = { background: "var(--surface)", border: "1px solid var(--line)", color: "var(--fg)" };

export default function InterviewPage() {
  const [resume, setResume] = useState("");
  const [jd, setJd] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<InterviewResult | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<number | null>(0);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setResult(null);
    setLoading(true);
    try {
      const res = await fetch("/api/tools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "interview", inputA: resume, inputB: jd }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setResult(data);
      setOpen(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
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
          <div className="chip mb-4">● Interview Prep</div>
          <h1 className="text-4xl font-extrabold tracking-tight">Know the questions before they ask</h1>
          <p className="mt-3" style={{ color: "var(--muted)" }}>
            Paste your resume and the job posting — get the 8 questions they&apos;ll most likely ask, with strong answers built from <em>your</em> background.
          </p>
        </div>

        {!result ? (
          <form onSubmit={run} className="card space-y-4 p-7">
            <div>
              <label className="mb-2 block font-mono text-xs uppercase tracking-wider" style={{ color: "var(--faint)" }}>Your resume</label>
              <textarea value={resume} onChange={(e) => setResume(e.target.value)} rows={8} required
                placeholder="Paste your resume..." className="w-full resize-none rounded-lg px-4 py-2.5 text-sm focus:outline-none" style={inputStyle} />
            </div>
            <div>
              <label className="mb-2 block font-mono text-xs uppercase tracking-wider" style={{ color: "var(--faint)" }}>Job description</label>
              <textarea value={jd} onChange={(e) => setJd(e.target.value)} rows={6} required
                placeholder="Paste the job posting..." className="w-full resize-none rounded-lg px-4 py-2.5 text-sm focus:outline-none" style={inputStyle} />
            </div>
            {error && <div className="rounded-lg px-3 py-2 text-xs" style={{ background: "rgba(248,113,113,0.1)", color: "#f87171" }}>{error}</div>}
            <button type="submit" disabled={loading} className="btn-accent w-full py-3 disabled:opacity-50">
              {loading ? (
                <span className="flex items-center justify-center gap-3">
                  <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-black/30 border-t-black" />
                  Preparing your interview…
                </span>
              ) : "🎯 Prep my interview"}
            </button>
          </form>
        ) : (
          <div className="space-y-4">
            {result.questions.map((item, i) => (
              <div key={i} className="card overflow-hidden">
                <button onClick={() => setOpen(open === i ? null : i)} className="flex w-full items-start justify-between gap-3 p-5 text-left">
                  <div>
                    <div className="text-sm font-bold">{i + 1}. {item.q}</div>
                    <div className="mt-1 font-mono text-xs" style={{ color: "var(--faint)" }}>{item.why}</div>
                  </div>
                  <span className="mt-0.5 font-mono text-accent">{open === i ? "−" : "+"}</span>
                </button>
                {open === i && (
                  <div className="border-t px-5 py-4 text-sm leading-relaxed" style={{ borderColor: "var(--line)", color: "rgba(244,245,243,0.85)", background: "rgba(74,222,128,0.03)" }}>
                    <div className="mb-1 font-mono text-xs uppercase tracking-wider text-accent">Strong answer</div>
                    {item.answer}
                  </div>
                )}
              </div>
            ))}

            {result.redFlags?.length > 0 && (
              <div className="card p-6" style={{ borderColor: "rgba(248,113,113,0.25)" }}>
                <h3 className="mb-3 font-bold">They may probe these — be ready</h3>
                <ul className="space-y-2">
                  {result.redFlags.map((r) => (
                    <li key={r} className="flex gap-2 text-sm" style={{ color: "var(--muted)" }}><span style={{ color: "#f87171" }}>!</span> {r}</li>
                  ))}
                </ul>
              </div>
            )}
            <button onClick={() => setResult(null)} className="mx-auto block text-sm" style={{ color: "var(--faint)" }}>Prep another interview</button>
          </div>
        )}
      </div>
    </main>
  );
}
