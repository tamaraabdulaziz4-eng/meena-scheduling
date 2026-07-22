import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { savePublicResume, deletePublicResume, makeSlug, publicResumeConfigured } from "@/app/lib/publicresume";

export const maxDuration = 20;

const SECRET = process.env.ACCESS_SECRET || "dev-insecure-secret-change-me";

/** A signed token that proves the caller published this slug, so only they can unpublish it. */
function unpublishToken(slug: string): string {
  return crypto.createHmac("sha256", SECRET).update("unpublish:" + slug).digest("base64url");
}

/** Reject obvious spam: too many links is the #1 abuse signal for an open publish endpoint. */
function looksLikeSpam(text: string): boolean {
  const links = (text.match(/https?:\/\/|www\./gi) || []).length;
  return links > 6;
}

/** Publishes a resume to a public shareable URL /r/{slug}. */
export async function POST(req: NextRequest) {
  try {
    if (!publicResumeConfigured()) {
      return NextResponse.json({ error: "Public links aren't available right now." }, { status: 503 });
    }
    const { name, role, text } = await req.json();
    const body = String(text ?? "");
    if (!body || body.trim().length < 50) {
      return NextResponse.json({ error: "Nothing to publish yet." }, { status: 400 });
    }
    if (body.length > 12000) {
      return NextResponse.json({ error: "That's too long to publish." }, { status: 400 });
    }
    if (looksLikeSpam(body)) {
      return NextResponse.json({ error: "This content can't be published." }, { status: 400 });
    }
    // 10 random chars (was 5) — makes published URLs practically non-enumerable.
    const rand = crypto.randomBytes(8).toString("base64url").slice(0, 10).toLowerCase();
    const slug = makeSlug(String(name || "resume"), rand);
    await savePublicResume(slug, {
      name: String(name || "").slice(0, 100),
      role: String(role || "").slice(0, 120),
      text: body.slice(0, 12000),
      created: Date.now(),
    });
    // Return an unpublish token so the creator (and only the creator) can remove it later.
    return NextResponse.json({ slug, url: `/r/${slug}`, unpublishToken: unpublishToken(slug) });
  } catch (err) {
    console.error("Publish error:", err);
    return NextResponse.json({ error: "Could not publish. Please try again." }, { status: 500 });
  }
}

/** Unpublish a resume: requires the signed token returned at publish time. */
export async function DELETE(req: NextRequest) {
  try {
    if (!publicResumeConfigured()) {
      return NextResponse.json({ error: "Not available." }, { status: 503 });
    }
    const slug = req.nextUrl.searchParams.get("slug") || "";
    const token = req.nextUrl.searchParams.get("token") || "";
    if (!slug || !token) {
      return NextResponse.json({ error: "Missing slug or token." }, { status: 400 });
    }
    const expected = unpublishToken(slug);
    // Constant-time compare to avoid leaking the token via timing.
    const ok = token.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
    if (!ok) {
      return NextResponse.json({ error: "Invalid unpublish token." }, { status: 403 });
    }
    await deletePublicResume(slug);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Unpublish error:", err);
    return NextResponse.json({ error: "Could not unpublish." }, { status: 500 });
  }
}
