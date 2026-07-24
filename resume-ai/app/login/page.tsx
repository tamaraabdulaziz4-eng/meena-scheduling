"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import AuroraBlobs from "../components/orb/AuroraBlobs";
import { useOrbScene } from "../components/orb/OrbProvider";
import AiOrb from "../components/AiOrb";

function LoginInner() {
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  // Survive refresh/back after sending — otherwise users re-request duplicates.
  useEffect(() => {
    try {
      // Arriving via an expired link must show that message in the form — not the
      // stale "Check your inbox" view restored from a previous request.
      if (params.get("error") === "expired") {
        sessionStorage.removeItem("ra_login_sent");
        return;
      }
      const saved = sessionStorage.getItem("ra_login_sent");
      if (saved) { setEmail(saved); setState("sent"); }
    } catch { /* noop */ }
  }, [params]);
  const [error, setError] = useState(params.get("error") === "expired" ? "That link expired — request a new one." : "");

  // رابط drives this scene: the Gate. Thinking while sending, a radio-pulse
  // broadcast the moment the magic link is sent.
  useOrbScene(
    { visible: true, top: state === "sent" ? "20vh" : "22vh", size: 72, mood: state === "sending" ? "thinking" : state === "sent" ? "done" : "idle", radio: state === "sent" },
    [state]
  );

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
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden px-6" style={{ background: "var(--cosmos-bg)", color: "var(--cosmos-text)" }}>
      <AuroraBlobs />
      <div className="relative w-full max-w-sm rounded-3xl p-8" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", backdropFilter: "blur(12px)" }}>
        <Link href="/" className="mb-6 flex items-center gap-2.5">
          <AiOrb size={30} />
          <span className="text-[15px] font-bold tracking-tight">ResumeAI</span>
        </Link>

        {state === "sent" ? (
          <div className="text-center">
            <h1 className="text-2xl font-bold">Check your inbox</h1>
            <p className="mt-2 text-sm" style={{ color: "var(--cosmos-muted)" }}>
              We sent a sign-in link to <strong>{email}</strong>. Click it to continue — it expires in 15 minutes.
            </p>
            <button
              onClick={() => { try { sessionStorage.removeItem("ra_login_sent"); } catch { /* noop */ } setEmail(""); setState("idle"); }}
              className="mt-4 text-sm font-semibold" style={{ color: "var(--accent)" }}>
              Use a different email →
            </button>
          </div>
        ) : (
          <>
            <h1 className="text-2xl font-bold">Your resume awaits</h1>
            <p className="mt-1 text-sm" style={{ color: "var(--cosmos-muted)" }}>Enter your email and we&apos;ll send you a magic link — no password.</p>
            <form onSubmit={submit} className="mt-5 space-y-3">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@email.com"
                required
                className="w-full rounded-lg px-4 py-2.5 text-sm focus:outline-none"
                style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.14)", color: "var(--cosmos-text)", fontSize: 16 }}
              />
              {error && <div className="rounded-lg px-3 py-2 text-xs" style={{ background: "rgba(248,113,113,0.1)", color: "#f87171" }}>{error}</div>}
              <button type="submit" disabled={state === "sending"} className="btn-accent w-full py-3 disabled:opacity-50">
                {state === "sending" ? "Sending…" : "Send magic link"}
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
