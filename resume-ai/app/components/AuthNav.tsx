"use client";
import { useEffect, useState } from "react";
import Link from "next/link";

/**
 * Session-aware nav links. Shows "Sign in" when logged out, and the user's
 * email + Account link when logged in — so clicking a magic link visibly DOES
 * something. Renders nothing auth-related until /api/auth/me answers (no flash).
 */
export default function AuthNav({ ar = false }: { ar?: boolean }) {
  const [me, setMe] = useState<{ signedIn: boolean; email?: string; unlimited?: boolean } | null>(null);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then(setMe)
      .catch(() => setMe({ signedIn: false }));
  }, []);

  const pricingHref = ar ? "/ar#pricing" : "/#pricing";

  if (!me) return <span className="w-24" />; // reserve space, no flash

  if (me.signedIn) {
    return (
      <>
        <Link href="/account" className="flex items-center gap-2 text-sm" style={{ color: "var(--muted)" }}>
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: "var(--accent)" }} />
          <span className="max-w-40 truncate" dir="ltr">{me.email}</span>
        </Link>
        {me.unlimited ? (
          <Link href="/account" className="btn-ghost px-4 py-2 text-sm font-semibold" style={{ color: "var(--accent)" }}>
            {ar ? "غير محدود ✓" : "Unlimited ✓"}
          </Link>
        ) : (
          <a href={pricingHref} className="btn-accent px-4 py-2 text-sm">{ar ? "فتح غير محدود ←" : "Unlock unlimited →"}</a>
        )}
      </>
    );
  }

  return (
    <>
      <Link href="/login" className="text-sm" style={{ color: "var(--muted)" }}>{ar ? "تسجيل الدخول" : "Sign in"}</Link>
      <a href={pricingHref} className="btn-accent px-4 py-2 text-sm">{ar ? "فتح غير محدود ←" : "Unlock unlimited →"}</a>
    </>
  );
}
