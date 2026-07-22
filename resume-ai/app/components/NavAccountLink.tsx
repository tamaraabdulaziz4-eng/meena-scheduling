"use client";
import { useEffect, useState } from "react";
import Link from "next/link";

/** Compact session-aware nav link: "Sign in" when logged out, "● Account" when in. */
export default function NavAccountLink({ ar = false }: { ar?: boolean }) {
  const [me, setMe] = useState<{ signedIn: boolean } | null>(null);

  useEffect(() => {
    fetch("/api/auth/me").then((r) => r.json()).then(setMe).catch(() => setMe({ signedIn: false }));
  }, []);

  if (!me) return null;
  return me.signedIn ? (
    <Link href="/account" className="hidden items-center gap-1.5 text-sm sm:flex" style={{ color: "var(--accent)" }}>
      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: "var(--accent)" }} />
      {ar ? "حسابي" : "Account"}
    </Link>
  ) : (
    <Link href="/login" className="hidden text-sm sm:block" style={{ color: "var(--muted)" }}>
      {ar ? "تسجيل الدخول" : "Sign in"}
    </Link>
  );
}
