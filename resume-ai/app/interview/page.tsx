"use client";
import { useState } from "react";
import OrbBrand from "../components/OrbBrand";
import OrbSceneSetter from "../components/orb/OrbSceneSetter";
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
  const [copied, setCopied] = useState(false);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setResult(null);
    setLoading(true);

    // One attempt against /api/tools. Returns questions, or throws.
    async function attempt(): Promise<{ questions: InterviewResult["questions"]; redFlags: string[] }> {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 55000);
      try {
        const res = await fetch("/api/tools", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: ctrl.signal,
          body: JSON.stringify({ mode: "interview", inputA: resume, inputB: jd }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Server ${res.status}`);
        if (!Array.isArray(data.questions) || data.questions.length === 0) throw new Error("empty");
        return { questions: data.questions, redFlags: Array.isArray(data.redFlags) ? data.redFlags : [] };
      } finally {
        clearTimeout(timer);
      }
    }

    // The free model fails intermittently; auto-retry once transparently so a
    // single flaky call never dead-ends the user on a blank form.
    let ok: { questions: InterviewResult["questions"]; redFlags: string[] } | null = null;
    let lastErr = "";
    for (let i = 0; i < 2 && !ok; i++) {
      try { ok = await attempt(); }
      catch (err) { lastErr = err instanceof Error ? err.message : ""; }
    }

    if (ok) {
      setResult(ok);
      setOpen(0);
    } else {
      // Guarantee a visible state — never end on a silent blank form.
      const isNetwork = /failed to fetch|load failed|networkerror|aborted/i.test(lastErr) || lastErr === "empty" || lastErr === "";
      setError(isNetwork
        ? "The AI was busy for a moment — your text is still here. Tap Retry to prepare your questions."
        : lastErr || "Something went wrong. Tap Retry.");
    }
    setLoading(false);
  }

  return (
    <main className="min-h-screen" style={{ background: "var(--bg)", color: "var(--fg)" }}>
      <OrbSceneSetter visible mood="idle" top="14vh" left="86%" size={100} />
      <nav className="sticky top-0 z-50 backdrop-blur" style={{ background: "rgba(8,9,10,0.7)", borderBottom: "1px solid var(--line)" }}>
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2.5">
            <OrbBrand size={26} />
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
            {error && (
              <div className="rounded-lg px-3 py-2 text-xs" style={{ background: "rgba(248,113,113,0.1)", color: "#f87171" }}>
                <div>{error}</div>
                {resume.trim() && jd.trim() && !loading && (
                  <button type="submit" className="mt-2 inline-block rounded-lg px-3 py-1 text-xs font-semibold"
                    style={{ background: "rgba(139,92,246,0.15)", color: "var(--accent)", border: "1px solid rgba(139,92,246,0.4)" }}>
                    ↻ Retry
                  </button>
                )}
              </div>
            )}
            <button type="submit" disabled={loading} className="btn-accent w-full py-3 disabled:opacity-50">
              {loading ? (
                <span className="flex items-center justify-center gap-3">
                  <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-black/30 border-t-black" />
                  Preparing your interview…
                </span>
              ) : "Prep my interview"}
            </button>
          </form>
        ) : (
          <div className="space-y-4">
            <div className="mb-2 flex justify-end">
              <button
                onClick={() => {
                  const txt = result.questions.map((q, i) => `${i + 1}. ${q.q}\n(${q.why})\n${q.answer}`).join("\n\n") +
                    (result.redFlags.length ? `\n\n--- Be ready for ---\n${result.redFlags.map((r) => `• ${r}`).join("\n")}` : "");
                  navigator.clipboard.writeText(txt);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1800);
                }}
                className="rounded-lg px-4 py-2 text-sm font-semibold"
                style={{ background: "rgba(139,92,246,0.12)", color: "var(--accent)", border: "1px solid rgba(139,92,246,0.3)" }}>
                {copied ? "Copied" : "Copy all"}
              </button>
            </div>
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
                  <div className="border-t px-5 py-4 text-sm leading-relaxed" style={{ borderColor: "var(--line)", color: "rgba(244,245,243,0.85)", background: "rgba(139,92,246,0.03)" }}>
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
                  {result.redFlags.map((r, i) => (
                    <li key={`${r}-${i}`} className="flex gap-2 text-sm" style={{ color: "var(--muted)" }}><span style={{ color: "#f87171" }}>!</span> {r}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="card mt-4 p-6 text-center" style={{ borderColor: "rgba(139,92,246,0.3)", background: "rgba(139,92,246,0.04)" }}>
              <p className="text-sm" style={{ color: "var(--muted)" }}>Make sure your resume matches this job first —</p>
              <Link href="/optimize" className="btn-accent mt-3 inline-block px-6 py-2.5 text-sm">Scan it against this job free →</Link>
            </div>
            <button onClick={() => setResult(null)} className="mx-auto block text-sm" style={{ color: "var(--faint)" }}>Prep another interview</button>
          </div>
        )}
      </div>
    </main>
  );
}
