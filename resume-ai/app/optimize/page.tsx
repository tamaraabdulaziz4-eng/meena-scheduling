"use client";
import { useState } from "react";
import Link from "next/link";

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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setResult(null);
    setLoading(true);

    try {
      const res = await fetch("/api/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resume, jobDescription }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setResult(data);
      setTab("resume");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  const scoreColor = result
    ? result.matchScore >= 80 ? "#22c55e"
    : result.matchScore >= 60 ? "#f59e0b"
    : "#ef4444"
    : "#6366f1";

  return (
    <main className="min-h-screen" style={{ background: "#0a0a0f", color: "#f0f0f5" }}>
      {/* Nav */}
      <nav className="flex items-center justify-between px-6 py-5 max-w-6xl mx-auto" style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
        <Link href="/" className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white font-bold text-sm"
            style={{ background: "linear-gradient(135deg, #6366f1, #8b5cf6)" }}>R</div>
          <span className="font-bold text-lg text-white">ResumeAI</span>
        </Link>
        <a href={process.env.NEXT_PUBLIC_PAYLINK_MONTHLY || "#"}
          className="text-white text-sm font-semibold px-5 py-2 rounded-lg"
          style={{ background: "linear-gradient(135deg, #6366f1, #8b5cf6)" }}>
          Unlock Unlimited →
        </a>
      </nav>

      <div className="max-w-6xl mx-auto px-6 py-10">
        <div className="text-center mb-10">
          <h1 className="text-4xl font-extrabold text-white mb-3">Resume Optimizer</h1>
          <p style={{ opacity: 0.5 }}>Paste your resume and the job description to get started</p>
        </div>

        {!result ? (
          <form onSubmit={handleSubmit} className="grid md:grid-cols-2 gap-6">
            <div>
              <label className="block text-sm font-semibold mb-3 text-white">Your Current Resume</label>
              <textarea
                value={resume}
                onChange={(e) => setResume(e.target.value)}
                placeholder="Paste your full resume here...&#10;&#10;Include: Work experience, education, skills, contact info..."
                rows={20}
                required
                className="w-full rounded-xl px-4 py-3 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500"
                style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "#f0f0f5" }}
              />
              <p className="text-xs mt-2" style={{ opacity: 0.4 }}>{resume.length}/8000 characters</p>
            </div>

            <div>
              <label className="block text-sm font-semibold mb-3 text-white">Job Description</label>
              <textarea
                value={jobDescription}
                onChange={(e) => setJobDescription(e.target.value)}
                placeholder="Paste the job posting here...&#10;&#10;Include: Job title, requirements, responsibilities, qualifications..."
                rows={20}
                required
                className="w-full rounded-xl px-4 py-3 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500"
                style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "#f0f0f5" }}
              />
              <p className="text-xs mt-2" style={{ opacity: 0.4 }}>{jobDescription.length}/4000 characters</p>
            </div>

            <div className="md:col-span-2 text-center">
              {error && (
                <div className="mb-4 px-4 py-3 rounded-xl text-sm" style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", color: "#f87171" }}>
                  {error}
                </div>
              )}
              <button
                type="submit"
                disabled={loading || !resume.trim() || !jobDescription.trim()}
                className="text-white font-bold px-12 py-4 rounded-xl text-lg disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                style={{ background: "linear-gradient(135deg, #6366f1, #8b5cf6)" }}>
                {loading ? (
                  <span className="flex items-center gap-3 justify-center">
                    <span className="inline-block w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    Analyzing & Optimizing...
                  </span>
                ) : "⚡ Optimize My Resume"}
              </button>
              <p className="mt-3 text-sm" style={{ opacity: 0.4 }}>Takes about 30-60 seconds</p>
            </div>
          </form>
        ) : (
          <div>
            {/* Score banner */}
            <div className="rounded-2xl p-8 mb-8 text-center" style={{ background: "rgba(99,102,241,0.08)", border: "1px solid rgba(99,102,241,0.3)" }}>
              <div className="text-sm font-bold tracking-widest mb-3" style={{ opacity: 0.5 }}>ATS MATCH SCORE</div>
              <div className="text-8xl font-extrabold mb-3" style={{ color: scoreColor }}>{result.matchScore}</div>
              <div className="text-sm mb-4" style={{ opacity: 0.5 }}>out of 100</div>
              <p className="text-sm max-w-xl mx-auto" style={{ opacity: 0.7 }}>{result.matchSummary}</p>
            </div>

            {/* Tabs */}
            <div className="flex gap-2 mb-6">
              {(["resume", "analysis"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className="px-5 py-2 rounded-lg text-sm font-semibold capitalize transition-all"
                  style={tab === t
                    ? { background: "linear-gradient(135deg, #6366f1, #8b5cf6)", color: "white" }
                    : { background: "rgba(255,255,255,0.05)", color: "rgba(255,255,255,0.6)", border: "1px solid rgba(255,255,255,0.1)" }}>
                  {t === "resume" ? "✨ Optimized Resume" : "📊 Full Analysis"}
                </button>
              ))}
            </div>

            {tab === "resume" && (
              <div>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-xl font-bold text-white">Your Optimized Resume</h2>
                  <button
                    onClick={() => navigator.clipboard.writeText(result.optimizedResume)}
                    className="text-sm px-4 py-2 rounded-lg font-semibold"
                    style={{ background: "rgba(99,102,241,0.15)", color: "#a5b4fc", border: "1px solid rgba(99,102,241,0.3)" }}>
                    📋 Copy to Clipboard
                  </button>
                </div>
                <div className="rounded-xl p-6 text-sm leading-relaxed whitespace-pre-wrap"
                  style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.1)", color: "#d4d4e0", fontFamily: "monospace" }}>
                  {result.optimizedResume}
                </div>
              </div>
            )}

            {tab === "analysis" && (
              <div className="grid md:grid-cols-2 gap-6">
                {/* Missing Keywords */}
                <div className="rounded-xl p-6" style={{ background: "rgba(239,68,68,0.05)", border: "1px solid rgba(239,68,68,0.2)" }}>
                  <h3 className="font-bold text-white mb-4">❌ Missing Keywords ({result.missingKeywords.length})</h3>
                  <div className="flex flex-wrap gap-2">
                    {result.missingKeywords.map((k) => (
                      <span key={k} className="px-3 py-1 rounded-full text-xs font-medium"
                        style={{ background: "rgba(239,68,68,0.15)", color: "#f87171" }}>{k}</span>
                    ))}
                  </div>
                </div>

                {/* Present Keywords */}
                <div className="rounded-xl p-6" style={{ background: "rgba(34,197,94,0.05)", border: "1px solid rgba(34,197,94,0.2)" }}>
                  <h3 className="font-bold text-white mb-4">✅ Present Keywords ({result.presentKeywords.length})</h3>
                  <div className="flex flex-wrap gap-2">
                    {result.presentKeywords.map((k) => (
                      <span key={k} className="px-3 py-1 rounded-full text-xs font-medium"
                        style={{ background: "rgba(34,197,94,0.15)", color: "#4ade80" }}>{k}</span>
                    ))}
                  </div>
                </div>

                {/* Skills Gap */}
                <div className="rounded-xl p-6" style={{ background: "rgba(245,158,11,0.05)", border: "1px solid rgba(245,158,11,0.2)" }}>
                  <h3 className="font-bold text-white mb-4">⚠️ Skills to Highlight ({result.skillsGap.length})</h3>
                  <ul className="space-y-2">
                    {result.skillsGap.map((s) => (
                      <li key={s} className="flex items-center gap-2 text-sm" style={{ color: "#fbbf24" }}>
                        <span>→</span> {s}
                      </li>
                    ))}
                  </ul>
                </div>

                {/* Improvements */}
                <div className="rounded-xl p-6" style={{ background: "rgba(99,102,241,0.05)", border: "1px solid rgba(99,102,241,0.2)" }}>
                  <h3 className="font-bold text-white mb-4">🔧 Improvements Made</h3>
                  <ul className="space-y-4">
                    {result.improvements.map((imp) => (
                      <li key={imp.area}>
                        <div className="text-xs font-bold mb-1" style={{ color: "#a5b4fc" }}>{imp.area}</div>
                        <div className="text-xs mb-1" style={{ opacity: 0.5 }}>{imp.issue}</div>
                        <div className="text-xs" style={{ color: "#86efac" }}>✓ {imp.fix}</div>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}

            {/* Bottom CTA */}
            <div className="mt-10 rounded-2xl p-8 text-center" style={{ background: "linear-gradient(135deg, rgba(99,102,241,0.15), rgba(139,92,246,0.15))", border: "1px solid rgba(99,102,241,0.3)" }}>
              <h3 className="text-2xl font-bold text-white mb-3">Want Unlimited Optimizations?</h3>
              <p className="text-sm mb-6" style={{ opacity: 0.6 }}>Optimize for every job you apply to. Cover letter generator included.</p>
              <div className="flex gap-4 justify-center flex-wrap">
                <a href={process.env.NEXT_PUBLIC_PAYLINK_MONTHLY || "#"}
                  className="text-white font-bold px-8 py-3 rounded-xl"
                  style={{ background: "linear-gradient(135deg, #6366f1, #8b5cf6)" }}>
                  Get Unlimited — $19/mo →
                </a>
                <button
                  onClick={() => { setResult(null); setResume(""); setJobDescription(""); }}
                  className="font-semibold px-8 py-3 rounded-xl"
                  style={{ border: "1px solid rgba(255,255,255,0.2)", color: "rgba(255,255,255,0.6)" }}>
                  Optimize Another
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
