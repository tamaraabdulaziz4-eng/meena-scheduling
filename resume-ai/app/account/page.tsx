"use client";

import { useEffect, useState, Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

interface Me {
  signedIn: boolean;
  email?: string;
  unlimited?: boolean;
  until?: number;
}

function AccountInner() {
  const router = useRouter();
  const welcome = useSearchParams().get("welcome") === "1";
  // Strip the flag from the URL so refresh/bookmark doesn't re-show the banner.
  useEffect(() => {
    if (welcome) router.replace("/account", { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [signingOut, setSigningOut] = useState(false);
  const [links, setLinks] = useState<{ slug: string; url: string; token: string; created?: string }[]>([]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("ra_published");
      if (raw) setLinks(JSON.parse(raw));
    } catch { /* noop */ }
  }, []);

  async function removeLink(slug: string, token: string) {
    try {
      await fetch(`/api/publish?slug=${encodeURIComponent(slug)}&token=${encodeURIComponent(token)}`, { method: "DELETE" });
    } catch { /* best-effort */ }
    const next = links.filter((l) => l.slug !== slug);
    setLinks(next);
    try { localStorage.setItem("ra_published", JSON.stringify(next)); } catch { /* noop */ }
  }

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => setMe(d))
      .catch(() => setMe({ signedIn: false }))
      .finally(() => setLoading(false));
  }, []);

  async function signOut() {
    setSigningOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      router.push("/");
      router.refresh();
    } finally {
      setSigningOut(false);
    }
  }

  const until = me?.until && me.until > Date.now() ? new Date(me.until) : null;

  return (
    <main className="min-h-screen" style={{ background: "var(--bg)", color: "var(--fg)" }}>
      <nav className="sticky top-0 z-50 backdrop-blur" style={{ background: "rgba(8,9,10,0.7)", borderBottom: "1px solid var(--line)" }}>
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg font-mono text-sm font-bold" style={{ background: "var(--accent)", color: "#05130a" }}>R</div>
            <span className="text-[15px] font-bold tracking-tight">ResumeAI</span>
          </Link>
          <Link href="/optimize" className="text-sm" style={{ color: "var(--muted)" }}>Optimize a resume →</Link>
        </div>
      </nav>

      <div className="mx-auto max-w-lg px-6 py-16">
        {loading ? (
          <div className="text-center" style={{ color: "var(--muted)" }}>Loading your account…</div>
        ) : !me?.signedIn ? (
          <div className="card p-8 text-center">
            <div className="chip mb-4">● Not signed in</div>
            <h1 className="text-2xl font-bold">You&apos;re not signed in</h1>
            <p className="mx-auto mt-2 max-w-sm text-sm" style={{ color: "var(--muted)" }}>
              Sign in with a magic link to see your plan and access. If you&apos;ve paid, use the same email you paid with.
            </p>
            <Link href="/login" className="btn-accent mt-6 inline-block px-8 py-3">Sign in →</Link>
          </div>
        ) : (
          <div className="card p-8">
            {welcome && (
              <div className="mb-5 rounded-xl px-4 py-3 text-sm font-semibold"
                style={{ background: "rgba(74,222,128,0.1)", border: "1px solid rgba(74,222,128,0.35)", color: "var(--accent)" }}>
                ✓ You&apos;re signed in — welcome back!
              </div>
            )}
            <div className="chip mb-4">● My account</div>
            <h1 className="text-2xl font-bold">Account</h1>

            <dl className="mt-6 space-y-4">
              <div className="flex items-center justify-between border-b pb-3" style={{ borderColor: "var(--line)" }}>
                <dt className="text-sm" style={{ color: "var(--faint)" }}>Email</dt>
                <dd className="text-sm font-medium">{me.email}</dd>
              </div>
              <div className="flex items-center justify-between border-b pb-3" style={{ borderColor: "var(--line)" }}>
                <dt className="text-sm" style={{ color: "var(--faint)" }}>Plan</dt>
                <dd className="text-sm font-medium" style={{ color: me.unlimited ? "var(--accent)" : "var(--muted)" }}>
                  {me.unlimited ? "Unlimited — active" : "Free"}
                </dd>
              </div>
              {until && (
                <div className="flex items-center justify-between border-b pb-3" style={{ borderColor: "var(--line)" }}>
                  <dt className="text-sm" style={{ color: "var(--faint)" }}>Access until</dt>
                  <dd className="text-sm font-medium">{until.toLocaleDateString()} {until.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</dd>
                </div>
              )}
            </dl>

            {!me.unlimited && (
              <Link href="/#pricing" className="btn-accent mt-6 block w-full py-3 text-center">Unlock unlimited →</Link>
            )}

            {links.length > 0 && (
              <div className="mt-8">
                <h2 className="mb-3 text-sm font-bold" style={{ color: "var(--muted)" }}>My public resume links</h2>
                <ul className="space-y-2">
                  {links.map((l) => (
                    <li key={l.slug} className="flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid var(--line)" }}>
                      <a href={l.url} target="_blank" rel="noopener noreferrer" className="truncate text-accent" dir="ltr">{l.url}</a>
                      <button onClick={() => removeLink(l.slug, l.token)} className="shrink-0 text-xs" style={{ color: "#f87171" }}>Unpublish</button>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs" style={{ color: "var(--faint)" }}>Links are remembered on this device.</p>
              </div>
            )}

            <button
              onClick={signOut}
              disabled={signingOut}
              className="btn-ghost mt-3 block w-full py-3 text-center text-sm font-semibold disabled:opacity-50"
              style={{ color: "var(--fg)" }}>
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
          </div>
        )}
      </div>
    </main>
  );
}

export default function AccountPage() {
  return (
    <Suspense fallback={<main className="min-h-screen" style={{ background: "var(--bg)" }} />}>
      <AccountInner />
    </Suspense>
  );
}
