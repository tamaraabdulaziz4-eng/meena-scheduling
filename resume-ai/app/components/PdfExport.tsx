"use client";

/**
 * Renders a plain-text CV into a clean A4 print layout in a hidden iframe and
 * triggers the browser's print-to-PDF. Zero dependencies, ATS-safe output
 * (real text, single column, standard headings).
 */
export default function PdfExport({ text, label = "↓ Download PDF" }: { text: string; label?: string }) {
  function exportPdf() {
    const lines = text.split("\n");
    // Heuristic: ALL-CAPS short lines (or known headings) become section headers.
    const html = lines
      .map((raw) => {
        const line = raw.trimEnd();
        if (!line.trim()) return "<div class='gap'></div>";
        const isHeading =
          /^[A-Z][A-Z &/]{2,40}$/.test(line.trim()) ||
          /^(PROFESSIONAL SUMMARY|SKILLS|EXPERIENCE|EDUCATION|CERTIFICATIONS|PROJECTS|LANGUAGES)\b/i.test(line.trim());
        const esc = line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        if (isHeading) return `<h2>${esc}</h2>`;
        if (/^\s*[-•]/.test(line)) return `<li>${esc.replace(/^\s*[-•]\s*/, "")}</li>`;
        return `<p>${esc}</p>`;
      })
      .join("");

    const doc = `<!doctype html><html><head><meta charset="utf-8"><title>CV</title><style>
      @page { size: A4; margin: 18mm 16mm; }
      * { box-sizing: border-box; }
      body { font-family: 'Calibri','Segoe UI',Arial,sans-serif; color: #1a1a1a; font-size: 10.5pt; line-height: 1.45; margin: 0; }
      p { margin: 1px 0; }
      p:first-child { font-size: 17pt; font-weight: 700; letter-spacing: 0.02em; margin-bottom: 2px; }
      p:nth-child(2) { color: #444; font-size: 9.5pt; }
      h2 { font-size: 11pt; letter-spacing: 0.08em; border-bottom: 1.2px solid #1a1a1a; padding-bottom: 2px; margin: 12px 0 5px; }
      li { margin: 2px 0 2px 14px; padding-left: 2px; }
      .gap { height: 5px; }
    </style></head><body>${html}</body></html>`;

    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed";
    iframe.style.right = "100%";
    document.body.appendChild(iframe);
    const idoc = iframe.contentDocument!;
    idoc.open();
    idoc.write(doc);
    idoc.close();
    iframe.onload = () => {
      iframe.contentWindow?.print();
      setTimeout(() => document.body.removeChild(iframe), 2000);
    };
  }

  return (
    <button onClick={exportPdf} className="rounded-lg px-4 py-2 text-sm font-semibold"
      style={{ background: "var(--accent)", color: "#05130a" }}>
      {label}
    </button>
  );
}
