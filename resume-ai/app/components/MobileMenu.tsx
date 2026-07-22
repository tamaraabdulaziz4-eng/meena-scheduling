"use client";
import { useState } from "react";
import Link from "next/link";

/** Hamburger menu for small screens — the header's secondary links collapse
 *  into this on mobile (audit: links vanished with no fallback). */
export default function MobileMenu({ ar = false }: { ar?: boolean }) {
  const [open, setOpen] = useState(false);
  const links = ar
    ? [
        { href: "/ar/optimize", label: "افحص سيرتك" },
        { href: "/ar/builder", label: "ابنِ سيرتك ✨" },
        { href: "/ar#pricing", label: "الأسعار" },
        { href: "/account", label: "حسابي" },
        { href: "/", label: "English" },
      ]
    : [
        { href: "/optimize", label: "Scan my resume" },
        { href: "/build", label: "CV Builder" },
        { href: "/#pricing", label: "Pricing" },
        { href: "/account", label: "Account" },
        { href: "/ar", label: "عربي" },
      ];

  return (
    <div className="sm:hidden">
      <button onClick={() => setOpen((v) => !v)} aria-label="Menu" className="flex h-9 w-9 items-center justify-center rounded-lg" style={{ border: "1px solid var(--line)" }}>
        <div className="space-y-1">
          <span className="block h-0.5 w-5 rounded" style={{ background: "var(--fg)" }} />
          <span className="block h-0.5 w-5 rounded" style={{ background: "var(--fg)" }} />
          <span className="block h-0.5 w-5 rounded" style={{ background: "var(--fg)" }} />
        </div>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} style={{ background: "rgba(0,0,0,0.5)" }} />
          <div className="absolute z-50 mt-3 min-w-44 rounded-xl p-2"
            style={{ [ar ? "left" : "right"]: "1.5rem", background: "var(--surface)", border: "1px solid var(--line)", boxShadow: "0 20px 50px -15px rgba(0,0,0,0.7)" }}>
            {links.map((l) => (
              <Link key={l.href} href={l.href} onClick={() => setOpen(false)} className="block rounded-lg px-4 py-2.5 text-sm font-semibold" style={{ color: "var(--fg)" }}>
                {l.label}
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
