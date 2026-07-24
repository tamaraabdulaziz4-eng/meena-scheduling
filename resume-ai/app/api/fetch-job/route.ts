import { NextRequest, NextResponse } from "next/server";
import { allow, clientIp } from "@/app/lib/ratelimit";

export const maxDuration = 20;

/**
 * Fetch a job-posting URL and return its readable text so mobile users can
 * paste a link instead of copying a long posting. Strips HTML to plain text.
 * SSRF-guarded: only public http(s) hosts, no internal/private targets.
 */

function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return true;
  // Raw IPs in private / loopback / link-local / metadata ranges.
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(h)) return true;
  if (h === "0.0.0.0" || h === "::1" || h === "[::1]") return true;
  return false;
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|br|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n").map((l) => l.trim()).filter(Boolean).join("\n")
    .trim();
}

export async function POST(req: NextRequest) {
  if (!allow(`fetchjob:${clientIp(req)}`, 20, 10 * 60 * 1000)) {
    return NextResponse.json({ error: "Too many requests. Please wait a minute." }, { status: 429 });
  }
  let body: { url?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }
  const raw = String(body?.url || "").trim();
  if (!raw) return NextResponse.json({ error: "URL required." }, { status: 400 });

  let url: URL;
  try { url = new URL(raw); } catch { return NextResponse.json({ error: "That doesn't look like a valid link." }, { status: 400 }); }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return NextResponse.json({ error: "Only http(s) links are supported." }, { status: 400 });
  }
  if (isBlockedHost(url.hostname)) {
    return NextResponse.json({ error: "That link can't be fetched." }, { status: 400 });
  }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch(url.toString(), {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; SiraBot/1.0)", Accept: "text/html,application/xhtml+xml" },
    }).finally(() => clearTimeout(timer));
    if (!res.ok) return NextResponse.json({ error: `Couldn't open the link (HTTP ${res.status}). Paste the text instead.` }, { status: 502 });
    const ctype = res.headers.get("content-type") || "";
    if (!ctype.includes("html") && !ctype.includes("text")) {
      return NextResponse.json({ error: "That link isn't a readable job page. Paste the text instead." }, { status: 415 });
    }
    const html = (await res.text()).slice(0, 500_000);
    const text = htmlToText(html).slice(0, 4000);
    if (text.length < 80) {
      return NextResponse.json({ error: "Couldn't read enough text from that link (some sites block bots). Paste the posting text instead." }, { status: 422 });
    }
    return NextResponse.json({ ok: true, text });
  } catch {
    return NextResponse.json({ error: "Couldn't fetch that link — paste the posting text instead." }, { status: 502 });
  }
}
