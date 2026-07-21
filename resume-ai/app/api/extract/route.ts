import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

/**
 * Accepts a PDF, DOCX, or TXT upload and returns its plain text so the
 * optimizer textarea can be auto-filled. Most people have their resume as a
 * file, not as copy-paste-able text — this removes the biggest friction point.
 */
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");

    if (!file || typeof file === "string") {
      return NextResponse.json({ error: "No file uploaded." }, { status: 400 });
    }

    const name = (file.name || "").toLowerCase();
    const buf = Buffer.from(await file.arrayBuffer());

    if (buf.length > 5 * 1024 * 1024) {
      return NextResponse.json({ error: "File too large (max 5 MB)." }, { status: 400 });
    }

    let text = "";

    if (name.endsWith(".pdf")) {
      const { extractText, getDocumentProxy } = await import("unpdf");
      const pdf = await getDocumentProxy(new Uint8Array(buf));
      const { text: t } = await extractText(pdf, { mergePages: true });
      text = Array.isArray(t) ? t.join("\n") : t;
    } else if (name.endsWith(".docx")) {
      const mammoth = (await import("mammoth")).default;
      const { value } = await mammoth.extractRawText({ buffer: buf });
      text = value;
    } else if (name.endsWith(".txt") || name.endsWith(".md")) {
      text = buf.toString("utf-8");
    } else {
      return NextResponse.json(
        { error: "Unsupported file type. Upload a PDF, DOCX, or TXT." },
        { status: 400 }
      );
    }

    // Collapse excessive whitespace the parsers sometimes emit.
    text = text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();

    if (!text || text.length < 20) {
      return NextResponse.json(
        { error: "Couldn't read any text from that file. If it's a scanned image, paste the text manually." },
        { status: 422 }
      );
    }

    // Keep within the optimizer's input budget.
    if (text.length > 8000) text = text.slice(0, 8000);

    return NextResponse.json({ text });
  } catch (err) {
    console.error("Extract error:", err);
    return NextResponse.json({ error: "Failed to read the file. Try pasting the text instead." }, { status: 500 });
  }
}
