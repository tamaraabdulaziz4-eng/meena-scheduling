"use client";
import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import PdfExport from "../components/PdfExport";

interface OptimizeResult {
  matchScore: number;
  matchSummary: string;
  missingKeywords: string[];
  presentKeywords: string[];
  skillsGap: string[];
  improvements: { area: string; issue: string; fix: string }[];
  optimizedResume: string;
}

export default function OptimizePage() {
  const [resume, setResume] = useState("");
  const [jobDescription, setJobDescription] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<OptimizeResult | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"resume" | "analysis">("resume");
  const [copied, setCopied] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadedName, setUploadedName] = useState("");
  const [coverLetter, setCoverLetter] = useState("");
  const [coverLoading, setCoverLoading] = useState(false);
  const [coverCopied, setCoverCopied] = useState(false);
  const [paywall, setPaywall] = useState(false);
  const [thinking, setThinking] = useState("");
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
      if (!res.ok) throw new Error(data.error || "Failed to read file");
      setResume(data.text);
      setUploadedName(file.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to read file.");
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

  async function generateCoverLetter() {
    setCoverLoading(true);
    setError("");
    try {
      const res = await fetch("/api/cover-letter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resume, jobDescription }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setCoverLetter(data.coverLetter);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate cover letter.");
    } finally {
      setCoverLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setResult(null);
    setCoverLetter("");
    setPaywall(false);
    setThinking("");
    setLoading(true);

    for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch("/api/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resume, jobDescription }),
      });

      // Non-streaming replies (validation errors, paywall) are plain JSON.
      const ctype = res.headers.get("content-type") || "";
      if (!ctype.includes("ndjson")) {
        const data = await res.json();
        if (res.status === 402 || data.paywall) {
          setPaywall(true);
          setLoading(false);
          return;
        }
        throw new Error(data.error || "Failed");
      }

      // Streaming: read NDJSON lines — live thinking, then the final result.
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
            if (msg.t === "think") setThinking((prev) => prev + msg.d);
            else if (msg.t === "result") got = msg.d;
            else if (msg.t === "error") throw new Error(msg.d);
          } catch (e) {
            if (e instanceof Error && e.message !== line) throw e;
          }
        }
      }
      if (!got) throw new Error("The analysis didn't complete. Please try again.");
      setResult(got);
      setTab("resume");
      setLoading(false);
      return;
    } catch (err) {
      if (attempt === 0) { setThinking(""); continue; }
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    }
    }
    setLoading(false);
  }

  const score = result?.matchScore ?? 0;
  const scoreColor = score >= 75 ? "#4ade80" : score >= 55 ? "#fbbf24" : "#f87171";
  const verdict = score >= 75 ? "SHORTLISTED" : score >= 55 ? "BORDERLINE" : "REJECTED BY ATS";

  return (
    <main className="min-h-screen" style={{ background: "var(--bg)", color: "var(--fg)" }}>
      {/* Nav */}
      <nav className="sticky top-0 z-50 backdrop-blur" style={{ background: "rgba(8,9,10,0.7)", borderBottom: "1px solid var(--line)" }}>
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg font-mono text-sm font-bold"
              style={{ background: "var(--accent)", color: "#05130a" }}>R</div>
            <span className="text-[15px] font-bold tracking-tight">ResumeAI</span>
          </Link>
          <div className="flex items-center gap-5">
            <Link href="/login" className="text-sm" style={{ color: "var(--muted)" }}>Sign in</Link>
            <a href="/#pricing" className="btn-accent px-4 py-2 text-sm">Unlock unlimited →</a>
          </div>
        </div>
      </nav>

      <div className="mx-auto max-w-6xl px-6 py-12">
        {loading && thinking && (
          <div className="card mx-auto mb-8 max-w-2xl overflow-hidden" style={{ borderColor: "rgba(74,222,128,0.35)" }}>
            <div className="flex items-center gap-2 px-5 py-3" style={{ borderBottom: "1px solid var(--line)", background: "rgba(74,222,128,0.05)" }}>
              <span className="inline-block h-2 w-2 animate-pulse rounded-full" style={{ background: "var(--accent)", boxShadow: "0 0 8px var(--accent)" }} />
              <span className="font-mono text-xs uppercase tracking-[0.2em]" style={{ color: "var(--accent)" }}>AI analyzing your resume — live</span>
            </div>
            <div ref={thinkRef} className="max-h-64 overflow-y-auto whitespace-pre-wrap px-5 py-4 font-mono text-xs leading-relaxed"
              style={{ color: "rgba(244,245,243,0.75)" }}>
              {thinking.replace(/^ANALYSIS\s*/i, "")}
              <span className="animate-pulse text-accent">▌</span>
            </div>
          </div>
        )}
        {paywall && (
          <div className="card mx-auto mb-8 max-w-2xl p-8 text-center" style={{ borderColor: "rgba(74,222,128,0.4)", background: "rgba(74,222,128,0.05)" }}>
            <div className="chip mb-4">● Free scan used</div>
            <h2 className="text-2xl font-bold">Unlock unlimited optimizations</h2>
            <p className="mx-auto mt-2 max-w-md text-sm" style={{ color: "var(--muted)" }}>
              You&apos;ve used your free scan. Get a one-time pass for $9 or go unlimited for $19/mo — every resume optimized, cover letters included.
            </p>
            <a href="/#pricing" className="btn-accent mt-6 inline-block px-8 py-3">See plans →</a>
          </div>
        )}
        {!result && (
          <div className="mb-10 text-center">
            <div className="chip mb-4">● Free scan</div>
            <h1 className="text-4xl font-extrabold tracking-tight">Run your resume through the scanner</h1>
            <p className="mt-3" style={{ color: "var(--muted)" }}>Upload or paste your resume. Add a job posting to tailor to it — or leave it empty and we&apos;ll improve the resume overall.</p>
          </div>
        )}

        {!result ? (
          <form onSubmit={handleSubmit} className="grid gap-6 md:grid-cols-2">
            <div>
              <div className="mb-3 flex items-center justify-between">
                <label className="font-mono text-xs uppercase tracking-wider" style={{ color: "var(--faint)" }}>Your current resume</label>
                <label className="cursor-pointer rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors"
                  style={{ background: "rgba(74,222,128,0.12)", color: "var(--accent)", border: "1px solid rgba(74,222,128,0.3)" }}>
                  {uploading ? "Reading…" : uploadedName ? `✓ ${uploadedName.slice(0, 22)}` : "↑ Upload PDF / Word"}
                  <input type="file" accept=".pdf,.docx,.txt,.md" onChange={handleFile} className="hidden" disabled={uploading} />
                </label>
              </div>
              <textarea
                value={resume}
                onChange={(e) => setResume(e.target.value)}
                placeholder="Paste your resume — or upload a PDF/Word file above.&#10;&#10;Work experience, education, skills, contact info..."
                rows={20}
                required
                className="w-full resize-none rounded-xl px-4 py-3 text-sm focus:outline-none"
                style={{ background: "var(--surface)", border: "1px solid var(--line)", color: "var(--fg)" }}
              />
              <p className="mt-2 font-mono text-xs" style={{ color: "var(--faint)" }}>{resume.length}/8000</p>
            </div>

            <div>
              <label className="mb-3 block font-mono text-xs uppercase tracking-wider" style={{ color: "var(--faint)" }}>Job description <span style={{ textTransform: "none", letterSpacing: 0 }}>(optional)</span></label>
              <textarea
                value={jobDescription}
                onChange={(e) => setJobDescription(e.target.value)}
                placeholder="Optional — paste a job posting to tailor the resume to it, or leave empty for a general improvement."
                rows={20}
                className="w-full resize-none rounded-xl px-4 py-3 text-sm focus:outline-none"
                style={{ background: "var(--surface)", border: "1px solid var(--line)", color: "var(--fg)" }}
              />
              <p className="mt-2 font-mono text-xs" style={{ color: "var(--faint)" }}>{jobDescription.length}/4000</p>
            </div>

            <div className="text-center md:col-span-2">
              {error && (
                <div className="mb-4 rounded-xl px-4 py-3 text-sm" style={{ background: "rgba(248,113,113,0.1)", border: "1px solid rgba(248,113,113,0.3)", color: "#f87171" }}>
                  {error}
                </div>
              )}
              <button
                type="submit"
                disabled={loading || !resume.trim()}
                className="btn-accent px-12 py-4 text-lg disabled:cursor-not-allowed disabled:opacity-40">
                {loading ? (
                  <span className="flex items-center justify-center gap-3">
                    <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-black/30 border-t-black" />
                    Scanning &amp; optimizing...
                  </span>
                ) : "⚡ Scan & optimize"}
              </button>
              <p className="mt-3 font-mono text-xs" style={{ color: "var(--faint)" }}>~30–60 seconds</p>
            </div>
          </form>
        ) : (
          <div>
            {/* Score banner */}
            <div className="card mb-8 p-8 text-center" style={{ borderColor: `${scoreColor}55`, background: `${scoreColor}0d` }}>
              <div className="font-mono text-xs uppercase tracking-[0.2em]" style={{ color: "var(--faint)" }}>ATS Match Score</div>
              <div className="my-2 flex items-baseline justify-center gap-1">
                <span className="font-mono text-7xl font-bold tabular-nums" style={{ color: scoreColor }}>{score}</span>
                <span className="font-mono text-2xl" style={{ color: "var(--faint)" }}>%</span>
              </div>
              <div className="mb-4 inline-block rounded-lg px-3 py-1 font-mono text-xs font-bold tracking-wider"
                style={{ background: `${scoreColor}1a`, color: scoreColor, border: `1px solid ${scoreColor}40` }}>
                {verdict}
              </div>
              <p className="mx-auto max-w-xl text-sm" style={{ color: "var(--muted)" }}>{result.matchSummary}</p>
              <a href={`/score/${score}`} target="_blank" rel="noopener noreferrer"
                className="mt-5 inline-block rounded-lg px-5 py-2 text-sm font-semibold"
                style={{ background: "rgba(74,222,128,0.12)", color: "var(--accent)", border: "1px solid rgba(74,222,128,0.3)" }}>
                📣 Share my score
              </a>
            </div>

            {/* Tabs */}
            <div className="mb-6 flex gap-2">
              {(["resume", "analysis"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className="rounded-lg px-5 py-2 text-sm font-semibold transition-all"
                  style={tab === t
                    ? { background: "var(--accent)", color: "#05130a" }
                    : { background: "var(--surface)", color: "var(--muted)", border: "1px solid var(--line)" }}>
                  {t === "resume" ? "Optimized resume" : "Full analysis"}
                </button>
              ))}
            </div>

            {tab === "resume" && (
              <div>
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-xl font-bold">Your optimized resume</h2>
                  <div className="flex gap-2">
                    <button
                      onClick={() => { navigator.clipboard.writeText(result.optimizedResume); setCopied(true); setTimeout(() => setCopied(false), 1800); }}
                      className="rounded-lg px-4 py-2 text-sm font-semibold"
                      style={{ background: "rgba(74,222,128,0.12)", color: "var(--accent)", border: "1px solid rgba(74,222,128,0.3)" }}>
                      {copied ? "✓ Copied" : "Copy"}
                    </button>
                    <button
                      onClick={() => download("optimized-resume.txt", result.optimizedResume)}
                      className="rounded-lg px-4 py-2 text-sm font-semibold"
                      style={{ background: "rgba(74,222,128,0.12)", color: "var(--accent)", border: "1px solid rgba(74,222,128,0.3)" }}>
                      ↓ .txt
                    </button>
                    <PdfExport text={result.optimizedResume} />
                  </div>
                </div>
                <div className="card whitespace-pre-wrap p-6 font-mono text-sm leading-relaxed"
                  style={{ color: "rgba(244,245,243,0.85)" }}>
                  {result.optimizedResume}
                </div>

                {/* Cover letter generator */}
                <div className="card mt-6 p-6" style={{ borderColor: "rgba(74,222,128,0.25)" }}>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h3 className="font-bold">Matching cover letter</h3>
                      <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>Generate a tailored cover letter from the same job post.</p>
                    </div>
                    {!coverLetter ? (
                      <button
                        onClick={generateCoverLetter}
                        disabled={coverLoading}
                        className="btn-accent px-5 py-2.5 text-sm disabled:opacity-50">
                        {coverLoading ? "Writing…" : "✨ Generate cover letter"}
                      </button>
                    ) : (
                      <div className="flex gap-2">
                        <button
                          onClick={() => { navigator.clipboard.writeText(coverLetter); setCoverCopied(true); setTimeout(() => setCoverCopied(false), 1800); }}
                          className="rounded-lg px-4 py-2 text-sm font-semibold"
                          style={{ background: "rgba(74,222,128,0.12)", color: "var(--accent)", border: "1px solid rgba(74,222,128,0.3)" }}>
                          {coverCopied ? "✓ Copied" : "Copy"}
                        </button>
                        <button
                          onClick={() => download("cover-letter.txt", coverLetter)}
                          className="rounded-lg px-4 py-2 text-sm font-semibold"
                          style={{ background: "var(--accent)", color: "#05130a" }}>
                          ↓ Download
                        </button>
                      </div>
                    )}
                  </div>
                  {coverLetter && (
                    <div className="card mt-4 whitespace-pre-wrap p-5 text-sm leading-relaxed"
                      style={{ background: "rgba(255,255,255,0.02)", color: "rgba(244,245,243,0.85)" }}>
                      {coverLetter}
                    </div>
                  )}
                </div>
              </div>
            )}

            {tab === "analysis" && (
              <div className="grid gap-6 md:grid-cols-2">
                <div className="card p-6" style={{ borderColor: "rgba(248,113,113,0.2)" }}>
                  <h3 className="mb-4 font-bold">Missing keywords ({result.missingKeywords.length})</h3>
                  <div className="flex flex-wrap gap-2">
                    {result.missingKeywords.map((k) => (
                      <span key={k} className="rounded-full px-3 py-1 text-xs font-medium" style={{ background: "rgba(248,113,113,0.14)", color: "#f87171" }}>{k}</span>
                    ))}
                  </div>
                </div>

                <div className="card p-6" style={{ borderColor: "rgba(74,222,128,0.2)" }}>
                  <h3 className="mb-4 font-bold">Present keywords ({result.presentKeywords.length})</h3>
                  <div className="flex flex-wrap gap-2">
                    {result.presentKeywords.map((k) => (
                      <span key={k} className="rounded-full px-3 py-1 text-xs font-medium" style={{ background: "rgba(74,222,128,0.14)", color: "var(--accent)" }}>{k}</span>
                    ))}
                  </div>
                </div>

                <div className="card p-6" style={{ borderColor: "rgba(251,191,36,0.2)" }}>
                  <h3 className="mb-4 font-bold">Skills to highlight ({result.skillsGap.length})</h3>
                  <ul className="space-y-2">
                    {result.skillsGap.map((s) => (
                      <li key={s} className="flex items-center gap-2 text-sm" style={{ color: "#fbbf24" }}><span>→</span> {s}</li>
                    ))}
                  </ul>
                </div>

                <div className="card p-6" style={{ borderColor: "rgba(74,222,128,0.15)" }}>
                  <h3 className="mb-4 font-bold">Improvements made</h3>
                  <ul className="space-y-4">
                    {result.improvements.map((imp) => (
                      <li key={imp.area}>
                        <div className="mb-1 font-mono text-xs font-bold text-accent">{imp.area}</div>
                        <div className="mb-1 text-xs" style={{ color: "var(--faint)" }}>{imp.issue}</div>
                        <div className="text-xs" style={{ color: "#86efac" }}>✓ {imp.fix}</div>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}

            {/* Bottom CTA */}
            <div className="card mt-10 p-8 text-center" style={{ borderColor: "rgba(74,222,128,0.4)", background: "rgba(74,222,128,0.05)" }}>
              <h3 className="text-2xl font-bold">Applying to more than one job?</h3>
              <p className="mx-auto mt-2 max-w-md text-sm" style={{ color: "var(--muted)" }}>Go unlimited for $19/mo — every application optimized, cover letters included.</p>
              <div className="mt-6 flex flex-wrap justify-center gap-4">
                <a href="/#pricing" className="btn-accent px-8 py-3">Go unlimited — $19/mo →</a>
                <button
                  onClick={() => { setResult(null); setResume(""); setJobDescription(""); }}
                  className="btn-ghost px-8 py-3 font-semibold" style={{ color: "var(--fg)" }}>
                  Optimize another
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
