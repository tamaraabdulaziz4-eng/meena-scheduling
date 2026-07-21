"use client";
import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import PdfExport from "../components/PdfExport";

interface Exp {
  role: string;
  company: string;
  dates: string;
  duties: string;
}

const inputStyle = { background: "var(--surface)", border: "1px solid var(--line)", color: "var(--fg)" };

export default function BuildPage() {
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

  function download(filename: string, text: string) {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
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
        throw new Error(data.error || "Failed");
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
            else if (msg.t === "error") throw new Error(msg.d);
          } catch (e) {
            if (e instanceof Error && e.message !== line) throw e;
          }
        }
      }
      if (!got) throw new Error("The build didn't complete. Please try again.");
      setCv(got.cv);
      setTips(got.tips);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  const steps = ["About you", "Experience", "Education & skills", "Target job"];
  const canNext =
    step === 0 ? name.trim().length > 1 && targetRole.trim().length > 1
    : step === 1 ? true
    : step === 2 ? education.trim().length > 0 || exps.some((e) => e.role.trim())
    : true;

  return (
    <main className="min-h-screen" style={{ background: "var(--bg)", color: "var(--fg)" }}>
      <nav className="sticky top-0 z-50 backdrop-blur" style={{ background: "rgba(8,9,10,0.7)", borderBottom: "1px solid var(--line)" }}>
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg font-mono text-sm font-bold" style={{ background: "var(--accent)", color: "#05130a" }}>R</div>
            <span className="text-[15px] font-bold tracking-tight">ResumeAI</span>
          </Link>
          <Link href="/optimize" className="text-sm" style={{ color: "var(--muted)" }}>Already have a CV? Optimize it →</Link>
        </div>
      </nav>

      <div className="mx-auto max-w-2xl px-6 py-12">
        {!cv && !loading && (
          <>
            <div className="mb-8 text-center">
              <div className="chip mb-4">● CV Builder</div>
              <h1 className="text-4xl font-extrabold tracking-tight">Build your CV from scratch</h1>
              <p className="mt-3" style={{ color: "var(--muted)" }}>
                Answer in plain words — the AI turns your answers into a professional, ATS-ready CV.
              </p>
            </div>

            {/* Step indicator */}
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
                    <label className="mb-2 block font-mono text-xs uppercase tracking-wider" style={{ color: "var(--faint)" }}>Your full name</label>
                    <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ahmed Ali" className="w-full rounded-lg px-4 py-2.5 text-sm focus:outline-none" style={inputStyle} />
                  </div>
                  <div>
                    <label className="mb-2 block font-mono text-xs uppercase tracking-wider" style={{ color: "var(--faint)" }}>Contact (email, phone, city, LinkedIn)</label>
                    <input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="ahmed@email.com · 05x xxx xxxx · Riyadh" className="w-full rounded-lg px-4 py-2.5 text-sm focus:outline-none" style={inputStyle} />
                  </div>
                  <div>
                    <label className="mb-2 block font-mono text-xs uppercase tracking-wider" style={{ color: "var(--faint)" }}>What job do you want?</label>
                    <input value={targetRole} onChange={(e) => setTargetRole(e.target.value)} placeholder="e.g. Sales Manager, Software Engineer, Accountant" className="w-full rounded-lg px-4 py-2.5 text-sm focus:outline-none" style={inputStyle} />
                  </div>
                </>
              )}

              {step === 1 && (
                <>
                  <p className="text-sm" style={{ color: "var(--muted)" }}>
                    Describe each job in your own words — what you did, anything you improved, how many people/customers/projects. Don&apos;t worry about wording; that&apos;s the AI&apos;s job. No experience yet? Just skip this step.
                  </p>
                  {exps.map((e, i) => (
                    <div key={i} className="space-y-3 rounded-xl p-4" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid var(--line)" }}>
                      <div className="grid gap-3 sm:grid-cols-3">
                        <input value={e.role} onChange={(ev) => setExp(i, "role", ev.target.value)} placeholder="Job title" className="rounded-lg px-3 py-2 text-sm focus:outline-none" style={inputStyle} />
                        <input value={e.company} onChange={(ev) => setExp(i, "company", ev.target.value)} placeholder="Company" className="rounded-lg px-3 py-2 text-sm focus:outline-none" style={inputStyle} />
                        <input value={e.dates} onChange={(ev) => setExp(i, "dates", ev.target.value)} placeholder="2021 – 2024" className="rounded-lg px-3 py-2 text-sm focus:outline-none" style={inputStyle} />
                      </div>
                      <textarea value={e.duties} onChange={(ev) => setExp(i, "duties", ev.target.value)} rows={3}
                        placeholder="What did you do? e.g. 'I handled customer complaints, trained 3 new staff, sales went up while I was there...'"
                        className="w-full resize-none rounded-lg px-3 py-2 text-sm focus:outline-none" style={inputStyle} />
                      {exps.length > 1 && (
                        <button onClick={() => setExps((p) => p.filter((_, j) => j !== i))} className="text-xs" style={{ color: "#f87171" }}>Remove</button>
                      )}
                    </div>
                  ))}
                  {exps.length < 8 && (
                    <button onClick={() => setExps((p) => [...p, { role: "", company: "", dates: "", duties: "" }])}
                      className="btn-ghost w-full py-2.5 text-sm font-semibold" style={{ color: "var(--fg)" }}>
                      + Add another job
                    </button>
                  )}
                </>
              )}

              {step === 2 && (
                <>
                  <div>
                    <label className="mb-2 block font-mono text-xs uppercase tracking-wider" style={{ color: "var(--faint)" }}>Education</label>
                    <textarea value={education} onChange={(e) => setEducation(e.target.value)} rows={2}
                      placeholder="e.g. BSc Computer Science, King Saud University, 2022" className="w-full resize-none rounded-lg px-4 py-2.5 text-sm focus:outline-none" style={inputStyle} />
                  </div>
                  <div>
                    <label className="mb-2 block font-mono text-xs uppercase tracking-wider" style={{ color: "var(--faint)" }}>Skills (just list them, any order)</label>
                    <textarea value={skills} onChange={(e) => setSkills(e.target.value)} rows={2}
                      placeholder="e.g. Excel, customer service, Python, teamwork, Arabic & English" className="w-full resize-none rounded-lg px-4 py-2.5 text-sm focus:outline-none" style={inputStyle} />
                  </div>
                  <div>
                    <label className="mb-2 block font-mono text-xs uppercase tracking-wider" style={{ color: "var(--faint)" }}>Certifications, languages, projects (optional)</label>
                    <textarea value={extras} onChange={(e) => setExtras(e.target.value)} rows={2}
                      placeholder="e.g. PMP certificate, IELTS 7.0, built a small online store" className="w-full resize-none rounded-lg px-4 py-2.5 text-sm focus:outline-none" style={inputStyle} />
                  </div>
                </>
              )}

              {step === 3 && (
                <>
                  <label className="mb-2 block font-mono text-xs uppercase tracking-wider" style={{ color: "var(--faint)" }}>Applying to a specific job? Paste the posting (optional but powerful)</label>
                  <textarea value={jobDescription} onChange={(e) => setJobDescription(e.target.value)} rows={7}
                    placeholder="Paste the job description here and the CV will be tailored to it — or leave empty for a general CV." className="w-full resize-none rounded-lg px-4 py-2.5 text-sm focus:outline-none" style={inputStyle} />
                </>
              )}

              {error && <div className="rounded-lg px-3 py-2 text-xs" style={{ background: "rgba(248,113,113,0.1)", color: "#f87171" }}>{error}</div>}

              <div className="flex justify-between pt-2">
                <button onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}
                  className="btn-ghost px-6 py-2.5 text-sm font-semibold disabled:opacity-30" style={{ color: "var(--fg)" }}>
                  ← Back
                </button>
                {step < 3 ? (
                  <button onClick={() => setStep((s) => s + 1)} disabled={!canNext} className="btn-accent px-6 py-2.5 text-sm disabled:opacity-40">
                    Next →
                  </button>
                ) : (
                  <button onClick={generate} className="btn-accent px-8 py-2.5 text-sm">✨ Build my CV</button>
                )}
              </div>
            </div>
          </>
        )}

        {loading && (
          <div className="card overflow-hidden" style={{ borderColor: "rgba(74,222,128,0.35)" }}>
            <div className="flex items-center gap-2 px-5 py-3" style={{ borderBottom: "1px solid var(--line)", background: "rgba(74,222,128,0.05)" }}>
              <span className="inline-block h-2 w-2 animate-pulse rounded-full" style={{ background: "var(--accent)", boxShadow: "0 0 8px var(--accent)" }} />
              <span className="font-mono text-xs uppercase tracking-[0.2em]" style={{ color: "var(--accent)" }}>AI writing your CV — live</span>
            </div>
            <div ref={thinkRef} className="max-h-72 min-h-24 overflow-y-auto whitespace-pre-wrap px-5 py-4 font-mono text-xs leading-relaxed" style={{ color: "rgba(244,245,243,0.75)" }}>
              {thinking.replace(/^ANALYSIS\s*/i, "") || "Reading your answers…"}
              <span className="animate-pulse text-accent">▌</span>
            </div>
          </div>
        )}

        {cv && !loading && (
          <div>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-2xl font-bold">Your CV is ready 🎉</h2>
              <div className="flex gap-2">
                <button onClick={() => { navigator.clipboard.writeText(cv); setCopied(true); setTimeout(() => setCopied(false), 1800); }}
                  className="rounded-lg px-4 py-2 text-sm font-semibold" style={{ background: "rgba(74,222,128,0.12)", color: "var(--accent)", border: "1px solid rgba(74,222,128,0.3)" }}>
                  {copied ? "✓ Copied" : "Copy"}
                </button>
                <button onClick={() => download("my-cv.txt", cv)} className="rounded-lg px-4 py-2 text-sm font-semibold" style={{ background: "rgba(74,222,128,0.12)", color: "var(--accent)", border: "1px solid rgba(74,222,128,0.3)" }}>
                  ↓ .txt
                </button>
                <PdfExport text={cv} />
              </div>
            </div>
            <div className="card whitespace-pre-wrap p-6 font-mono text-sm leading-relaxed" style={{ color: "rgba(244,245,243,0.85)" }}>{cv}</div>

            {tips.length > 0 && (
              <div className="card mt-6 p-6" style={{ borderColor: "rgba(251,191,36,0.25)" }}>
                <h3 className="mb-3 font-bold">Tips to make it even stronger</h3>
                <ul className="space-y-2">
                  {tips.map((t) => (
                    <li key={t} className="flex gap-2 text-sm" style={{ color: "var(--muted)" }}><span style={{ color: "#fbbf24" }}>→</span> {t}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="card mt-6 p-7 text-center" style={{ borderColor: "rgba(74,222,128,0.4)", background: "rgba(74,222,128,0.05)" }}>
              <h3 className="text-xl font-bold">Now make it beat the ATS robots</h3>
              <p className="mx-auto mt-2 max-w-md text-sm" style={{ color: "var(--muted)" }}>
                Run your new CV through the optimizer against a real job posting to get your match score.
              </p>
              <Link href="/optimize" className="btn-accent mt-5 inline-block px-8 py-3">Scan it now — free →</Link>
            </div>

            <button onClick={() => { setCv(""); setTips([]); setStep(0); }} className="mx-auto mt-6 block text-sm" style={{ color: "var(--faint)" }}>
              Start over
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
