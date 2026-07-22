"use client";
import { useState } from "react";

/**
 * Generates a real downloadable PDF file (jsPDF, client-side) from the
 * plain-text CV — a direct .pdf download that works on iOS/Android too,
 * unlike the old hidden-iframe window.print() approach which silently did
 * nothing on mobile Safari. Layout: A4, name header, underlined section
 * headings, bullets, automatic wrapping + page breaks.
 */
export default function PdfExport({ text, label = "↓ Download PDF" }: { text: string; label?: string }) {
  const [busy, setBusy] = useState(false);

  async function exportPdf() {
    setBusy(true);
    try {
      const { jsPDF } = await import("jspdf");
      const doc = new jsPDF({ unit: "mm", format: "a4" });

      const M = 16; // side margin mm
      const W = 210 - M * 2; // usable width
      const BOTTOM = 281; // page break threshold
      let y = 18;

      const pageBreak = (needed: number) => {
        if (y + needed > BOTTOM) {
          doc.addPage();
          y = 18;
        }
      };

      const lines = text.split("\n");
      let first = true;
      let second = false;

      for (const raw of lines) {
        const line = raw.trim();
        if (!line) {
          y += 2.2;
          continue;
        }
        const isHeading =
          /^[A-Z][A-Z &/]{2,40}$/.test(line) ||
          /^(PROFESSIONAL SUMMARY|SKILLS|EXPERIENCE|EDUCATION|CERTIFICATIONS|PROJECTS|LANGUAGES)\b/i.test(line);

        if (first) {
          // Name header
          doc.setFont("helvetica", "bold");
          doc.setFontSize(19);
          const wrapped = doc.splitTextToSize(line, W);
          pageBreak(wrapped.length * 8);
          doc.text(wrapped, M, y);
          y += wrapped.length * 8 + 1;
          first = false;
          second = true;
          continue;
        }
        if (second && !isHeading) {
          // Contact line
          doc.setFont("helvetica", "normal");
          doc.setFontSize(9.5);
          doc.setTextColor(90);
          const wrapped = doc.splitTextToSize(line, W);
          pageBreak(wrapped.length * 4.5);
          doc.text(wrapped, M, y);
          y += wrapped.length * 4.5 + 1.5;
          doc.setTextColor(20);
          second = false;
          continue;
        }
        second = false;

        if (isHeading) {
          y += 3;
          pageBreak(9);
          doc.setFont("helvetica", "bold");
          doc.setFontSize(11.5);
          doc.setTextColor(20);
          doc.text(line.toUpperCase(), M, y);
          y += 1.6;
          doc.setDrawColor(30);
          doc.setLineWidth(0.35);
          doc.line(M, y, 210 - M, y);
          y += 4.6;
          continue;
        }

        const isBullet = /^[-•*]/.test(line);
        const content = isBullet ? line.replace(/^[-•*]\s*/, "") : line;
        doc.setFont("helvetica", "normal");
        doc.setFontSize(10.2);
        doc.setTextColor(25);
        const indent = isBullet ? 5 : 0;
        const wrapped = doc.splitTextToSize(content, W - indent);
        pageBreak(wrapped.length * 4.8);
        if (isBullet) doc.text("•", M + 1, y);
        doc.text(wrapped, M + indent, y);
        y += wrapped.length * 4.8 + 0.8;
      }

      doc.save("resume.pdf");
    } catch (e) {
      console.error("PDF export failed:", e);
      alert("Couldn't generate the PDF — please try the .txt download instead.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button onClick={exportPdf} disabled={busy} className="rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-60"
      style={{ background: "var(--accent)", color: "#05130a" }}>
      {busy ? "…" : label}
    </button>
  );
}
