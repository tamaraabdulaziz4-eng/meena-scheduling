"use client";

import Link from "next/link";
import { useEffect } from "react";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("App error:", error);
  }, [error]);

  return (
    <main className="flex min-h-screen items-center justify-center px-6" style={{ background: "var(--bg)", color: "var(--fg)" }}>
      <div className="card w-full max-w-md p-10 text-center" style={{ borderColor: "rgba(248,113,113,0.4)" }}>
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full font-mono text-3xl"
          style={{ background: "rgba(248,113,113,0.12)", color: "#f87171", border: "1px solid rgba(248,113,113,0.3)" }}>
          !
        </div>
        <h1 className="text-2xl font-bold">Something went wrong</h1>
        <p className="mx-auto mt-2 max-w-sm text-sm" style={{ color: "var(--muted)" }}>
          An unexpected error occurred. Your work isn&apos;t lost — try again, or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <button onClick={reset} className="btn-accent px-6 py-3">Try again</button>
          <Link href="/" className="btn-ghost px-6 py-3 font-semibold" style={{ color: "var(--fg)" }}>Back home</Link>
        </div>
      </div>
    </main>
  );
}
