"use client";
import { useState } from "react";

/** Publishes the given resume text to a public /r/{slug} link and shows it
 *  with a copy button — turns every user into a distributor (each public
 *  page carries "Built with ResumeAI"). */
export default function PublishLink({ text, name, role }: { text: string; name?: string; role?: string }) {
  const [url, setUrl] = useState("");
  const [slug, setSlug] = useState("");
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  async function publish() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, name, role }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setUrl(`${window.location.origin}${data.url}`);
      setSlug(data.slug || "");
      setToken(data.unpublishToken || "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not publish.");
    } finally {
      setLoading(false);
    }
  }

  async function unpublish() {
    if (!slug || !token) return;
    setLoading(true);
    try {
      await fetch(`/api/publish?slug=${encodeURIComponent(slug)}&token=${encodeURIComponent(token)}`, { method: "DELETE" });
      setUrl("");
      setSlug("");
      setToken("");
    } catch {
      setError("Could not unpublish.");
    } finally {
      setLoading(false);
    }
  }

  if (url) {
    return (
      <div className="card mt-6 p-5" style={{ borderColor: "rgba(74,222,128,0.4)" }}>
        <div className="mb-2 font-mono text-xs uppercase tracking-wider" style={{ color: "var(--faint)" }}>Your public resume link</div>
        <div className="flex flex-wrap items-center gap-2">
          <a href={url} target="_blank" rel="noopener noreferrer" className="flex-1 truncate text-sm text-accent">{url}</a>
          <button onClick={() => { navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1800); }}
            className="rounded-lg px-4 py-2 text-sm font-semibold" style={{ background: "var(--accent)", color: "#05130a" }}>
            {copied ? "✓ Copied" : "Copy link"}
          </button>
        </div>
        <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>Share this with recruiters or on LinkedIn — no PDF needed.</p>
        {token && (
          <button onClick={unpublish} disabled={loading} className="mt-2 text-xs disabled:opacity-50" style={{ color: "var(--faint)" }}>
            {loading ? "Removing…" : "Unpublish this link"}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="mt-4 text-center">
      <button onClick={publish} disabled={loading} className="btn-ghost px-6 py-2.5 text-sm font-semibold disabled:opacity-50" style={{ color: "var(--fg)" }}>
        {loading ? "Publishing…" : "🔗 Get a shareable link"}
      </button>
      {error && <p className="mt-2 text-xs" style={{ color: "#f87171" }}>{error}</p>}
    </div>
  );
}
