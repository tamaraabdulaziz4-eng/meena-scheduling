"use client";
import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import PdfExport from "../components/PdfExport";
import DocxExport from "../components/DocxExport";
import BeforeAfter from "../components/BeforeAfter";
import AiOrb from "../components/AiOrb";
import OrbSceneSetter from "../components/orb/OrbSceneSetter";
import ResumeTemplate from "../components/ResumeTemplate";
import { TEMPLATE_CATALOG } from "../lib/templateCatalog";
import ScoreOrb from "../components/orb/ScoreOrb";
import ResultCoaching from "../components/ResultCoaching";
import GapFiller from "../components/GapFiller";
import CheckoutButton from "../components/CheckoutButton";
import AuthNav from "../components/AuthNav";
import { addScan, saveResume } from "../lib/localdata";
import { useBackToForm, useCountUp } from "../lib/resultUx";

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
  watermark?: boolean; // free result: full text, but downloads are watermarked
}

// Prepend/append a watermark to the plain-text (.txt) free download.
const WM = "cv.rabit.sa";
function wmTxt(text: string): string {
  const line = `— Created free with ${WM} —`;
  return `${line}\n\n${text}\n\n${line}`;
}

// Quick, local read of what we pulled out of an uploaded file so the user can
// confirm the extraction BEFORE analysis (bad OCR shouldn't be blamed on the AI).
function analyzeExtraction(text: string): { name: string; expCount: number; skillsCount: number; lang: "ar" | "en"; looksScanned: boolean } {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const name = lines[0]?.slice(0, 40) || "—";
  const arChars = (text.match(/[؀-ۿ]/g) || []).length;
  const lang = arChars > text.replace(/\s/g, "").length * 0.3 ? "ar" : "en";
  const expCount = (text.match(/\b(19|20)\d{2}\b|present|current|الآن|حالي/gi) || []).length;
  const skillsCount = text.split(/[,،\n•\-]/).filter((s) => s.trim().length > 1 && s.trim().length < 30).length;
  // Very little text out of a real file usually means a scanned image / bad parse.
  const looksScanned = text.replace(/\s/g, "").length < 120;
  return { name, expCount: Math.min(expCount, 20), skillsCount: Math.min(skillsCount, 40), lang, looksScanned };
}

// Use the candidate's name (first real line of the resume) as the saved title
// instead of a generic "Optimized — date". Falls back to a dated label.
function guessResumeTitle(resume: string): string {
  const first = resume.split("\n").map((l) => l.trim()).find((l) => l.length > 1) || "";
  const looksLikeName = first && first.length <= 40 && !/[@:|]|http|\d{3}/.test(first);
  return looksLikeName ? first : `Optimized — ${new Date().toLocaleDateString()}`;
}

// Try-before-you-share: a realistic sample so visitors can see a full result
// without uploading their own data (privacy critique #6).
const SAMPLE_RESUME = `Sarah Mitchell
sarah.mitchell@email.com · +1 555 0192 · Chicago, IL

Worked as a marketing coordinator at a retail company for 3 years. Managed social media accounts and email campaigns. Helped organize product launches. Before that, was a marketing intern for a year at a small agency doing content and reports.

Skills: social media, email marketing, Excel, Canva, some Google Analytics

Education: BA Communications, University of Illinois, 2020`;

const SAMPLE_JD = `Digital Marketing Specialist — E-commerce brand
We're looking for a data-driven marketer to own our email and social channels. Requirements: 2+ years in digital marketing, hands-on experience with email automation (Klaviyo/Mailchimp), paid social campaigns, Google Analytics, A/B testing, and reporting on conversion metrics. Strong copywriting skills. E-commerce experience preferred.`;

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
  const [extraction, setExtraction] = useState<ReturnType<typeof analyzeExtraction> | null>(null);
  const [emailTo, setEmailTo] = useState("");
  const [emailState, setEmailState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [emailMsg, setEmailMsg] = useState("");

  async function emailResults() {
    if (!result) return;
    setEmailState("sending"); setEmailMsg("");
    try {
      const res = await fetch("/api/email-results", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: emailTo, resume: result.optimizedResume, score: result.afterScore ?? result.matchScore }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setEmailState("sent");
    } catch (e) {
      setEmailState("error"); setEmailMsg(e instanceof Error ? e.message : "Failed to send.");
    }
  }
  const [coverLetter, setCoverLetter] = useState("");
  const [coverLoading, setCoverLoading] = useState(false);
  const [coverCopied, setCoverCopied] = useState(false);
  const [thinking, setThinking] = useState("");
  const [mode, setMode] = useState<"general" | "target">("general");
  const [step, setStep] = useState(1); // guided wizard: 1 resume · 2 job · 3 language+go
  const [outLang, setOutLang] = useState<"en" | "ar" | "both">("en");
  const [resumeView, setResumeView] = useState<"text" | "designed">("text");
  const [tplSlug, setTplSlug] = useState("ats-pro");
  const [jobUrl, setJobUrl] = useState("");
  const [fetchingJob, setFetchingJob] = useState(false);
  const [jobUrlMsg, setJobUrlMsg] = useState("");
  const thinkRef = useRef<HTMLDivElement>(null);

  async function importJobFromUrl() {
    if (!jobUrl.trim()) return;
    setFetchingJob(true); setJobUrlMsg("");
    try {
      const res = await fetch("/api/fetch-job", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: jobUrl.trim() }) });
      const data = await res.json();
      if (!res.ok || !data.text) throw new Error(data.error || "Couldn't read that link.");
      setJobDescription(data.text);
      setMode("target");
      setJobUrlMsg("Imported — review the text below, then scan.");
    } catch (e) {
      setJobUrlMsg(e instanceof Error ? e.message : "Couldn't fetch that link.");
    } finally {
      setFetchingJob(false);
    }
  }

  useEffect(() => {
    thinkRef.current?.scrollTo({ top: thinkRef.current.scrollHeight });
  }, [thinking]);

  // Back returns to the form (not off-site); score counts up on reveal.
  useBackToForm(!!result, () => setResult(null));
  const displayScore = useCountUp(result ? (result.matchScore ?? 0) : 0);

  // Leaving mid-generation kills the request — warn before an accidental exit.
  useEffect(() => {
    if (!loading) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [loading]);

  // Draft + result autosave: rehydrate on mount so a refresh / accidental
  // navigation never wipes what the user typed OR the result they just got.
  useEffect(() => {
    try {
      const saved = localStorage.getItem("ra_optimize_draft");
      if (saved) {
        const d = JSON.parse(saved);
        if (typeof d.resume === "string") setResume(d.resume);
        if (typeof d.jobDescription === "string") setJobDescription(d.jobDescription);
        // Persist the MODE too — a paid user's post-payment rescan must not
        // silently drop the job description because mode reset to "general".
        // Only restore target mode when the SAVED mode was target AND a JD is
        // present — leftover JD text alone must not force target mode on a
        // draft the user had explicitly set to general review.
        if (d.mode === "target" && typeof d.jobDescription === "string" && d.jobDescription.trim().length >= 30) {
          setMode("target");
        }
      }
      const savedResult = localStorage.getItem("ra_optimize_result");
      if (savedResult) setResult(JSON.parse(savedResult));
    } catch {
      /* ignore corrupt/unavailable storage */
    }
  }, []);

  useEffect(() => {
    try {
      if (resume || jobDescription) {
        localStorage.setItem("ra_optimize_draft", JSON.stringify({ resume, jobDescription, mode }));
      } else {
        // Both fields emptied — clear the saved draft so a refresh doesn't
        // resurrect stale text the user just deleted.
        localStorage.removeItem("ra_optimize_draft");
      }
    } catch {
      /* storage full or blocked — non-fatal */
    }
  }, [resume, jobDescription, mode]);

  useEffect(() => {
    try {
      if (result) localStorage.setItem("ra_optimize_result", JSON.stringify(result));
      else localStorage.removeItem("ra_optimize_result");
    } catch {
      /* non-fatal */
    }
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
      if (!res.ok) throw new Error(data.error || "Failed to read file");
      setResume(data.text);
      setUploadedName(file.name);
      setExtraction(analyzeExtraction(data.text));
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
        // 402 = pass expired mid-session → show the unlock CTA, not a dead button.
        if (res.status === 402 || data.paywall) {
          setCoverPaywalled(true);
          throw new Error("Your access has expired — unlock again to generate cover letters.");
        }
        // Don't echo the raw server string — use a clean, friendly message.
        throw new Error("Couldn't generate the cover letter — please try again.");
      }
      setCoverLetter(data.coverLetter);
    } catch (err) {
      setCoverError(err instanceof Error ? err.message : "Failed to generate the cover letter. Please try again.");
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
    // Target mode promises job-specific tailoring — a job post is required there.
    if (mode === "target" && jobDescription.trim().length < 30) {
      setError("Target-a-job mode needs the job posting — paste it, or switch to General review.");
      return;
    }
    setError("");
    setResult(null);
    setCoverLetter("");
    setThinking("");
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
    setLoading(true);

    // NOTE: no client-side retry here. The server already retries the model
    // internally, and each POST to /api/optimize consumes the free scan — a
    // client retry would burn the free scan and slam the user into the paywall
    // with no result. One request, one attempt.
    // Abort a stalled request so a network hang surfaces a friendly retry
    // instead of spinning forever (the "Failed to fetch" the CX test caught).
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    try {
      const res = await fetch("/api/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        // General review deliberately ignores the JD field — the mode label
        // promises that, so honor it.
        body: JSON.stringify({ resume: resumeText, jobDescription: mode === "target" ? jobDescription : "", outLang }),
      });

      // Non-streaming replies (validation errors, paywall) are plain JSON.
      const ctype = res.headers.get("content-type") || "";
      if (!ctype.includes("ndjson")) {
        const data = await res.json();
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
      // Record in device-local history (account page lists these).
      try {
        addScan({
          score: got.matchScore,
          mode,
          jobTitle: mode === "target" ? (jobDescription.split("\n")[0].slice(0, 80) || "Targeted scan") : "General review",
          lang: "en",
          result: got,
        });
        if (!got.locked && got.optimizedResume) {
          saveResume({ title: guessResumeTitle(got.optimizedResume), source: "optimized", text: got.optimizedResume });
        }
      } catch { /* noop */ }
    } catch (err) {
      // Network drop / abort / timeout throws a raw "Failed to fetch" — turn it
      // into plain language. The user's text is still in state, so Retry works.
      const raw = err instanceof Error ? err.message : "";
      const isNetwork = /failed to fetch|load failed|networkerror|aborted|the analysis didn't complete/i.test(raw) || raw === "";
      setError(isNetwork
        ? "Connection hiccup — your resume is still here. Tap Retry to run the scan again."
        : raw || "Something went wrong. Please try again.");
    } finally {
      clearTimeout(timer);
      setLoading(false);
    }
  }

  const score = result?.matchScore ?? 0;
  const scoreColor = score >= 75 ? "#a78bfa" : score >= 55 ? "#fbbf24" : "#f87171";
  // "MATCH" language only makes sense against a job. In general review (no JD)
  // there's nothing to match — use neutral quality-review wording instead.
  const verdict = mode === "target"
    ? (score >= 75 ? "STRONG MATCH" : score >= 55 ? "BORDERLINE" : "NEEDS WORK")
    : (score >= 75 ? "STRONG RESUME" : score >= 55 ? "SOLID START" : "NEEDS WORK");

  return (
    <main className="min-h-screen" style={{ background: "var(--bg)", color: "var(--fg)" }}>
      {/* Nav */}
      {/* the orb watches the wizard — it never leaves you mid-journey */}
      <OrbSceneSetter visible mood="idle" top="12vh" left="86%" size={110} />
      <nav className="sticky top-0 z-50" style={{ background: "linear-gradient(180deg, rgba(5,7,13,0.85), transparent)" }}>
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2.5">
            {/* the brand IS the orb — no colored box */}
            <AiOrb size={26} />
            <span className="text-[15px] font-bold tracking-tight">Sira</span>
          </Link>
          <div className="flex items-center gap-5">
            <Link href="/ar/optimize" className="rounded-lg px-3 py-2 text-sm font-semibold" style={{ color: "var(--accent)", border: "1px solid var(--line)" }}
              onClick={() => {
                // Carry the draft across the language switch — separate storage
                // keys otherwise make it look like the user's text vanished.
                try { localStorage.setItem("ra_ar_optimize_draft", JSON.stringify({ resume, jobDescription, mode })); localStorage.setItem("ra_lang", "ar"); } catch { /* noop */ }
              }}>
              عربي
            </Link>
            <AuthNav />
          </div>
        </div>
      </nav>

      <div className="mx-auto max-w-6xl px-6 py-12">
        {/* Loading is handled inside the wizard (step view) below. */}
        {!result ? (
          <div className="mx-auto max-w-2xl">
            {/* Progress — one clear step at a time (research: "one screen = one decision"). */}
            {!loading && (
              <div className="mb-8">
                <div className="mb-2 flex items-center justify-between">
                  <div className="font-mono text-xs" style={{ color: "var(--faint)" }}>Step {step} of 3</div>
                  {step > 1 && <button onClick={() => setStep(step - 1)} className="text-xs font-semibold" style={{ color: "var(--muted)" }}>← Back</button>}
                </div>
                <div className="flex gap-2">
                  {[1, 2, 3].map((s) => (
                    <div key={s} className="h-1.5 flex-1 rounded-full" style={{ background: s <= step ? "var(--accent)" : "var(--line)" }} />
                  ))}
                </div>
              </div>
            )}

            {loading ? (
              /* Analyzing — live steps instead of an empty spinner. */
              <div className="card mx-auto max-w-2xl overflow-hidden" style={{ borderColor: "rgba(139,92,246,0.35)" }}>
                <div className="flex items-center gap-2 px-5 py-3" style={{ borderBottom: "1px solid var(--line)", background: "rgba(139,92,246,0.05)" }}>
                  <AiOrb size={22} thinking />
                  <span className="font-mono text-xs uppercase tracking-[0.2em]" style={{ color: "var(--accent)" }}>Analyzing — live</span>
                </div>
                <div className="px-5 py-4 font-mono text-xs leading-relaxed" style={{ color: "rgba(244,245,243,0.75)" }}>
                  {thinking.replace(/^ANALYSIS\s*/i, "") || "Reading your resume…"}<span className="animate-pulse text-accent">▌</span>
                </div>
              </div>
            ) : step === 1 ? (
              /* ── Step 1: your resume ── */
              <div>
                <h1 className="text-3xl font-extrabold tracking-tight">Add your resume</h1>
                <p className="mt-2 mb-5 text-sm" style={{ color: "var(--muted)" }}>Upload a file or paste the text. We&apos;ll never change a word without your approval.</p>
                <div className="mb-3 flex flex-wrap gap-2">
                  <label className="cursor-pointer rounded-lg px-4 py-2 text-sm font-semibold"
                    style={{ background: "rgba(139,92,246,0.12)", color: "var(--accent)", border: "1px solid var(--line)" }}>
                    {uploading ? "Reading…" : uploadedName ? `${uploadedName.slice(0, 22)}` : "↑ Upload PDF / Word"}
                    <input type="file" accept=".pdf,.docx,.txt,.md" onChange={handleFile} className="hidden" disabled={uploading} />
                  </label>
                  {!resume && (
                    <button onClick={() => { setResume(SAMPLE_RESUME); setJobDescription(SAMPLE_JD); setMode("target"); }}
                      className="btn-ghost px-4 py-2 text-sm font-semibold" style={{ color: "var(--fg)" }}>Try a sample</button>
                  )}
                </div>
                <textarea value={resume} onChange={(e) => setResume(e.target.value)}
                  placeholder="Paste your resume here — work experience, education, skills, contact info…"
                  rows={12} maxLength={8000}
                  className="w-full resize-y rounded-xl px-4 py-3 text-sm focus:outline-none"
                  style={{ background: "var(--surface)", border: "1px solid var(--line)", color: "var(--fg)", minHeight: "11rem" }} />
                <p className="mt-2 font-mono text-xs" style={{ color: resume.length > 7500 ? "#fbbf24" : "var(--faint)" }}>{resume.length}/8000</p>
                {extraction && uploadedName && (
                  <div className="mt-3 rounded-xl p-4" style={{ background: "rgba(139,92,246,0.05)", border: "1px solid var(--line)" }}>
                    <div className="mb-2 text-sm font-bold" style={{ color: "var(--accent)" }}>Here&apos;s what we read — check it</div>
                    <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4" style={{ color: "var(--muted)" }}>
                      <div><span style={{ color: "var(--faint)" }}>Name</span><br /><strong>{extraction.name}</strong></div>
                      <div><span style={{ color: "var(--faint)" }}>Dated entries</span><br /><strong>{extraction.expCount}</strong></div>
                      <div><span style={{ color: "var(--faint)" }}>Skill items</span><br /><strong>{extraction.skillsCount}</strong></div>
                      <div><span style={{ color: "var(--faint)" }}>Language</span><br /><strong>{extraction.lang === "ar" ? "Arabic" : "English"}</strong></div>
                    </div>
                    {extraction.looksScanned && <div className="mt-2 text-xs font-semibold" style={{ color: "#fbbf24" }}>⚠️ Looks like a scanned image — some info may be missing. Paste the text for best results.</div>}
                  </div>
                )}
                <button disabled={resume.trim().length < 50} onClick={() => setStep(2)}
                  className="btn-accent mt-5 w-full py-3.5 text-base disabled:cursor-not-allowed disabled:opacity-40">Continue →</button>
                <p className="mt-3 text-center text-[11px]" style={{ color: "var(--faint)" }}>Processed instantly — never stored on our servers</p>
              </div>
            ) : step === 2 ? (
              /* ── Step 2: target job ── */
              <div>
                <h1 className="text-3xl font-extrabold tracking-tight">Target a job (optional)</h1>
                <p className="mt-2 mb-5 text-sm" style={{ color: "var(--muted)" }}>Add the posting and we tailor to it. Or skip for a general improvement.</p>
                <div className="mb-3 flex gap-2">
                  <input value={jobUrl} onChange={(e) => setJobUrl(e.target.value)} dir="ltr"
                    placeholder="Paste a job link (LinkedIn, Bayt…) to import"
                    className="min-w-0 flex-1 rounded-lg px-3 py-2 text-sm focus:outline-none"
                    style={{ background: "var(--surface)", border: "1px solid var(--line)", color: "var(--fg)" }} />
                  <button type="button" onClick={importJobFromUrl} disabled={fetchingJob || !jobUrl.trim()}
                    className="btn-ghost shrink-0 px-4 py-2 text-sm font-semibold disabled:opacity-50" style={{ color: "var(--accent)" }}>{fetchingJob ? "Fetching…" : "Import"}</button>
                </div>
                {jobUrlMsg && <p className="mb-2 text-xs" style={{ color: jobUrlMsg.startsWith("✓") ? "var(--accent)" : "#fbbf24" }}>{jobUrlMsg}</p>}
                <textarea value={jobDescription}
                  onChange={(e) => { const v = e.target.value; setJobDescription(v); if (v.trim().length >= 30) setMode("target"); else setMode("general"); }}
                  placeholder="…or paste the job description here."
                  rows={10} maxLength={4000}
                  className="w-full resize-y rounded-xl px-4 py-3 text-sm focus:outline-none"
                  style={{ background: "var(--surface)", border: "1px solid var(--line)", color: "var(--fg)", minHeight: "9rem" }} />
                <div className="mt-5 flex gap-2">
                  <button onClick={() => { setMode("general"); setStep(3); }} className="btn-ghost flex-1 py-3 text-sm font-semibold" style={{ color: "var(--fg)" }}>Skip</button>
                  <button onClick={() => setStep(3)} className="btn-accent flex-[2] py-3 text-base">Continue →</button>
                </div>
              </div>
            ) : (
              /* ── Step 3: language + analyze ── */
              <div>
                <h1 className="text-3xl font-extrabold tracking-tight">Resume language</h1>
                <p className="mt-2 mb-5 text-sm" style={{ color: "var(--muted)" }}>What language should the improved resume be in?</p>
                <div className="mb-6 grid grid-cols-3 gap-2">
                  {([{ id: "en", label: "English" }, { id: "ar", label: "العربية" }, { id: "both", label: "Both" }] as const).map((o) => (
                    <button key={o.id} onClick={() => setOutLang(o.id)}
                      className="rounded-xl py-3 text-sm font-semibold transition-all"
                      style={outLang === o.id ? { background: "var(--accent)", color: "#ffffff" } : { background: "var(--surface)", color: "var(--muted)", border: "1px solid var(--line)" }}>{o.label}</button>
                  ))}
                </div>
                {/* Template pick (optional) — choose the look upfront; changeable on the result too. */}
                <div className="mb-1 font-mono text-xs" style={{ color: "var(--faint)" }}>Template (optional)</div>
                <div className="mb-6 flex gap-2 overflow-x-auto pb-1">
                  {TEMPLATE_CATALOG.map((tp) => (
                    <button key={tp.slug} onClick={() => setTplSlug(tp.slug)}
                      className="shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold"
                      style={tplSlug === tp.slug ? { background: "var(--accent)", color: "#ffffff" } : { background: "var(--surface)", color: "var(--muted)", border: "1px solid var(--line)" }}>
                      {tp.name}{tp.best ? " ★" : ""}
                    </button>
                  ))}
                </div>
                <div className="mb-4 rounded-xl p-4 text-sm" style={{ background: "rgba(139,92,246,0.05)", border: "1px solid rgba(139,92,246,0.2)", color: "var(--muted)" }}>
                  <div className="mb-1 font-semibold" style={{ color: "var(--fg)" }}>{mode === "target" ? "Tailored to your job posting" : "General improvement"}</div>
                  Free: match score, missing keywords, skills gap, preview. <span style={{ color: "var(--accent)" }}>Full rewrite unlocks after.</span>
                </div>
                {error && (
                  <div className="mb-4 rounded-xl px-4 py-3 text-sm" style={{ background: "rgba(248,113,113,0.1)", border: "1px solid rgba(248,113,113,0.3)", color: "#f87171" }}>
                    <div>{error}</div>
                    {resume.trim() && <button type="button" onClick={() => runScan()} className="mt-2 inline-block rounded-lg px-4 py-1.5 text-xs font-semibold" style={{ background: "rgba(139,92,246,0.15)", color: "var(--accent)", border: "1px solid rgba(139,92,246,0.4)" }}>↻ Retry</button>}
                  </div>
                )}
                <button onClick={() => runScan()} disabled={resume.trim().length < 50}
                  className="btn-accent w-full py-4 text-lg disabled:opacity-40">⚡ Analyze my resume — free</button>
                <p className="mt-3 text-center font-mono text-xs" style={{ color: "var(--faint)" }}>~10 seconds ⚡</p>
              </div>
            )}
          </div>
        ) : (
          <div>
            {/* Score banner */}
            <div className="card mb-8 p-8 text-center" style={{ borderColor: `${scoreColor}55`, background: `${scoreColor}0d` }}>
              <div className="font-mono text-xs uppercase tracking-[0.2em]" style={{ color: "var(--faint)" }}>
                {mode === "target" ? "Job-match score" : "Overall resume score"}
              </div>
              <div className="mb-1 text-xs" style={{ color: "var(--faint)" }}>
                {mode === "target" ? "How closely your resume matches this posting — not a guarantee any ATS will pass it" : "General quality review (no specific job) — switch to “Target a job” to match a posting"}
              </div>
              <div className="my-3 flex justify-center">
                <ScoreOrb value={displayScore} color={scoreColor} animate={false} size={150} />
              </div>
              <div className="mb-4 inline-block rounded-lg px-3 py-1 font-mono text-xs font-bold tracking-wider"
                style={{ background: `${scoreColor}1a`, color: scoreColor, border: `1px solid ${scoreColor}40` }}>
                {verdict}
              </div>
              <p className="mx-auto max-w-xl text-sm" style={{ color: "var(--muted)" }}>{result.matchSummary}</p>
              {/* Sub-metric breakdown — makes the single number legible, like
                  the competitor's keyword/skill/readability split. */}
              {(() => {
                const present = result.presentKeywords?.length ?? 0;
                const missing = result.missingKeywords?.length ?? 0;
                const kwCov = present + missing > 0 ? Math.round((present / (present + missing)) * 100) : null;
                const metrics = [
                  { label: "Keyword coverage", val: kwCov === null ? "—" : `${kwCov}%`, hint: `${present} present · ${missing} missing` },
                  { label: "Skills gaps", val: String(result.skillsGap?.length ?? 0), hint: "to address" },
                  { label: "Fixes found", val: String(result.improvements?.length ?? 0), hint: "actionable" },
                ];
                return (
                  <div className="mx-auto mt-5 grid max-w-lg grid-cols-3 gap-2">
                    {metrics.map((m) => (
                      <div key={m.label} className="card px-2 py-3">
                        <div className="font-mono text-2xl font-bold tabular-nums" style={{ color: "var(--fg)" }}>{m.val}</div>
                        <div className="mt-0.5 text-[11px] font-semibold" style={{ color: "var(--muted)" }}>{m.label}</div>
                        <div className="font-mono text-[10px]" style={{ color: "var(--faint)" }}>{m.hint}</div>
                      </div>
                    ))}
                  </div>
                );
              })()}
              <a href={`/score/${score}`} target="_blank" rel="noopener noreferrer"
                className="mt-5 inline-block rounded-lg px-5 py-2 text-sm font-semibold"
                style={{ background: "rgba(139,92,246,0.12)", color: "var(--accent)", border: "1px solid var(--line)" }}>
                📣 Share my score
              </a>
            </div>

            {/* Before/after proof — the value shown before the paywall */}
            {typeof result.afterScore === "number" && (
              <BeforeAfter before={score} after={result.afterScore} />
            )}

            {/* Improved-reveal + active coaching: teach the user what to add. */}
            <ResultCoaching
              before={score}
              after={result.afterScore ?? score}
              improvements={result.improvements || []}
              missingKeywords={result.missingKeywords || []}
              skillsGap={result.skillsGap || []}
              hasPlaceholders={/\[add [^\]]*\]/i.test(result.optimizedResume || "")}
            />

            {/* Interactive: ask the user for what's missing, then re-optimize. */}
            <GapFiller
              missingKeywords={result.missingKeywords || []}
              skillsGap={result.skillsGap || []}
              busy={loading}
              onApply={(additions) => { const enriched = resume + additions; setResume(enriched); runScan(enriched); }}
            />

            {/* Tabs + a visible way OUT of a stale result (it rehydrates on
                every visit — without this, returning users are stuck on it) */}
            <div className="mb-6 flex flex-wrap items-center justify-between gap-2">
              <div className="flex gap-2">
                {(["resume", "analysis"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className="rounded-lg px-5 py-2 text-sm font-semibold transition-all"
                    style={tab === t
                      ? { background: "var(--accent)", color: "#ffffff" }
                      : { background: "var(--surface)", color: "var(--muted)", border: "1px solid var(--line)" }}>
                    {t === "resume" ? "Optimized resume" : "Full analysis"}
                  </button>
                ))}
              </div>
              <button
                onClick={() => { setResult(null); setCoverLetter(""); setCoverError(""); }}
                className="btn-ghost px-4 py-2 text-sm font-semibold" style={{ color: "var(--fg)" }}>
                ← New scan
              </button>
            </div>

            {tab === "resume" && (
              <div>
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-xl font-bold">Your optimized resume</h2>
                  {!result.locked && (
                    <div className="flex gap-2">
                      <button
                        onClick={() => { navigator.clipboard.writeText(result.optimizedResume); setCopied(true); setTimeout(() => setCopied(false), 1800); }}
                        className="rounded-lg px-4 py-2 text-sm font-semibold"
                        style={{ background: "rgba(139,92,246,0.12)", color: "var(--accent)", border: "1px solid var(--line)" }}>
                        {copied ? "Copied" : "Copy"}
                      </button>
                      <button
                        onClick={() => download("optimized-resume.txt", result.watermark ? wmTxt(result.optimizedResume) : result.optimizedResume)}
                        className="rounded-lg px-4 py-2 text-sm font-semibold"
                        style={{ background: "rgba(139,92,246,0.12)", color: "var(--accent)", border: "1px solid var(--line)" }}>
                        ↓ .txt
                      </button>
                      <PdfExport text={result.optimizedResume} watermark={result.watermark} />
                      <DocxExport text={result.optimizedResume} watermark={result.watermark} />
                    </div>
                  )}
                </div>
                {/* Email my results — delivery + opt-in capture. */}
                {!result.locked && (
                  emailState === "sent" ? (
                    <div className="mb-4 rounded-xl px-4 py-3 text-sm font-semibold" style={{ background: "rgba(139,92,246,0.1)", border: "1px solid rgba(139,92,246,0.35)", color: "var(--accent)" }}>Sent — check your inbox.</div>
                  ) : (
                    <div className="mb-4 flex flex-wrap gap-2">
                      <input type="email" value={emailTo} onChange={(e) => setEmailTo(e.target.value)} dir="ltr" placeholder="you@email.com"
                        className="min-w-0 flex-1 rounded-lg px-3 py-2 text-sm focus:outline-none" style={{ background: "var(--surface)", border: "1px solid var(--line)", color: "var(--fg)" }} />
                      <button type="button" onClick={emailResults} disabled={emailState === "sending" || !emailTo.trim()}
                        className="btn-ghost shrink-0 px-4 py-2 text-sm font-semibold disabled:opacity-50" style={{ color: "var(--accent)" }}>
                        {emailState === "sending" ? "Sending…" : "✉ Email my results"}
                      </button>
                      {emailState === "error" && <p className="w-full text-xs" style={{ color: "#f87171" }}>{emailMsg}</p>}
                    </div>
                  )
                )}
                {/* Text (ATS-safe) vs a designed template — the market "buys
                    with the eye", so show the optimized resume both ways. */}
                {!result.locked && (
                  <div className="mb-3 flex gap-2">
                    {(["text", "designed"] as const).map((v) => (
                      <button key={v} onClick={() => setResumeView(v)}
                        className="rounded-lg px-4 py-2 text-sm font-semibold"
                        style={resumeView === v ? { background: "var(--accent)", color: "#ffffff" } : { background: "var(--surface)", color: "var(--muted)", border: "1px solid var(--line)" }}>
                        {v === "text" ? "Text (ATS)" : "Designed template"}
                      </button>
                    ))}
                  </div>
                )}
                {!result.locked && resumeView === "designed" ? (
                  <div>
                    {/* Template picker — choose from the full catalogue, not one. */}
                    <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
                      {TEMPLATE_CATALOG.map((tp) => (
                        <button key={tp.slug} onClick={() => setTplSlug(tp.slug)}
                          className="shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold"
                          style={tplSlug === tp.slug
                            ? { background: "var(--accent)", color: "#ffffff" }
                            : { background: "var(--surface)", color: "var(--muted)", border: "1px solid var(--line)" }}>
                          {tp.name}{tp.best ? " ★" : ""}
                        </button>
                      ))}
                    </div>
                    {(() => {
                      const tp = TEMPLATE_CATALOG.find((x) => x.slug === tplSlug) || TEMPLATE_CATALOG[0];
                      return <ResumeTemplate text={result.optimizedResume} name="optimized-resume" variant={tp.variant} accent={tp.accent} fitWidth />;
                    })()}
                  </div>
                ) : (
                  <div className="card whitespace-pre-wrap p-6 font-mono text-sm leading-relaxed"
                    style={{ color: "rgba(244,245,243,0.85)" }}>
                    {result.optimizedResume}
                  </div>
                )}
                {result.watermark && (
                  <div className="card mt-4 p-8 text-center" style={{ borderColor: "rgba(139,92,246,0.4)", background: "rgba(139,92,246,0.05)" }}>
                    <div className="chip mb-3">Your resume is ready — free</div>
                    <h3 className="text-xl font-bold">
                      {typeof result.afterScore === "number"
                        ? `Download a clean copy — turn your ${score} into a projected ${result.afterScore}.`
                        : "Download a clean, watermark-free version"}
                    </h3>
                    <p className="mx-auto mt-2 max-w-md text-sm" style={{ color: "var(--muted)" }}>
                      Your free PDF/Word download carries a small “cv.rabit.sa” mark. Remove it — and unlock cover letters, LinkedIn &amp; interview prep — for a one-time SAR 35, or the SAR 99 Complete Pack. No subscription.
                    </p>
                    <div className="mx-auto mt-5 max-w-xs space-y-3">
                      <CheckoutButton plan="single" label="Remove watermark — SAR 35" variant="accent" />
                      <CheckoutButton plan="complete" label="Complete Pack (SAR 99)" variant="ghost" />
                    </div>
                    <p className="mt-4 text-xs" style={{ color: "var(--faint)" }}>
                      <a href="/terms" className="underline underline-offset-2">7-day money-back guarantee</a>
                    </p>
                  </div>
                )}

                {/* Cover letter generator */}
                <div className="card mt-6 p-6" style={{ borderColor: "rgba(139,92,246,0.25)" }}>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h3 className="font-bold">Matching cover letter</h3>
                      <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
                        {result.watermark
                          ? "Part of the Complete Pack — unlock to generate a tailored cover letter from this job."
                          : jobDescription.trim().length < 30
                            ? "Click ‘← New scan’, add the job posting, then re-scan to generate a matching cover letter."
                            : "Generate a tailored cover letter from the same job post."}
                      </p>
                    </div>
                    {result.watermark ? (
                      <a href="/#pricing" className="btn-accent px-5 py-2.5 text-sm">Unlock to generate</a>
                    ) : !coverLetter ? (
                      <button
                        onClick={generateCoverLetter}
                        disabled={coverLoading || jobDescription.trim().length < 30}
                        className="btn-accent px-5 py-2.5 text-sm disabled:opacity-50">
                        {coverLoading ? "Writing…" : "Generate cover letter"}
                      </button>
                    ) : (
                      <div className="flex gap-2">
                        <button
                          onClick={() => { navigator.clipboard.writeText(coverLetter); setCoverCopied(true); setTimeout(() => setCoverCopied(false), 1800); }}
                          className="rounded-lg px-4 py-2 text-sm font-semibold"
                          style={{ background: "rgba(139,92,246,0.12)", color: "var(--accent)", border: "1px solid var(--line)" }}>
                          {coverCopied ? "Copied" : "Copy"}
                        </button>
                        <button
                          onClick={() => download("cover-letter.txt", coverLetter)}
                          className="rounded-lg px-4 py-2 text-sm font-semibold"
                          style={{ background: "var(--accent)", color: "#ffffff" }}>
                          ↓ Download
                        </button>
                      </div>
                    )}
                  </div>
                  {coverError && (
                    <div className="mt-3 rounded-lg px-4 py-3 text-sm" style={{ background: "rgba(248,113,113,0.1)", border: "1px solid rgba(248,113,113,0.3)", color: "#f87171" }}>
                      {coverError}
                      {coverPaywalled && (
                        <a href="/#pricing" className="ml-2 font-semibold underline" style={{ color: "var(--accent)" }}>See plans →</a>
                      )}
                    </div>
                  )}
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
              <div>
              <div className="mb-4 flex justify-end">
                <button
                  onClick={() => {
                    const txt = `ATS MATCH SCORE: ${result.matchScore}/100\n${result.matchSummary}\n\n` +
                      `MISSING KEYWORDS:\n${result.missingKeywords.join(", ")}\n\n` +
                      `PRESENT KEYWORDS:\n${result.presentKeywords.join(", ")}\n\n` +
                      `SKILLS TO HIGHLIGHT:\n${result.skillsGap.join(", ")}\n\n` +
                      `IMPROVEMENTS:\n${result.improvements.map((i) => `• ${i.area}: ${i.issue} → ${i.fix}`).join("\n")}`;
                    navigator.clipboard.writeText(txt); setCopied(true); setTimeout(() => setCopied(false), 1800);
                  }}
                  className="rounded-lg px-4 py-2 text-sm font-semibold"
                  style={{ background: "rgba(139,92,246,0.12)", color: "var(--accent)", border: "1px solid var(--line)" }}>
                  {copied ? "Copied" : "Copy analysis"}
                </button>
              </div>
              <div className="grid gap-6 md:grid-cols-2">
                <div className="card p-6" style={{ borderColor: "rgba(248,113,113,0.2)" }}>
                  <h3 className="mb-4 font-bold">Missing keywords ({result.missingKeywords.length})</h3>
                  <div className="flex flex-wrap gap-2">
                    {result.missingKeywords.map((k) => (
                      <span key={k} className="rounded-full px-3 py-1 text-xs font-medium" style={{ background: "rgba(248,113,113,0.14)", color: "#f87171" }}>{k}</span>
                    ))}
                  </div>
                </div>

                <div className="card p-6" style={{ borderColor: "rgba(139,92,246,0.2)" }}>
                  <h3 className="mb-4 font-bold">Present keywords ({result.presentKeywords.length})</h3>
                  <div className="flex flex-wrap gap-2">
                    {result.presentKeywords.map((k) => (
                      <span key={k} className="rounded-full px-3 py-1 text-xs font-medium" style={{ background: "rgba(139,92,246,0.14)", color: "var(--accent)" }}>{k}</span>
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

                <div className="card p-6" style={{ borderColor: "rgba(139,92,246,0.15)" }}>
                  <h3 className="mb-4 font-bold">Improvements made</h3>
                  <ul className="space-y-4">
                    {result.improvements.map((imp) => {
                      // The trust differentiator: every edit is labelled with its
                      // honesty class so nothing feels invented behind your back.
                      const B: Record<string, { t: string; c: string; bg: string }> = {
                        "rephrase": { t: "Rephrased only", c: "#93c5fd", bg: "rgba(147,197,253,0.12)" },
                        "from-your-data": { t: "From your data", c: "#86efac", bg: "rgba(134,239,172,0.12)" },
                        "needs-confirmation": { t: "⚠ Confirm this is true", c: "#fbbf24", bg: "rgba(251,191,36,0.12)" },
                        "missing-requirement": { t: "Missing — you must add", c: "#f87171", bg: "rgba(248,113,113,0.12)" },
                      };
                      const b = B[imp.source || "rephrase"] || B.rephrase;
                      return (
                        <li key={imp.area}>
                          <div className="mb-1 flex flex-wrap items-center gap-2">
                            <span className="font-mono text-xs font-bold text-accent">{imp.area}</span>
                            <span className="rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ color: b.c, background: b.bg, border: `1px solid ${b.c}40` }}>{b.t}</span>
                          </div>
                          <div className="mb-1 text-xs" style={{ color: "var(--faint)" }}>{imp.issue}</div>
                          <div className="text-xs" style={{ color: "#86efac" }}>{imp.fix}</div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </div>
              </div>
            )}

            {/* Bottom CTA */}
            <div className="card mt-10 p-8 text-center" style={{ borderColor: "rgba(139,92,246,0.4)", background: "rgba(139,92,246,0.05)" }}>
              <h3 className="text-2xl font-bold">Applying to more than one job?</h3>
              <p className="mx-auto mt-2 max-w-md text-sm" style={{ color: "var(--muted)" }}>Get the Complete Pack — SAR 99 once, no subscription: cover letters, LinkedIn, and interview prep included.</p>
              <div className="mt-6 flex flex-wrap justify-center gap-4">
                <a href="/#pricing" className="btn-accent px-8 py-3">Get the Complete Pack — SAR 99 →</a>
                <button
                  onClick={() => {
                    setResult(null); setResume(""); setJobDescription(""); setCoverLetter("");
                    setCoverError(""); setUploadedName(""); setMode("general");
                    try { localStorage.removeItem("ra_optimize_draft"); } catch { /* noop */ }
                  }}
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
