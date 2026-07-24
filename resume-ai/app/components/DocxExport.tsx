"use client";
import { useState } from "react";

/**
 * Real .docx (Microsoft Word) export from the plain-text CV — a competitive
 * gap vs StylingCV/Enhancv, and heavily requested in the Gulf where employers
 * ask for an editable Word file. Unlike our jsPDF export, docx renders Arabic
 * correctly (RTL-aware), so this doubles as the Arabic-safe download path.
 * Client-side via the `docx` library (dynamic import → no SSR weight).
 */
export default function DocxExport({ text, label = "↓ Word (.docx)", filename = "resume.docx", watermark = false, lang = "en" }: { text: string; label?: string; filename?: string; watermark?: boolean; lang?: "en" | "ar" }) {
  const [busy, setBusy] = useState(false);

  async function exportDocx() {
    setBusy(true);
    try {
      const { Document, Packer, Paragraph, TextRun, AlignmentType, Footer } = await import("docx");
      const hasArabic = /[؀-ۿ]/.test(text);
      const lines = text.replace(/\r/g, "").split("\n");

      // Heuristic: the first non-empty line is the name; ALL-CAPS or short
      // colon-free lines that look like section headings get bolded/larger.
      let nameUsed = false;
      const paragraphs = lines.map((raw) => {
        const line = raw.trimEnd();
        if (!line.trim()) return new Paragraph({ text: "" });

        const bidi = /[؀-ۿ]/.test(line);
        const align = bidi ? AlignmentType.RIGHT : AlignmentType.LEFT;

        if (!nameUsed && line.trim()) {
          nameUsed = true;
          return new Paragraph({
            alignment: align, bidirectional: bidi,
            children: [new TextRun({ text: line.trim(), bold: true, size: 32 })],
          });
        }
        // Section heading: a short line, no bullet, mostly heading-like.
        const isHeading = line.length < 40 && !/^[-•*]/.test(line.trim()) && !line.includes("@") && /[A-Za-z؀-ۿ]/.test(line) && line === line.toUpperCase() && line.length > 2;
        if (isHeading) {
          return new Paragraph({
            alignment: align, bidirectional: bidi, spacing: { before: 200, after: 80 },
            children: [new TextRun({ text: line.trim(), bold: true, size: 24 })],
          });
        }
        return new Paragraph({
          alignment: align, bidirectional: bidi,
          children: [new TextRun({ text: line, size: 22 })],
        });
      });

      // Free downloads carry a subtle footer watermark; paying removes it.
      const footers = watermark
        ? {
            default: new Footer({
              children: [new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: lang === "ar" ? "أُنشئت مجاناً عبر cv.rabit.sa" : "Created free with cv.rabit.sa", size: 14, color: "9AA0A6" })],
              })],
            }),
          }
        : undefined;

      const doc = new Document({
        styles: { default: { document: { run: { font: hasArabic ? "Arial" : "Calibri" } } } },
        sections: [{ properties: {}, children: paragraphs, ...(footers ? { footers } : {}) }],
      });

      const blob = await Packer.toBlob(doc);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      alert("تعذّر إنشاء ملف Word — حاول مرة أخرى.\nCouldn't generate the Word file — please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={exportDocx}
      disabled={busy}
      className="rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
      style={{ background: "rgba(139,92,246,0.12)", color: "var(--accent)", border: "1px solid rgba(139,92,246,0.3)" }}
    >
      {busy ? "…" : label}
    </button>
  );
}
