"use client";

import { useEffect, useState, Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  getScans, removeScan, type ScanEntry,
  getResumes, removeResume, type SavedResume,
  getJobs, addJob, updateJob, removeJob, type JobEntry, type JobStatus,
} from "../lib/localdata";

interface Me {
  signedIn: boolean;
  email?: string;
  unlimited?: boolean;
  until?: number;
}

const STATUS_LABELS: Record<JobStatus, string> = {
  saved: "Saved",
  applied: "Applied",
  interview: "Interview",
  offer: "Offer 🎉",
  rejected: "Rejected",
};
const STATUS_COLORS: Record<JobStatus, string> = {
  saved: "var(--faint)",
  applied: "#60a5fa",
  interview: "#fbbf24",
  offer: "#4ade80",
  rejected: "#f87171",
};

function AccountInner() {
  const router = useRouter();
  // Capture the welcome flag once into state — router.replace below strips the
  // param, which flips the reactive searchParams value back to false and would
  // otherwise make the banner flash and immediately vanish.
  const [welcome] = useState(useSearchParams().get("welcome") === "1");
  useEffect(() => {
    if (welcome) router.replace("/account", { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [signingOut, setSigningOut] = useState(false);
  const [links, setLinks] = useState<{ slug: string; url: string; token: string }[]>([]);
  const [scans, setScans] = useState<ScanEntry[]>([]);
  const [resumes, setResumes] = useState<SavedResume[]>([]);
  const [jobs, setJobs] = useState<JobEntry[]>([]);
  const [showJobForm, setShowJobForm] = useState(false);
  const [jc, setJc] = useState(""); // company
  const [jt, setJt] = useState(""); // title
  const [ju, setJu] = useState(""); // url

  useEffect(() => {
    fetch("/api/auth/me").then((r) => r.json()).then(setMe).catch(() => setMe({ signedIn: false })).finally(() => setLoading(false));
    try {
      const raw = localStorage.getItem("ra_published");
      if (raw) setLinks(JSON.parse(raw));
    } catch { /* noop */ }
    setScans(getScans());
    setResumes(getResumes());
    setJobs(getJobs());
  }, []);

  async function signOut() {
    setSigningOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      router.push("/");
      router.refresh();
    } finally {
      setSigningOut(false);
    }
  }

  async function removeLink(slug: string, token: string) {
    try {
      await fetch(`/api/publish?slug=${encodeURIComponent(slug)}&token=${encodeURIComponent(token)}`, { method: "DELETE" });
    } catch { /* best-effort */ }
    const next = links.filter((l) => l.slug !== slug);
    setLinks(next);
    try { localStorage.setItem("ra_published", JSON.stringify(next)); } catch { /* noop */ }
  }

  function openScan(s: ScanEntry) {
    // Restore the result into the right optimizer and navigate to it.
    try {
      localStorage.setItem(s.lang === "ar" ? "ra_ar_optimize_result" : "ra_optimize_result", JSON.stringify(s.result));
    } catch { /* noop */ }
    router.push(s.lang === "ar" ? "/ar/optimize" : "/optimize");
  }

  function loadResume(r: SavedResume) {
    try {
      localStorage.setItem("ra_optimize_draft", JSON.stringify({ resume: r.text, jobDescription: "", mode: "general" }));
      localStorage.removeItem("ra_optimize_result");
    } catch { /* noop */ }
    router.push("/optimize");
  }

  function downloadText(filename: string, text: string) {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function submitJob(e: React.FormEvent) {
    e.preventDefault();
    if (!jc.trim() && !jt.trim()) return;
    addJob({ company: jc.trim(), title: jt.trim(), url: ju.trim(), status: "saved", note: "" });
    setJobs(getJobs());
    setJc(""); setJt(""); setJu("");
    setShowJobForm(false);
  }

  const until = me?.until && me.until > Date.now() ? new Date(me.until) : null;

  const sectionCard = "card p-6";
  const sectionTitle = "mb-4 text-sm font-bold";

  return (
    <main className="min-h-screen" style={{ background: "var(--bg)", color: "var(--fg)" }}>
      <nav className="sticky top-0 z-50 backdrop-blur" style={{ background: "rgba(8,9,10,0.7)", borderBottom: "1px solid var(--line)" }}>
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg font-mono text-sm font-bold" style={{ background: "var(--accent)", color: "#05130a" }}>R</div>
            <span className="text-[15px] font-bold tracking-tight">ResumeAI</span>
          </Link>
          <Link href="/optimize" className="text-sm" style={{ color: "var(--muted)" }}>Optimize a resume →</Link>
        </div>
      </nav>

      <div className="mx-auto max-w-2xl px-6 py-14">
        {welcome && (
          <div className="mb-6 rounded-xl px-4 py-3 text-sm font-semibold"
            style={{ background: "rgba(74,222,128,0.1)", border: "1px solid rgba(74,222,128,0.35)", color: "var(--accent)" }}>
            ✓ You&apos;re signed in — welcome back!
          </div>
        )}
        <div className="chip mb-4">● My account</div>
        <h1 className="mb-8 text-3xl font-extrabold">Your dashboard</h1>

        {/* ── Plan card ── */}
        <div className={sectionCard}>
          {loading ? (
            <p className="text-sm" style={{ color: "var(--muted)" }}>Loading…</p>
          ) : me?.signedIn ? (
            <>
              <dl className="space-y-3">
                <div className="flex items-center justify-between">
                  <dt className="text-sm" style={{ color: "var(--faint)" }}>Email</dt>
                  <dd className="text-sm font-medium" dir="ltr">{me.email}</dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-sm" style={{ color: "var(--faint)" }}>Plan</dt>
                  <dd className="text-sm font-medium" style={{ color: me.unlimited ? "var(--accent)" : "var(--muted)" }}>
                    {me.unlimited ? "Unlimited — active" : "Free"}
                  </dd>
                </div>
                {until && (
                  <div className="flex items-center justify-between">
                    <dt className="text-sm" style={{ color: "var(--faint)" }}>Access until</dt>
                    <dd className="text-sm font-medium">{until.toLocaleDateString()} {until.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</dd>
                  </div>
                )}
              </dl>
              {!me.unlimited && (
                <Link href="/#pricing" className="btn-accent mt-5 block w-full py-3 text-center">Unlock unlimited →</Link>
              )}
              <button onClick={signOut} disabled={signingOut}
                className="btn-ghost mt-3 block w-full py-2.5 text-center text-sm font-semibold disabled:opacity-50" style={{ color: "var(--fg)" }}>
                {signingOut ? "Signing out…" : "Sign out"}
              </button>
            </>
          ) : (
            <div className="text-center">
              <p className="text-sm" style={{ color: "var(--muted)" }}>
                You&apos;re not signed in. Your history below lives on this device — sign in to link your paid access.
              </p>
              <Link href="/login" className="btn-accent mt-4 inline-block px-8 py-2.5">Sign in →</Link>
            </div>
          )}
        </div>

        {/* ── Job application tracker ── */}
        <div className={`${sectionCard} mt-6`}>
          <div className="flex items-center justify-between">
            <h2 className={sectionTitle} style={{ marginBottom: 0 }}>📋 Job applications ({jobs.length})</h2>
            <button onClick={() => setShowJobForm((v) => !v)} className="btn-ghost px-3 py-1.5 text-xs font-semibold" style={{ color: "var(--accent)" }}>
              {showJobForm ? "Close" : "+ Add job"}
            </button>
          </div>
          {showJobForm && (
            <form onSubmit={submitJob} className="mt-4 space-y-2">
              <div className="grid gap-2 sm:grid-cols-2">
                <input value={jc} onChange={(e) => setJc(e.target.value)} placeholder="Company"
                  className="rounded-lg px-3 py-2 text-sm focus:outline-none" style={{ background: "var(--bg)", border: "1px solid var(--line)", color: "var(--fg)" }} />
                <input value={jt} onChange={(e) => setJt(e.target.value)} placeholder="Job title"
                  className="rounded-lg px-3 py-2 text-sm focus:outline-none" style={{ background: "var(--bg)", border: "1px solid var(--line)", color: "var(--fg)" }} />
              </div>
              <input value={ju} onChange={(e) => setJu(e.target.value)} placeholder="Job link (optional)" dir="ltr"
                className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none" style={{ background: "var(--bg)", border: "1px solid var(--line)", color: "var(--fg)" }} />
              <button type="submit" className="btn-accent w-full py-2 text-sm">Add</button>
            </form>
          )}
          {jobs.length === 0 && !showJobForm ? (
            <p className="mt-3 text-xs" style={{ color: "var(--faint)" }}>
              Track every application: company, role, and status (saved → applied → interview → offer). Stays on this device.
            </p>
          ) : (
            <ul className="mt-4 space-y-2">
              {jobs.map((j) => (
                <li key={j.id} className="flex flex-wrap items-center gap-2 rounded-lg px-3 py-2.5 text-sm" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid var(--line)" }}>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold">{j.title || "—"} <span style={{ color: "var(--muted)" }}>@ {j.company || "—"}</span></div>
                    {j.url && <a href={j.url} target="_blank" rel="noopener noreferrer" dir="ltr" className="block truncate text-xs text-accent">{j.url}</a>}
                  </div>
                  <select
                    value={j.status}
                    onChange={(e) => { updateJob(j.id, { status: e.target.value as JobStatus }); setJobs(getJobs()); }}
                    className="rounded-lg px-2 py-1 text-xs font-semibold focus:outline-none"
                    style={{ background: "var(--bg)", border: "1px solid var(--line)", color: STATUS_COLORS[j.status] }}>
                    {(Object.keys(STATUS_LABELS) as JobStatus[]).map((st) => (
                      <option key={st} value={st}>{STATUS_LABELS[st]}</option>
                    ))}
                  </select>
                  <button onClick={() => { removeJob(j.id); setJobs(getJobs()); }} className="text-xs" style={{ color: "var(--faint)" }}>✕</button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ── Scan history ── */}
        <div className={`${sectionCard} mt-6`}>
          <h2 className={sectionTitle}>🔍 Scan history ({scans.length})</h2>
          {scans.length === 0 ? (
            <p className="text-xs" style={{ color: "var(--faint)" }}>Your last 10 scans will appear here with one-click reopen.</p>
          ) : (
            <ul className="space-y-2">
              {scans.map((s) => (
                <li key={s.id} className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid var(--line)" }}>
                  <span className="font-mono text-lg font-bold tabular-nums" style={{ color: s.score >= 75 ? "var(--accent)" : s.score >= 55 ? "#fbbf24" : "#f87171", minWidth: "2.6rem" }}>
                    {s.score}%
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{s.jobTitle}</div>
                    <div className="font-mono text-[11px]" style={{ color: "var(--faint)" }}>{new Date(s.ts).toLocaleString()}</div>
                  </div>
                  <button onClick={() => openScan(s)} className="btn-ghost shrink-0 px-3 py-1.5 text-xs font-semibold" style={{ color: "var(--accent)" }}>Open</button>
                  <button onClick={() => { removeScan(s.id); setScans(getScans()); }} className="text-xs" style={{ color: "var(--faint)" }}>✕</button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ── Saved resumes ── */}
        <div className={`${sectionCard} mt-6`}>
          <h2 className={sectionTitle}>📄 Saved resumes ({resumes.length})</h2>
          {resumes.length === 0 ? (
            <p className="text-xs" style={{ color: "var(--faint)" }}>Resumes you build or unlock are saved here automatically (on this device).</p>
          ) : (
            <ul className="space-y-2">
              {resumes.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-2 rounded-lg px-3 py-2.5 text-sm" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid var(--line)" }}>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold">{r.title}</div>
                    <div className="font-mono text-[11px]" style={{ color: "var(--faint)" }}>
                      {r.source === "built" ? "CV Builder" : "Optimizer"} · {new Date(r.ts).toLocaleDateString()}
                    </div>
                  </div>
                  <button onClick={() => loadResume(r)} className="btn-ghost px-3 py-1.5 text-xs font-semibold" style={{ color: "var(--accent)" }}>Optimize</button>
                  <button onClick={() => downloadText("resume.txt", r.text)} className="btn-ghost px-3 py-1.5 text-xs font-semibold" style={{ color: "var(--fg)" }}>↓ .txt</button>
                  <button onClick={() => { removeResume(r.id); setResumes(getResumes()); }} className="text-xs" style={{ color: "var(--faint)" }}>✕</button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ── Public links ── */}
        <div className={`${sectionCard} mt-6`}>
          <h2 className={sectionTitle}>🔗 My public resume links ({links.length})</h2>
          {links.length === 0 ? (
            <p className="text-xs" style={{ color: "var(--faint)" }}>Links you publish from the builder appear here so you can unpublish them anytime.</p>
          ) : (
            <ul className="space-y-2">
              {links.map((l) => (
                <li key={l.slug} className="flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid var(--line)" }}>
                  <a href={l.url} target="_blank" rel="noopener noreferrer" className="truncate text-accent" dir="ltr">{l.url}</a>
                  <button onClick={() => removeLink(l.slug, l.token)} className="shrink-0 text-xs" style={{ color: "#f87171" }}>Unpublish</button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="mt-6 text-center font-mono text-[11px]" style={{ color: "var(--faint)" }}>
          History, resumes, and applications are stored on this device only — nothing is uploaded. <Link href="/privacy" className="underline">Privacy</Link>
        </p>
      </div>
    </main>
  );
}

export default function AccountPage() {
  return (
    <Suspense fallback={<main className="min-h-screen" style={{ background: "var(--bg)" }} />}>
      <AccountInner />
    </Suspense>
  );
}
