import { NextRequest, NextResponse } from "next/server";
import { savePublicResume, makeSlug, publicResumeConfigured } from "@/app/lib/publicresume";

export const maxDuration = 20;

/** Publishes a resume to a public shareable URL /r/{slug}. */
export async function POST(req: NextRequest) {
  try {
    if (!publicResumeConfigured()) {
      return NextResponse.json({ error: "Public links aren't available right now." }, { status: 503 });
    }
    const { name, role, text } = await req.json();
    if (!text || String(text).trim().length < 50) {
      return NextResponse.json({ error: "Nothing to publish yet." }, { status: 400 });
    }
    const rand = Math.random().toString(36).slice(2, 7);
    const slug = makeSlug(String(name || "resume"), rand);
    await savePublicResume(slug, {
      name: String(name || "").slice(0, 100),
      role: String(role || "").slice(0, 120),
      text: String(text).slice(0, 12000),
      created: Date.now(),
    });
    return NextResponse.json({ slug, url: `/r/${slug}` });
  } catch (err) {
    console.error("Publish error:", err);
    return NextResponse.json({ error: "Could not publish. Please try again." }, { status: 500 });
  }
}
