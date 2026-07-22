"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

function LoginInner() {
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  // Survive refresh/back after sending — otherwise users re-request duplicates.
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem("ra_login_sent");
      if (saved) { setEmail(saved); setState("sent"); }
    } catch { /* noop */ }
  }, []);
  const [error, setError] = useState(params.get("error") === "expired" ? "That link expired — request a new one." : "");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setState("sending");
    try {
      const res = await fetch("/api/auth/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setState("sent");
      try { sessionStorage.setItem("ra_login_sent", email); } catch { /* noop */ }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setState("idle");
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-6" style={{ background: "var(--bg)", color: "var(--fg)" }}>
      <div className="card w-full max-w-sm p-8">
        <Link href="/" className="mb-6 flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg font-mono text-sm font-bold" style={{ background: "var(--accent)", color: "#05130a" }}>R</div>
          <span className="text-[15px] font-bold tracking-tight">ResumeAI</span>
        </Link>

        {state === "sent" ? (
          <>
            <h1 className="text-2xl font-bold">Check your inbox</h1>
            <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
              We sent a sign-in link to <strong>{email}</strong>. Click it to continue — it expires in 15 minutes.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-bold">Sign in</h1>
            <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>Enter your email and we&apos;ll send you a magic link — no password.</p>
            <form onSubmit={submit} className="mt-5 space-y-3">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@email.com"
                required
                className="w-full rounded-lg px-4 py-2.5 text-sm focus:outline-none"
                style={{ background: "var(--bg)", border: "1px solid var(--line)", color: "var(--fg)" }}
              />
              {error && <div className="rounded-lg px-3 py-2 text-xs" style={{ background: "rgba(248,113,113,0.1)", color: "#f87171" }}>{error}</div>}
              <button type="submit" disabled={state === "sending"} className="btn-accent w-full py-3 disabled:opacity-50">
                {state === "sending" ? "Sending…" : "Send magic link →"}
              </button>
            </form>
          </>
        )}
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<main className="min-h-screen" style={{ background: "var(--bg)" }} />}>
      <LoginInner />
    </Suspense>
  );
}
