"use client";
import { useState } from "react";

/**
 * Generates a real downloadable PDF file (jsPDF, client-side) from the
 * plain-text CV — a direct .pdf download that works on iOS/Android too,
 * unlike the old hidden-iframe window.print() approach which silently did
 * nothing on mobile Safari. Layout: A4, name header, underlined section
 * headings, bullets, automatic wrapping + page breaks.
 */
export default function PdfExport({ text, label = "↓ Download PDF", watermark = false, lang = "en" }: { text: string; label?: string; watermark?: boolean; lang?: "en" | "ar" }) {
  const [busy, setBusy] = useState(false);

  async function exportPdf() {
    setBusy(true);
    try {
      // jsPDF's built-in fonts can't render Arabic — it comes out as mojibake
      // (þêþÌ…). The CV is meant to be 100% English; if Arabic slipped in,
      // stop and tell the user instead of producing a corrupted PDF.
      if (/[؀-ۿ]/.test(text)) {
        alert(
          "⚠ النص يحتوي كلمات عربية والـPDF يدعم الإنجليزية فقط حالياً — ستظهر مشوّهة.\n" +
          "أعد التوليد (السيرة يجب أن تكون إنجليزية بالكامل) أو استخدم تنزيل ‎.txt.\n\n" +
          "The text contains Arabic characters which this PDF can't render. Regenerate the CV (it should be fully English) or use the .txt download."
        );
        setBusy(false);
        return;
      }
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

      // splitTextToSize only wraps on spaces, so a single very long token
      // (email / URL in the contact line) overflows the page. Wrap word by
      // word and hard-break any token wider than the column into char chunks.
      // Assumes the caller has already set the font/size for measurement.
      const wrapBreaking = (s: string, maxW: number): string[] => {
        const out: string[] = [];
        let cur = "";
        for (const word of s.split(/\s+/).filter(Boolean)) {
          const cand = cur ? `${cur} ${word}` : word;
          if (doc.getTextWidth(cand) <= maxW) { cur = cand; continue; }
          if (cur) { out.push(cur); cur = ""; }
          if (doc.getTextWidth(word) <= maxW) { cur = word; continue; }
          let chunk = "";
          for (const ch of word) {
            if (chunk && doc.getTextWidth(chunk + ch) > maxW) { out.push(chunk); chunk = ch; }
            else chunk += ch;
          }
          cur = chunk;
        }
        if (cur) out.push(cur);
        return out.length ? out : [""];
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
          const wrapped = wrapBreaking(line, W);
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

      // Free downloads: stamp every page with a subtle "cv.rabit.sa" footer +
      // a faint diagonal watermark. Paying removes it entirely.
      if (watermark) {
        const pages = doc.getNumberOfPages();
        for (let p = 1; p <= pages; p++) {
          doc.setPage(p);
          doc.setFont("helvetica", "normal");
          doc.setFontSize(8);
          doc.setTextColor(150);
          // helvetica can't render Arabic glyphs — keep the footer Latin so it
          // never shows as boxes; the mark is the domain either way.
          doc.text(lang === "ar" ? "cv.rabit.sa — نسخة مجانية" : "Created free with cv.rabit.sa", 105, 290, { align: "center" });
          doc.setTextColor(232);
          doc.setFontSize(46);
          try {
            doc.text("cv.rabit.sa", 105, 160, { align: "center", angle: 32 } as Parameters<typeof doc.text>[3]);
          } catch { /* angle unsupported — footer alone is fine */ }
          doc.setTextColor(20);
        }
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
      style={{ background: "var(--accent)", color: "#ffffff" }}>
      {busy ? "…" : label}
    </button>
  );
}
