"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

function CallbackInner() {
  const params = useSearchParams();
  const [state, setState] = useState<"checking" | "paid" | "failed">("checking");
  const [detail, setDetail] = useState("");

  useEffect(() => {
    const tx = params.get("transactionNo") || params.get("TransactionNo");
    if (!tx) {
      setState("failed");
      setDetail("No transaction reference was returned.");
      return;
    }
    fetch(`/api/pay/verify?transactionNo=${encodeURIComponent(tx)}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.paid) {
          setState("paid");
          setDetail(`Order ${d.orderNumber || tx} confirmed.`);
        } else {
          setState("failed");
          setDetail(`Payment status: ${d.status || "not completed"}.`);
        }
      })
      .catch(() => {
        setState("failed");
        setDetail("We couldn't verify the payment. If you were charged, contact support.");
      });
  }, [params]);

  const accent = state === "paid" ? "#4ade80" : state === "failed" ? "#f87171" : "#fbbf24";

  return (
    <main className="flex min-h-screen items-center justify-center px-6" style={{ background: "var(--bg)", color: "var(--fg)" }}>
      <div className="card w-full max-w-md p-10 text-center" style={{ borderColor: `${accent}55` }}>
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full font-mono text-3xl"
          style={{ background: `${accent}1a`, color: accent, border: `1px solid ${accent}40` }}>
          {state === "checking" ? "…" : state === "paid" ? "✓" : "✕"}
        </div>
        <h1 className="text-2xl font-bold">
          {state === "checking" ? "Confirming your payment…" : state === "paid" ? "Payment successful" : "Payment not completed"}
        </h1>
        <p className="mt-3 text-sm" style={{ color: "var(--muted)" }}>{detail || "Please wait a moment."}</p>

        {state === "paid" && (
          <>
            <p className="mt-6 text-sm" style={{ color: "rgba(244,245,243,0.8)" }}>
              You&apos;re all set — thank you! Head back and optimize as many resumes as you need.
            </p>
            <Link href="/optimize" className="btn-accent mt-6 inline-block px-8 py-3">Start optimizing →</Link>
          </>
        )}
        {state === "failed" && (
          <Link href="/#pricing" className="btn-ghost mt-6 inline-block px-8 py-3" style={{ color: "var(--fg)" }}>
            Back to pricing
          </Link>
        )}
      </div>
    </main>
  );
}

export default function PayCallback() {
  return (
    <Suspense fallback={<main className="min-h-screen" style={{ background: "var(--bg)" }} />}>
      <CallbackInner />
    </Suspense>
  );
}
