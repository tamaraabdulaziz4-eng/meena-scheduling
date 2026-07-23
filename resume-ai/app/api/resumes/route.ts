import { NextRequest, NextResponse } from "next/server";
import { readSession, SESSION_COOKIE } from "@/app/lib/session";
import { listUserCVs, saveUserCV, deleteUserCV, cvStoreConfigured } from "@/app/lib/cvstore";

export const maxDuration = 20;

/** The signed-in email, or null. All routes here require an account. */
function caller(req: NextRequest): string | null {
  return readSession(req.cookies.get(SESSION_COOKIE)?.value, Date.now());
}

export async function GET(req: NextRequest) {
  const email = caller(req);
  if (!email) return NextResponse.json({ ok: false, signedIn: false, cvs: [] });
  if (!cvStoreConfigured()) return NextResponse.json({ ok: true, signedIn: true, cvs: [], store: false });
  try {
    return NextResponse.json({ ok: true, signedIn: true, cvs: await listUserCVs(email) });
  } catch {
    return NextResponse.json({ ok: false, signedIn: true, cvs: [] }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const email = caller(req);
  if (!email) return NextResponse.json({ ok: false, signedIn: false, error: "Sign in to save to your account." }, { status: 401 });
  if (!cvStoreConfigured()) return NextResponse.json({ ok: false, error: "Cloud save is not configured." }, { status: 501 });
  let body: { title?: string; text?: string; source?: string; savedAt?: number; id?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 }); }
  if (!body.text?.trim() || !body.title?.trim()) return NextResponse.json({ ok: false, error: "title and text are required" }, { status: 400 });
  try {
    const cvs = await saveUserCV(email, {
      id: body.id, title: body.title, text: body.text, source: body.source,
      savedAt: typeof body.savedAt === "number" ? body.savedAt : Date.now(),
    });
    return NextResponse.json({ ok: true, cvs });
  } catch {
    return NextResponse.json({ ok: false, error: "Couldn't save — try again." }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const email = caller(req);
  if (!email) return NextResponse.json({ ok: false, signedIn: false }, { status: 401 });
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, cvs: await deleteUserCV(email, id) });
  } catch {
    return NextResponse.json({ ok: false, error: "Couldn't delete — try again." }, { status: 500 });
  }
}
