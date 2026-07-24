"use client";
import { useState, useEffect } from "react";
import Link from "next/link";

/** Hamburger menu for small screens — the header's secondary links (which are
 *  hidden below `sm`) collapse into this, INCLUDING the session-aware Sign in /
 *  Account link that was otherwise unreachable on mobile. Positioned inside a
 *  `relative` wrapper so the dropdown anchors under the button reliably. */
export default function MobileMenu({ ar = false }: { ar?: boolean }) {
  const [open, setOpen] = useState(false);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => {
    fetch("/api/auth/me").then((r) => r.json()).then((d) => setSignedIn(!!d.signedIn)).catch(() => setSignedIn(false));
  }, []);

  const acct = ar
    ? (signedIn ? { href: "/account", label: "● حسابي" } : { href: "/login", label: "تسجيل الدخول" })
    : (signedIn ? { href: "/account", label: "● Account" } : { href: "/login", label: "Sign in" });

  const links = ar
    ? [
        { href: "/ar/optimize", label: "افحص سيرتك" },
        { href: "/ar/builder", label: "ابنِ سيرتك" },
        { href: "/ar#pricing", label: "الأسعار" },
        acct,
        { href: "/", label: "English" },
      ]
    : [
        { href: "/optimize", label: "Scan my resume" },
        { href: "/build", label: "CV Builder" },
        { href: "/#pricing", label: "Pricing" },
        acct,
        { href: "/ar", label: "عربي" },
      ];

  return (
    <div className="relative sm:hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Menu"
        aria-expanded={open}
        className="flex h-10 w-10 items-center justify-center rounded-lg"
        style={{ border: "1px solid var(--line)", background: "var(--surface)" }}
      >
        <div className="space-y-1.5">
          <span className="block h-0.5 w-5 rounded" style={{ background: "var(--fg)" }} />
          <span className="block h-0.5 w-5 rounded" style={{ background: "var(--fg)" }} />
          <span className="block h-0.5 w-5 rounded" style={{ background: "var(--fg)" }} />
        </div>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} style={{ background: "rgba(0,0,0,0.5)" }} />
          <div
            className={`absolute z-50 mt-3 min-w-52 rounded-xl p-2 ${ar ? "left-0" : "right-0"}`}
            style={{ background: "var(--surface)", border: "1px solid var(--line)", boxShadow: "0 20px 50px -15px rgba(0,0,0,0.7)" }}
          >
            {links.map((l) => (
              <Link
                key={l.href + l.label}
                href={l.href}
                onClick={() => setOpen(false)}
                className="block rounded-lg px-4 py-3 text-sm font-semibold"
                style={{ color: "var(--fg)" }}
              >
                {l.label}
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
