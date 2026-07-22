"use client";

import { useState } from "react";

/**
 * A pricing CTA that opens a small modal to collect the buyer's name + mobile
 * (both required by Paylink), creates an invoice, and redirects to the hosted
 * Paylink payment page. Fully bilingual via the `ar` prop — this is the money
 * screen, so an Arabic reader must never hit an English-only form here.
 */
export default function CheckoutButton({
  plan,
  label,
  variant = "accent",
  ar = false,
}: {
  plan: "single" | "complete";
  label: string;
  variant?: "accent" | "ghost";
  ar?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [mobile, setMobile] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const t = ar
    ? {
        planLine: plan === "single" ? "مرة واحدة · ٣٥ ريالاً" : "الحزمة الكاملة · ٩٩ ريالاً · دفعة واحدة",
        title: "إتمام الشراء",
        sub: "دفع آمن عبر Paylink (مدى، فيزا، ماستركارد). أدخل بياناتك للمتابعة.",
        name: "الاسم الكامل",
        email: "البريد الإلكتروني (يُفعَّل عليه وصولك)",
        mobile: "رقم الجوال",
        pay: "المتابعة للدفع ←",
        starting: "جارٍ بدء الدفع الآمن…",
        cancel: "إلغاء",
        failed: "تعذّر بدء الدفع، حاول مرة أخرى.",
        methods: "مدى · Visa · Mastercard",
        secure: "دفع آمن عبر Paylink",
        guarantee: "ضمان استرجاع خلال ٧ أيام.",
        anchor: "مرة واحدة — أدوات مثل Jobscan تاخذ هذا المبلغ شهرياً.",
      }
    : {
        planLine: plan === "single" ? "One-time · SAR 35 (~$9)" : "Complete Pack · SAR 99 · one-time (~$26)",
        title: "Checkout",
        sub: "Secure payment via Paylink. Enter your details to continue.",
        name: "Full name",
        email: "Email (unlocks your access)",
        mobile: "Mobile number",
        pay: "Continue to payment →",
        starting: "Starting secure checkout…",
        cancel: "Cancel",
        failed: "Checkout failed. Please try again.",
        methods: "mada · Visa · Mastercard",
        secure: "Secure checkout via Paylink",
        guarantee: "7-day money-back guarantee.",
        anchor: "One-time — Jobscan and Rezi charge this much every month.",
      };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !email.trim() || !mobile.trim()) {
      setError(ar ? "\u0641\u0636\u0644\u0627\u064b \u0639\u0628\u0651\u0650 \u0643\u0644 \u0627\u0644\u062d\u0642\u0648\u0644 \u0644\u0644\u0645\u062a\u0627\u0628\u0639\u0629." : "Please fill in all fields to continue.");
      return;
    }
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // locale rides along so the payment callback returns the buyer to
        // the right language flow.
        body: JSON.stringify({ plan, name, email, mobile, locale: ar ? "ar" : "en" }),
      });
      const data = await res.json();
      if (!res.ok || !data.url) throw new Error(data.error || t.failed);
      window.location.href = data.url; // hand off to Paylink's hosted page
    } catch (err) {
      setError(err instanceof Error ? err.message : t.failed);
      setLoading(false);
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={variant === "accent" ? "btn-accent block w-full py-3 text-center" : "btn-ghost block w-full py-3 text-center font-semibold"}
        style={variant === "ghost" ? { color: "var(--fg)" } : undefined}
      >
        {label}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4"
          style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}
          onClick={() => !loading && setOpen(false)}
        >
          <div
            dir={ar ? "rtl" : "ltr"}
            className={`card w-full max-w-sm p-7 ${ar ? "text-right" : "text-left"}`}
            style={{ borderColor: "rgba(74,222,128,0.4)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-1 font-mono text-xs tracking-widest" style={{ color: "var(--faint)", textTransform: ar ? "none" : "uppercase" }}>
              {t.planLine}
            </div>
            <h3 className="text-xl font-bold">{t.title}</h3>
            <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>{t.sub}</p>

            <form onSubmit={submit} className="mt-5 space-y-3">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t.name}
                required
                className="w-full rounded-lg px-4 py-2.5 text-sm focus:outline-none"
                style={{ background: "var(--bg)", border: "1px solid var(--line)", color: "var(--fg)" }}
              />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t.email}
                required
                dir="ltr"
                className={`w-full rounded-lg px-4 py-2.5 text-sm focus:outline-none ${ar ? "text-right" : ""}`}
                style={{ background: "var(--bg)", border: "1px solid var(--line)", color: "var(--fg)" }}
              />
              <input
                value={mobile}
                onChange={(e) => setMobile(e.target.value)}
                placeholder={t.mobile}
                inputMode="tel"
                required
                dir="ltr"
                className={`w-full rounded-lg px-4 py-2.5 text-sm focus:outline-none ${ar ? "text-right" : ""}`}
                style={{ background: "var(--bg)", border: "1px solid var(--line)", color: "var(--fg)" }}
              />
              {error && (
                <div className="rounded-lg px-3 py-2 text-xs" style={{ background: "rgba(248,113,113,0.1)", color: "#f87171" }}>
                  {error}
                </div>
              )}
              <button type="submit" disabled={loading} className="btn-accent w-full py-3 disabled:opacity-50">
                {loading ? t.starting : t.pay}
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={loading}
                className="w-full py-1 text-center text-xs"
                style={{ color: "var(--faint)" }}
              >
                {t.cancel}
              </button>
              {plan === "single" && (
                <p className="text-center font-mono text-[11px]" style={{ color: "var(--faint)" }}>{t.anchor}</p>
              )}
              <div className="flex flex-col items-center gap-1 pt-1 text-center font-mono text-[11px]" style={{ color: "var(--faint)" }}>
                <div>🔒 {t.methods}</div>
                <div>{t.secure}</div>
                <div>{t.guarantee}</div>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
