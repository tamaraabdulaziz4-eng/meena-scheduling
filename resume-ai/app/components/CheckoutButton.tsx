"use client";

import { useEffect, useId, useRef, useState } from "react";

/**
 * Two-phase checkout:
 *   1. Collect name/email/mobile and create the Paylink invoice (→ transactionNo).
 *   2. Card is paid INLINE on our own dark-themed form via the Paylink JS SDK
 *      (initPayment + submitInvoice) — no redirect for the common card path.
 *      Tamara / Tabby / Apple Pay / STC (which have no embedded SDK) stay one tap
 *      away via the hosted invoice URL.
 * Credentials never touch the client; only the transactionNo + hosted url do.
 */

const SDK_SRC = "https://paylink.sa/assets/js/paylink.js";
const PAY_MODE = process.env.NEXT_PUBLIC_PAY_MODE === "test" ? "test" : "production";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare global { interface Window { PaylinkPayments?: any } }

let sdkPromise: Promise<void> | null = null;
function loadSdk(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.PaylinkPayments) return Promise.resolve();
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SDK_SRC; s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { sdkPromise = null; reject(new Error("sdk")); };
    document.head.appendChild(s);
  });
  return sdkPromise;
}

export default function CheckoutButton({
  plan, label, variant = "accent", ar = false,
}: { plan: "single" | "complete"; label: string; variant?: "accent" | "ghost"; ar?: boolean }) {
  const uid = useId().replace(/[:]/g, "");
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<"details" | "card">("details");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [mobile, setMobile] = useState("");
  const [loading, setLoading] = useState(false);
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState("");
  const txRef = useRef<string>("");
  const urlRef = useRef<string>("");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payRef = useRef<any>(null);

  // Bind the Paylink SDK to the card fields ONLY AFTER they've rendered (phase
  // "card"). Initializing earlier bound to elements that weren't in the DOM yet,
  // so the fields never appeared.
  useEffect(() => {
    if (phase !== "card") return;
    let cancelled = false;
    (async () => {
      try {
        await loadSdk();
        if (cancelled) return;
        const payment = new window.PaylinkPayments({ mode: PAY_MODE, defaultLang: ar ? "ar" : "en", backgroundColor: "#101316" });
        await payment.initPayment(`#cn-${uid}`, `#nm-${uid}`, `#yy-${uid}`, `#mm-${uid}`, `#cv-${uid}`);
        if (cancelled) return;
        payRef.current = payment;
      } catch {
        // SDK/init failed — surface it and let the buyer use the hosted link
        // that's already shown below, instead of yanking them away.
        if (!cancelled) setError(ar ? "تعذّر تحميل نموذج البطاقة — استخدم \"طرق أخرى\" بالأسفل." : "Couldn't load the card form — use \"Other ways\" below.");
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const t = ar
    ? { planLine: plan === "single" ? "مرة واحدة · ٣٥ ريالاً" : "الحزمة الكاملة · ٩٩ ريالاً · دفعة واحدة",
        title: "إتمام الشراء", sub: "دفع آمن. أدخل بياناتك للمتابعة.", name: "الاسم الكامل",
        email: "البريد الإلكتروني (يُفعَّل عليه وصولك)", mobile: "رقم الجوال", pay: "المتابعة ←",
        starting: "جارٍ التحضير…", cancel: "إلغاء", failed: "تعذّر بدء الدفع، حاول مرة أخرى.",
        cardTitle: "بيانات البطاقة", cardName: "الاسم على البطاقة", cardNo: "رقم البطاقة",
        mm: "شهر", yy: "سنة", cvv: "CVV", payNow: "ادفع الآن", processing: "جارٍ الدفع…",
        other: "طرق أخرى: تمارا · تابي · Apple Pay · STC ←", secure: "🔒 دفع آمن عبر Paylink · ضمان استرجاع ٧ أيام",
        cardErr: "تحقّق من بيانات البطاقة وحاول مرة أخرى." }
    : { planLine: plan === "single" ? "One-time · SAR 35 (~$9)" : "Complete Pack · SAR 99 · one-time (~$26)",
        title: "Checkout", sub: "Secure payment. Enter your details to continue.", name: "Full name",
        email: "Email (unlocks your access)", mobile: "Mobile number", pay: "Continue →",
        starting: "Preparing…", cancel: "Cancel", failed: "Checkout failed. Please try again.",
        cardTitle: "Card details", cardName: "Name on card", cardNo: "Card number",
        mm: "MM", yy: "YY", cvv: "CVV", payNow: "Pay now", processing: "Processing…",
        other: "Other ways: Tamara · Tabby · Apple Pay · STC →", secure: "🔒 Secure via Paylink · 7-day money-back",
        cardErr: "Please check your card details and try again." };

  const inp = { background: "var(--bg)", border: "1px solid var(--line)", color: "var(--fg)" } as const;

  async function createInvoice(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !email.trim() || !mobile.trim()) { setError(ar ? "فضلاً عبّ كل الحقول." : "Please fill in all fields."); return; }
    setError(""); setLoading(true);
    try {
      const res = await fetch("/api/pay", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan, name, email, mobile, locale: ar ? "ar" : "en" }) });
      const data = await res.json();
      if (!res.ok || !data.url || !data.transactionNo) throw new Error(data.error || t.failed);
      txRef.current = String(data.transactionNo);
      urlRef.current = String(data.url);
      // Switch to the card phase — the effect binds the SDK once the fields mount.
      setPhase("card"); setLoading(false);
    } catch (err) {
      // If the SDK fails to load, fall back to the hosted page so checkout never dead-ends.
      if (urlRef.current) { window.location.href = urlRef.current; return; }
      setError(err instanceof Error ? err.message : t.failed); setLoading(false);
    }
  }

  async function payCard() {
    setError(""); setPaying(true);
    try {
      if (!payRef.current) throw new Error("not ready");
      // On success the SDK opens the bank 3DS page, which returns to our callBackUrl.
      await payRef.current.submitInvoice(txRef.current);
    } catch {
      setError(t.cardErr); setPaying(false);
    }
  }

  function reset() { setOpen(false); setPhase("details"); setError(""); setPaying(false); setLoading(false); }

  return (
    <>
      <button onClick={() => setOpen(true)}
        className={variant === "accent" ? "btn-accent block w-full py-3 text-center" : "btn-ghost block w-full py-3 text-center font-semibold"}
        style={variant === "ghost" ? { color: "var(--fg)" } : undefined}>{label}</button>

      {open && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}
          onClick={() => !loading && !paying && reset()}>
          <div dir={ar ? "rtl" : "ltr"} className={`card w-full max-w-sm p-7 ${ar ? "text-right" : "text-left"}`} style={{ borderColor: "rgba(74,222,128,0.4)" }} onClick={(e) => e.stopPropagation()}>
            <div className="mb-1 font-mono text-xs tracking-widest" style={{ color: "var(--faint)", textTransform: ar ? "none" : "uppercase" }}>{t.planLine}</div>

            {phase === "details" ? (
              <>
                <h3 className="text-xl font-bold">{t.title}</h3>
                <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>{t.sub}</p>
                <form onSubmit={createInvoice} className="mt-5 space-y-3">
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t.name} required className="w-full rounded-lg px-4 py-2.5 text-sm focus:outline-none" style={inp} />
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t.email} required dir="ltr" className={`w-full rounded-lg px-4 py-2.5 text-sm focus:outline-none ${ar ? "text-right" : ""}`} style={inp} />
                  <input value={mobile} onChange={(e) => setMobile(e.target.value)} placeholder={t.mobile} inputMode="tel" required dir="ltr" className={`w-full rounded-lg px-4 py-2.5 text-sm focus:outline-none ${ar ? "text-right" : ""}`} style={inp} />
                  {error && <div className="rounded-lg px-3 py-2 text-xs" style={{ background: "rgba(248,113,113,0.1)", color: "#f87171" }}>{error}</div>}
                  <button type="submit" disabled={loading} className="btn-accent w-full py-3 disabled:opacity-50">{loading ? t.starting : t.pay}</button>
                  <button type="button" onClick={reset} disabled={loading} className="w-full py-1 text-center text-xs" style={{ color: "var(--faint)" }}>{t.cancel}</button>
                  <p className="pt-1 text-center font-mono text-[11px]" style={{ color: "var(--faint)" }}>{t.secure}</p>
                </form>
              </>
            ) : (
              <>
                <h3 className="text-xl font-bold">{t.cardTitle}</h3>
                {/* Inline card form — Paylink SDK binds to these (readonly) fields. */}
                <div className="mt-5 space-y-3">
                  <input id={`nm-${uid}`} readOnly placeholder={t.cardName} dir="ltr" className="w-full rounded-lg px-4 py-2.5 text-sm focus:outline-none" style={inp} />
                  <input id={`cn-${uid}`} readOnly placeholder={t.cardNo} inputMode="numeric" dir="ltr" className="w-full rounded-lg px-4 py-2.5 text-sm focus:outline-none" style={inp} />
                  <div className="flex gap-2" dir="ltr">
                    <input id={`mm-${uid}`} readOnly placeholder={t.mm} className="w-full rounded-lg px-3 py-2.5 text-center text-sm focus:outline-none" style={inp} />
                    <input id={`yy-${uid}`} readOnly placeholder={t.yy} className="w-full rounded-lg px-3 py-2.5 text-center text-sm focus:outline-none" style={inp} />
                    <input id={`cv-${uid}`} readOnly placeholder={t.cvv} className="w-full rounded-lg px-3 py-2.5 text-center text-sm focus:outline-none" style={inp} />
                  </div>
                  {error && <div className="rounded-lg px-3 py-2 text-xs" style={{ background: "rgba(248,113,113,0.1)", color: "#f87171" }}>{error}</div>}
                  <button type="button" onClick={payCard} disabled={paying} className="btn-accent w-full py-3 disabled:opacity-50">{paying ? t.processing : t.payNow}</button>
                  <a href={urlRef.current || "#"} className="block w-full py-2 text-center text-xs font-semibold" style={{ color: "var(--accent)" }}>{t.other}</a>
                  <p className="text-center font-mono text-[11px]" style={{ color: "var(--faint)" }}>{t.secure}</p>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
