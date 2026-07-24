"use client";
import { useState } from "react";

/** Newsletter capture — the owned-audience engine for autonomous marketing. */
export default function SubscribeBox({ ar = false }: { ar?: boolean }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "done" | "err">("idle");

  const t = ar
    ? { title: "نصيحة توظيف أسبوعية", sub: "نصائح ATS وفرص السوق السعودي — مجاناً على بريدك، وإلغاء الاشتراك بضغطة.", ph: "بريدك الإلكتروني", cta: "اشترك", done: "تم! أول رسالة توصلك قريباً ✓", err: "تعذّر الاشتراك — حاول ثانية." }
    : { title: "One sharp career tip, weekly", sub: "ATS tactics and Saudi/Gulf market insights — free, unsubscribe anytime.", ph: "Your email", cta: "Subscribe", done: "Done! First issue coming soon ✓", err: "Couldn't subscribe — try again." };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setState("busy");
    try {
      const res = await fetch("/api/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      setState(res.ok ? "done" : "err");
    } catch {
      setState("err");
    }
  }

  return (
    <section className="px-6 py-14" style={{ borderTop: "1px solid var(--line)" }}>
      <div className="mx-auto max-w-xl text-center">
        <h2 className="text-2xl font-bold">{t.title}</h2>
        <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>{t.sub}</p>
        {state === "done" ? (
          <p className="mt-5 font-semibold" style={{ color: "var(--accent)" }}>{t.done}</p>
        ) : (
          <form onSubmit={submit} className="mt-5 flex gap-2">
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t.ph} required dir="ltr"
              className={`flex-1 rounded-xl px-4 py-3 text-sm focus:outline-none ${ar ? "text-right" : ""}`}
              style={{ background: "var(--surface)", border: "1px solid var(--line)", color: "var(--fg)" }} />
            <button type="submit" disabled={state === "busy"} className="btn-accent px-6 py-3 text-sm disabled:opacity-50">
              {state === "busy" ? "…" : t.cta}
            </button>
          </form>
        )}
        {state === "err" && <p className="mt-2 text-xs" style={{ color: "#f87171" }}>{t.err}</p>}
      </div>
    </section>
  );
}
