"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

function CallbackInner() {
  const params = useSearchParams();
  const ar = params.get("lang") === "ar";
  const t = ar
    ? {
        checking: "\u062c\u0627\u0631\u064d \u062a\u0623\u0643\u064a\u062f \u0627\u0644\u062f\u0641\u0639\u2026",
        paidTitle: "\u062a\u0645 \u0627\u0644\u062f\u0641\u0639 \u0628\u0646\u062c\u0627\u062d",
        failedTitle: "\u0644\u0645 \u064a\u0643\u062a\u0645\u0644 \u0627\u0644\u062f\u0641\u0639",
        wait: "\u0644\u062d\u0638\u0629 \u0645\u0646 \u0641\u0636\u0644\u0643.",
        noTx: "\u0644\u0645 \u064a\u0635\u0644\u0646\u0627 \u0631\u0642\u0645 \u0627\u0644\u0639\u0645\u0644\u064a\u0629.",
        confirmed: (o: string) => `\u062a\u0645 \u062a\u0623\u0643\u064a\u062f \u0627\u0644\u0637\u0644\u0628 ${o}.`,
        amountMismatch: "\u0627\u0644\u0645\u0628\u0644\u063a \u0627\u0644\u0645\u062f\u0641\u0648\u0639 \u0644\u0627 \u064a\u0637\u0627\u0628\u0642 \u0633\u0639\u0631 \u0627\u0644\u0628\u0627\u0642\u0629. \u0625\u0630\u0627 \u062e\u064f\u0635\u0645 \u0645\u0646\u0643\u060c \u0631\u0627\u0633\u0644\u0646\u0627 \u0648\u0633\u0646\u062d\u0644\u0647\u0627 \u0641\u0648\u0631\u0627\u064b.",
        statusLine: (st: string) => `\u062d\u0627\u0644\u0629 \u0627\u0644\u062f\u0641\u0639: ${st || "\u063a\u064a\u0631 \u0645\u0643\u062a\u0645\u0644\u0629"}.`,
        verifyFail: "\u062a\u0639\u0630\u0651\u0631 \u0627\u0644\u062a\u062d\u0642\u0642 \u0645\u0646 \u0627\u0644\u062f\u0641\u0639. \u0625\u0630\u0627 \u062e\u064f\u0635\u0645 \u0645\u0646\u0643 \u0627\u0644\u0645\u0628\u0644\u063a\u060c \u062a\u0648\u0627\u0635\u0644 \u0645\u0639\u0646\u0627.",
        monthlyMsg: "\u0643\u0644 \u0634\u064a\u0621 \u062c\u0627\u0647\u0632 \u2014 \u0634\u0643\u0631\u0627\u064b \u0644\u0643! \u0648\u0635\u0648\u0644\u0643 \u063a\u064a\u0631 \u0627\u0644\u0645\u062d\u062f\u0648\u062f \u0645\u0641\u0639\u0651\u0644 \u0644\u0645\u062f\u0629 \u0663\u0660 \u064a\u0648\u0645\u0627\u064b.",
        singleMsg: "\u0643\u0644 \u0634\u064a\u0621 \u062c\u0627\u0647\u0632 \u2014 \u0634\u0643\u0631\u0627\u064b \u0644\u0643! \u0628\u0627\u0642\u062a\u0643 \u0645\u0641\u0639\u0651\u0644\u0629 \u0644\u0645\u062f\u0629 \u0662\u0664 \u0633\u0627\u0639\u0629.",
        start: "\u0627\u0628\u062f\u0623 \u0627\u0644\u062a\u062d\u0633\u064a\u0646 \u2190",
        back: "\u0627\u0644\u0631\u062c\u0648\u0639 \u0644\u0644\u0623\u0633\u0639\u0627\u0631",
      }
    : {
        checking: "Confirming your payment…",
        paidTitle: "Payment successful",
        failedTitle: "Payment not completed",
        wait: "Please wait a moment.",
        noTx: "No transaction reference was returned.",
        confirmed: (o: string) => `Order ${o} confirmed.`,
        amountMismatch: "The amount paid didn't match the plan price. If you were charged, contact support and we'll sort it out.",
        statusLine: (st: string) => `Payment status: ${st || "not completed"}.`,
        verifyFail: "We couldn't verify the payment. If you were charged, contact support.",
        monthlyMsg: "You're all set — thank you! Your unlimited access is active for the next 30 days. Optimize as many resumes as you need.",
        singleMsg: "You're all set — thank you! Your single optimization pass is active for the next 24 hours.",
        start: "Start optimizing →",
        back: "Back to pricing",
      };
  const [state, setState] = useState<"checking" | "paid" | "failed">("checking");
  const [detail, setDetail] = useState("");
  const [plan, setPlan] = useState<"single" | "monthly" | "">("");

  useEffect(() => {
    const tx = params.get("transactionNo") || params.get("TransactionNo");
    if (!tx) {
      setState("failed");
      setDetail(t.noTx);
      return;
    }
    fetch(`/api/pay/verify?transactionNo=${encodeURIComponent(tx)}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.paid && d.amountOk !== false) {
          setState("paid");
          setPlan(d.plan === "monthly" ? "monthly" : "single");
          setDetail(t.confirmed(d.orderNumber || tx));
          // Old results were generated locked (pre-payment) — clear them so the
          // next scan comes back complete instead of showing the stale preview.
          try {
            localStorage.removeItem("ra_optimize_result");
            localStorage.removeItem("ra_ar_optimize_result");
          } catch { /* non-fatal */ }
        } else if (d.paid && d.amountOk === false) {
          setState("failed");
          setDetail(t.amountMismatch);
        } else {
          setState("failed");
          setDetail(t.statusLine(d.status));
        }
      })
      .catch(() => {
        setState("failed");
        setDetail(t.verifyFail);
      });
  }, [params]);

  const accent = state === "paid" ? "#4ade80" : state === "failed" ? "#f87171" : "#fbbf24";

  return (
    <main dir={ar ? "rtl" : "ltr"} lang={ar ? "ar" : "en"} className="flex min-h-screen items-center justify-center px-6" style={{ background: "var(--bg)", color: "var(--fg)" }}>
      <div className="card w-full max-w-md p-10 text-center" style={{ borderColor: `${accent}55` }}>
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full font-mono text-3xl"
          style={{ background: `${accent}1a`, color: accent, border: `1px solid ${accent}40` }}>
          {state === "checking" ? "…" : state === "paid" ? "✓" : "✕"}
        </div>
        <h1 className="text-2xl font-bold">
          {state === "checking" ? t.checking : state === "paid" ? t.paidTitle : t.failedTitle}
        </h1>
        <p className="mt-3 text-sm" style={{ color: "var(--muted)" }}>{detail || t.wait}</p>

        {state === "paid" && (
          <>
            <p className="mt-6 text-sm" style={{ color: "rgba(244,245,243,0.8)" }}>
              {plan === "monthly" ? t.monthlyMsg : t.singleMsg}
            </p>
            <Link href={ar ? "/ar/optimize" : "/optimize"} className="btn-accent mt-6 inline-block px-8 py-3">{t.start}</Link>
          </>
        )}
        {state === "failed" && (
          <Link href={ar ? "/ar#pricing" : "/#pricing"} className="btn-ghost mt-6 inline-block px-8 py-3" style={{ color: "var(--fg)" }}>
            {t.back}
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
