"use client";
import { useState } from "react";

/** Share row — WhatsApp first (critical for MENA), plus X, LinkedIn, copy link. */
export default function ShareButtons({ url, text, ar = false }: { url: string; text: string; ar?: boolean }) {
  const [copied, setCopied] = useState(false);
  const enc = encodeURIComponent;
  const links = [
    { name: "WhatsApp", href: `https://wa.me/?text=${enc(text + " " + url)}`, bg: "#25D366", fg: "#053015" },
    { name: "X", href: `https://twitter.com/intent/tweet?text=${enc(text)}&url=${enc(url)}`, bg: "#1a1a1a", fg: "#fff" },
    { name: "LinkedIn", href: `https://www.linkedin.com/sharing/share-offsite/?url=${enc(url)}`, bg: "#0A66C2", fg: "#fff" },
  ];
  return (
    <div>
      <div className="mb-2 font-mono text-xs uppercase tracking-wider" style={{ color: "var(--faint)" }}>{ar ? "شارك نتيجتك" : "Share your score"}</div>
      <div className="flex flex-wrap justify-center gap-2">
        {links.map((l) => (
          <a key={l.name} href={l.href} target="_blank" rel="noopener noreferrer"
            className="rounded-lg px-4 py-2 text-sm font-semibold" style={{ background: l.bg, color: l.fg }}>
            {l.name}
          </a>
        ))}
        <button onClick={() => { navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1800); }}
          className="rounded-lg px-4 py-2 text-sm font-semibold" style={{ background: "var(--surface)", color: "var(--fg)", border: "1px solid var(--line)" }}>
          {copied ? (ar ? "✓ تم النسخ" : "✓ Copied") : (ar ? "نسخ الرابط" : "Copy link")}
        </button>
      </div>
    </div>
  );
}
