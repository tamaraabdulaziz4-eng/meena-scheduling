"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
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
        pendingTitle: "\u062c\u0627\u0631\u064d \u0645\u0639\u0627\u0644\u062c\u0629 \u0627\u0644\u062f\u0641\u0639",
        pendingMsg: "\u062f\u0641\u0639\u062a\u0643 \u0642\u064a\u062f \u0627\u0644\u0645\u0639\u0627\u0644\u062c\u0629 \u0648\u0644\u0645 \u062a\u0643\u062a\u0645\u0644 \u0628\u0639\u062f. \u0644\u0627 \u062a\u062f\u0641\u0639 \u0645\u0631\u0629 \u0623\u062e\u0631\u0649 \u2014 \u0627\u0636\u063a\u0637 \u201c\u062a\u062d\u062f\u064a\u062b \u0627\u0644\u062d\u0627\u0644\u0629\u201d \u0628\u0639\u062f \u0644\u062d\u0638\u0627\u062a.",
        refresh: "\u062a\u062d\u062f\u064a\u062b \u0627\u0644\u062d\u0627\u0644\u0629",
        wait: "\u0644\u062d\u0638\u0629 \u0645\u0646 \u0641\u0636\u0644\u0643.",
        noTx: "\u0644\u0645 \u064a\u0635\u0644\u0646\u0627 \u0631\u0642\u0645 \u0627\u0644\u0639\u0645\u0644\u064a\u0629.",
        confirmed: (o: string) => `\u062a\u0645 \u062a\u0623\u0643\u064a\u062f \u0627\u0644\u0637\u0644\u0628 ${o}.`,
        amountMismatch: "\u0627\u0644\u0645\u0628\u0644\u063a \u0627\u0644\u0645\u062f\u0641\u0648\u0639 \u0644\u0627 \u064a\u0637\u0627\u0628\u0642 \u0633\u0639\u0631 \u0627\u0644\u0628\u0627\u0642\u0629. \u0625\u0630\u0627 \u062e\u064f\u0635\u0645 \u0645\u0646\u0643\u060c \u0631\u0627\u0633\u0644\u0646\u0627 \u0648\u0633\u0646\u062d\u0644\u0647\u0627 \u0641\u0648\u0631\u0627\u064b.",
        statusLine: (st: string) => `\u062d\u0627\u0644\u0629 \u0627\u0644\u062f\u0641\u0639: ${st || "\u063a\u064a\u0631 \u0645\u0643\u062a\u0645\u0644\u0629"}.`,
        verifyFail: "\u062a\u0639\u0630\u0651\u0631 \u0627\u0644\u062a\u062d\u0642\u0642 \u0645\u0646 \u0627\u0644\u062f\u0641\u0639. \u0625\u0630\u0627 \u062e\u064f\u0635\u0645 \u0645\u0646\u0643 \u0627\u0644\u0645\u0628\u0644\u063a\u060c \u062a\u0648\u0627\u0635\u0644 \u0645\u0639\u0646\u0627.",
        monthlyMsg: "\u0643\u0644 \u0634\u064a\u0621 \u062c\u0627\u0647\u0632 \u2014 \u0634\u0643\u0631\u0627\u064b \u0644\u0643! \u0648\u0635\u0648\u0644\u0643 \u063a\u064a\u0631 \u0627\u0644\u0645\u062d\u062f\u0648\u062f \u0645\u0641\u0639\u0651\u0644 \u0644\u0645\u062f\u0629 \u0663\u0660 \u064a\u0648\u0645\u0627\u064b.",
        completeMsg: "\u0643\u0644 \u0634\u064a\u0621 \u062c\u0627\u0647\u0632 \u2014 \u0634\u0643\u0631\u0627\u064b \u0644\u0643! \u0627\u0644\u062d\u0632\u0645\u0629 \u0627\u0644\u0643\u0627\u0645\u0644\u0629 \u0645\u0641\u0639\u0651\u0644\u0629: \u0627\u0644\u0633\u064a\u0631\u0629 + \u062e\u0637\u0627\u0628 \u0627\u0644\u062a\u0639\u0631\u064a\u0641 + \u0644\u064a\u0646\u0643\u062f\u0625\u0646 + \u062a\u062d\u0636\u064a\u0631 \u0627\u0644\u0645\u0642\u0627\u0628\u0644\u0629\u060c \u0648\u0635\u0648\u0644 \u0643\u0627\u0645\u0644 \u0644\u0645\u062f\u0629 \u0669\u0660 \u064a\u0648\u0645\u0627\u064b.",
        singleMsg: "\u0643\u0644 \u0634\u064a\u0621 \u062c\u0627\u0647\u0632 \u2014 \u0634\u0643\u0631\u0627\u064b \u0644\u0643! \u0628\u0627\u0642\u062a\u0643 \u0645\u0641\u0639\u0651\u0644\u0629 \u0644\u0645\u062f\u0629 \u0662\u0664 \u0633\u0627\u0639\u0629.",
        start: "\u0627\u0628\u062f\u0623 \u0627\u0644\u062a\u062d\u0633\u064a\u0646 \u2190",
        back: "\u0627\u0644\u0631\u062c\u0648\u0639 \u0644\u0644\u0623\u0633\u0639\u0627\u0631",
      }
    : {
        checking: "Confirming your payment…",
        paidTitle: "Payment successful",
        failedTitle: "Payment not completed",
        pendingTitle: "Payment processing",
        pendingMsg: "Your payment is still being processed and hasn't completed yet. Don't pay again — tap “Refresh status” in a moment.",
        refresh: "Refresh status",
        wait: "Please wait a moment.",
        noTx: "No transaction reference was returned.",
        confirmed: (o: string) => `Order ${o} confirmed.`,
        amountMismatch: "The amount paid didn't match the plan price. If you were charged, contact support and we'll sort it out.",
        statusLine: (st: string) => `Payment status: ${st || "not completed"}.`,
        verifyFail: "We couldn't verify the payment. If you were charged, contact support.",
        monthlyMsg: "You're all set — thank you! Your unlimited access is active for the next 30 days. Optimize as many resumes as you need.",
        completeMsg: "You're all set — thank you! Your Complete Pack is active: resume + cover letter + LinkedIn + interview prep, full access for 90 days.",
        singleMsg: "You're all set — thank you! Your single optimization pass is active for the next 24 hours.",
        start: "Start optimizing →",
        back: "Back to pricing",
      };
  const [state, setState] = useState<"checking" | "paid" | "failed" | "pending">("checking");
  const [detail, setDetail] = useState("");
  const [plan, setPlan] = useState<"single" | "complete" | "monthly" | "">("");

  // One-time SAR value per plan — used for ad conversion tracking.
  const PLAN_VALUE: Record<string, number> = { single: 35, complete: 99, monthly: 75 };

  // Google Ads conversion tracking — fires ONLY on a confirmed payment so ad
  // spend is measured against real revenue, not clicks. Fully dormant until the
  // account's conversion ID/label are set as env vars (no ID → nothing loads,
  // zero effect on the page), so this can ship now and activate with no redeploy.
  function reportPurchase(paidPlan: "single" | "complete" | "monthly", orderId: string) {
    const adsId = process.env.NEXT_PUBLIC_GOOGLE_ADS_ID;        // e.g. AW-1234567890
    const label = process.env.NEXT_PUBLIC_GOOGLE_ADS_CONV_LABEL; // e.g. AbC-D_efg123
    if (!adsId || !label) return;
    const value = PLAN_VALUE[paidPlan] ?? 35;
    try {
      const w = window as unknown as { gtag?: (...a: unknown[]) => void; dataLayer?: unknown[] };
      if (!w.gtag) {
        const s = document.createElement("script");
        s.async = true;
        s.src = `https://www.googletagmanager.com/gtag/js?id=${adsId}`;
        document.head.appendChild(s);
        w.dataLayer = w.dataLayer || [];
        w.gtag = function gtag(...args: unknown[]) { w.dataLayer!.push(args); };
        w.gtag("js", new Date());
        w.gtag("config", adsId);
      }
      w.gtag("event", "conversion", {
        send_to: `${adsId}/${label}`,
        value,
        currency: "SAR",
        transaction_id: orderId, // dedupes repeat views of the callback
      });
    } catch { /* tracking must never break the confirmation page */ }
  }

  // Meta Pixel Purchase — fires only on a confirmed payment. No-op unless the
  // pixel is loaded (NEXT_PUBLIC_META_PIXEL_ID set), so it's safe to ship now.
  function reportMetaPurchase(paidPlan: "single" | "complete" | "monthly", orderId: string) {
    const value = PLAN_VALUE[paidPlan] ?? 35;
    try {
      const w = window as unknown as { fbq?: (...a: unknown[]) => void };
      if (typeof w.fbq !== "function") return;
      w.fbq("track", "Purchase", { value, currency: "SAR", content_name: paidPlan, order_id: orderId });
    } catch { /* never break the confirmation page */ }
  }

  // Statuses that mean the payment is definitively over and unsuccessful. Anything
  // else that isn't "paid" (pending, processing, under_process, unknown/blank) is
  // still IN PROGRESS — we must NOT call it "failed", or we'd nudge the buyer into
  // paying a second time for a charge that may still land.
  const isDeadStatus = (status: string) =>
    /cancel|declin|fail|expir|refund|void|error|reject/i.test(status || "");

  const checkStatus = useCallback(() => {
    const tx = params.get("transactionNo") || params.get("TransactionNo");
    if (!tx) {
      setState("failed");
      setDetail(t.noTx);
      return;
    }
    setState("checking");
    setDetail("");
    fetch(`/api/pay/verify?transactionNo=${encodeURIComponent(tx)}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.paid && d.amountOk !== false) {
          const paidPlan = d.plan === "complete" ? "complete" : d.plan === "monthly" ? "monthly" : "single";
          setState("paid");
          setPlan(paidPlan);
          setDetail(t.confirmed(d.orderNumber || tx));
          // Measure this sale against ad spend (each no-op until its env vars are set).
          reportPurchase(paidPlan, d.orderNumber || tx);
          reportMetaPurchase(paidPlan, d.orderNumber || tx);
          // Old results were generated locked (pre-payment) — clear them so the
          // next scan comes back complete instead of showing the stale preview.
          try {
            localStorage.removeItem("ra_optimize_result");
            localStorage.removeItem("ra_ar_optimize_result");
          } catch { /* non-fatal */ }
        } else if (d.paid && d.amountOk === false) {
          // Charged, but the amount didn't cover the plan — a support case, not a retry.
          setState("failed");
          setDetail(t.amountMismatch);
        } else if (isDeadStatus(d.status)) {
          setState("failed");
          setDetail(t.statusLine(d.status));
        } else {
          // Not paid yet, but not dead either — keep it as "pending" and let the
          // buyer re-poll instead of showing a scary "failed" + pay-again path.
          setState("pending");
          setDetail(t.pendingMsg);
        }
      })
      .catch(() => {
        // A network/verify blip is not a failed payment — let them retry the check.
        setState("pending");
        setDetail(t.verifyFail);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  const accent = state === "paid" ? "#4ade80" : state === "failed" ? "#f87171" : "#fbbf24";

  return (
    <main dir={ar ? "rtl" : "ltr"} lang={ar ? "ar" : "en"} className="flex min-h-screen items-center justify-center px-6" style={{ background: "var(--bg)", color: "var(--fg)" }}>
      <div className="card w-full max-w-md p-10 text-center" style={{ borderColor: `${accent}55` }}>
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full font-mono text-3xl"
          style={{ background: `${accent}1a`, color: accent, border: `1px solid ${accent}40` }}>
          {state === "checking" || state === "pending" ? "…" : state === "paid" ? "✓" : "✕"}
        </div>
        <h1 className="text-2xl font-bold">
          {state === "checking"
            ? t.checking
            : state === "paid"
            ? t.paidTitle
            : state === "pending"
            ? t.pendingTitle
            : t.failedTitle}
        </h1>
        <p className="mt-3 text-sm" style={{ color: "var(--muted)" }}>{detail || t.wait}</p>

        {state === "paid" && (
          <>
            <p className="mt-6 text-sm" style={{ color: "rgba(244,245,243,0.8)" }}>
              {plan === "complete" ? t.completeMsg : plan === "monthly" ? t.monthlyMsg : t.singleMsg}
            </p>
            <Link href={ar ? "/ar/optimize" : "/optimize"} className="btn-accent mt-6 inline-block px-8 py-3">{t.start}</Link>
          </>
        )}
        {state === "pending" && (
          <div className="mt-6 flex flex-col items-center gap-3">
            <button onClick={checkStatus} className="btn-accent inline-block px-8 py-3">
              {t.refresh}
            </button>
            <Link href={ar ? "/ar#pricing" : "/#pricing"} className="btn-ghost inline-block px-8 py-3" style={{ color: "var(--fg)" }}>
              {t.back}
            </Link>
          </div>
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
