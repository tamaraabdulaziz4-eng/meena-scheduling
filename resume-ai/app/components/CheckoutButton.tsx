"use client";

import { useState } from "react";

/**
 * A pricing CTA that opens a small modal to collect the buyer's name + mobile
 * (both required by Paylink), creates an invoice, and redirects to the hosted
 * Paylink payment page.
 */
export default function CheckoutButton({
  plan,
  label,
  variant = "accent",
}: {
  plan: "single" | "monthly";
  label: string;
  variant?: "accent" | "ghost";
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [mobile, setMobile] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan, name, email, mobile }),
      });
      const data = await res.json();
      if (!res.ok || !data.url) throw new Error(data.error || "Checkout failed");
      window.location.href = data.url; // hand off to Paylink's hosted page
    } catch (err) {
      setError(err instanceof Error ? err.message : "Checkout failed. Please try again.");
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
            className="card w-full max-w-sm p-7 text-left"
            style={{ borderColor: "rgba(74,222,128,0.4)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-1 font-mono text-xs uppercase tracking-widest" style={{ color: "var(--faint)" }}>
              {plan === "single" ? "One-time · SAR 35 (~$9)" : "Unlimited · SAR 75/mo (~$19)"}
            </div>
            <h3 className="text-xl font-bold">Checkout</h3>
            <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
              Secure payment via Paylink. Enter your details to continue.
            </p>

            <form onSubmit={submit} className="mt-5 space-y-3">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Full name"
                required
                className="w-full rounded-lg px-4 py-2.5 text-sm focus:outline-none"
                style={{ background: "var(--bg)", border: "1px solid var(--line)", color: "var(--fg)" }}
              />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Email (unlocks your access)"
                required
                className="w-full rounded-lg px-4 py-2.5 text-sm focus:outline-none"
                style={{ background: "var(--bg)", border: "1px solid var(--line)", color: "var(--fg)" }}
              />
              <input
                value={mobile}
                onChange={(e) => setMobile(e.target.value)}
                placeholder="Mobile number"
                inputMode="tel"
                required
                className="w-full rounded-lg px-4 py-2.5 text-sm focus:outline-none"
                style={{ background: "var(--bg)", border: "1px solid var(--line)", color: "var(--fg)" }}
              />
              {error && (
                <div className="rounded-lg px-3 py-2 text-xs" style={{ background: "rgba(248,113,113,0.1)", color: "#f87171" }}>
                  {error}
                </div>
              )}
              <button type="submit" disabled={loading} className="btn-accent w-full py-3 disabled:opacity-50">
                {loading ? "Starting secure checkout…" : "Continue to payment →"}
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={loading}
                className="w-full py-1 text-center text-xs"
                style={{ color: "var(--faint)" }}
              >
                Cancel
              </button>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
