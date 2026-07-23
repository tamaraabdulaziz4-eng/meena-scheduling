"use client";
import { useMemo, useRef, useState } from "react";

/**
 * Visual, designed resume template with a live preview + a one-click designed
 * PDF export (html2canvas → jsPDF). The Arab market "buys with the eye", and
 * every major competitor ships styled templates — this is our answer.
 *
 * IMPORTANT: this designed PDF is a RASTER image, great for a human recruiter /
 * LinkedIn, but NOT ATS-parseable. The plain PdfExport/DocxExport remain the
 * ATS-safe downloads — we label them so the user picks the right one.
 *
 * Parses the plain-text CV (standard headings) into sections and lays them out
 * as a two-column A4 page. Uses explicit hex colors (not CSS vars) so the
 * off-screen html2canvas capture renders correctly regardless of site theme.
 */

interface Section { heading: string; lines: string[] }
interface Parsed { name: string; contact: string; sections: Section[] }

const HEADINGS = [
  "PROFESSIONAL SUMMARY", "SUMMARY", "PROFILE", "OBJECTIVE",
  "SKILLS", "CORE SKILLS", "TECHNICAL SKILLS",
  "EXPERIENCE", "WORK EXPERIENCE", "PROFESSIONAL EXPERIENCE", "EMPLOYMENT HISTORY",
  "EDUCATION", "CERTIFICATIONS", "CERTIFICATES", "LANGUAGES", "PROJECTS",
  "PERSONAL DETAILS", "PERSONAL INFORMATION", "ACHIEVEMENTS", "AWARDS", "REFERENCES",
];

function isHeading(line: string): boolean {
  const t = line.trim().replace(/:$/, "");
  if (t.length > 40) return false;
  if (HEADINGS.includes(t.toUpperCase())) return true;
  // A short ALL-CAPS line with no bullet is treated as a heading.
  return /^[A-Z][A-Z &/]{2,38}$/.test(t) && !t.includes("@");
}

function parse(text: string): Parsed {
  const raw = text.replace(/\r/g, "").split("\n");
  const nonEmpty = raw.map((l) => l.trimEnd());
  let i = 0;
  while (i < nonEmpty.length && !nonEmpty[i].trim()) i++;
  const name = (nonEmpty[i] || "Your Name").trim();
  i++;
  let contact = "";
  while (i < nonEmpty.length && !nonEmpty[i].trim()) i++;
  if (i < nonEmpty.length && !isHeading(nonEmpty[i])) { contact = nonEmpty[i].trim(); i++; }

  const sections: Section[] = [];
  let cur: Section | null = null;
  for (; i < nonEmpty.length; i++) {
    const line = nonEmpty[i];
    if (isHeading(line)) {
      cur = { heading: line.trim().replace(/:$/, "").toUpperCase(), lines: [] };
      sections.push(cur);
    } else if (cur) {
      cur.lines.push(line);
    } else if (line.trim()) {
      cur = { heading: "SUMMARY", lines: [line] };
      sections.push(cur);
    }
  }
  return { name, contact, sections };
}

const SIDEBAR = new Set(["SKILLS", "CORE SKILLS", "TECHNICAL SKILLS", "PERSONAL DETAILS", "PERSONAL INFORMATION", "LANGUAGES", "CERTIFICATIONS", "CERTIFICATES", "REFERENCES"]);

export type TemplateVariant = "classic" | "modern" | "minimal" | "elegant";

export default function ResumeTemplate({ text, name = "resume", accent = "#0f766e", variant = "classic", preview = false }: { text: string; name?: string; accent?: string; variant?: TemplateVariant; preview?: boolean }) {
  const parsed = useMemo(() => parse(text), [text]);
  const ref = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);

  const sidebar = parsed.sections.filter((s) => SIDEBAR.has(s.heading));
  const main = parsed.sections.filter((s) => !SIDEBAR.has(s.heading));

  // Per-variant styling — same parsed content, different visual treatment so the
  // gallery can offer genuinely distinct named templates (not just recolors).
  const sidebarRight = variant === "modern";
  const headerCentered = variant === "elegant";
  const flatHeader = variant === "minimal"; // white header, accent text
  const showSidebarBg = variant !== "minimal";
  const headerBg = flatHeader ? "#ffffff" : accent;
  const headerFg = flatHeader ? "#111827" : "#ffffff";

  async function downloadPdf() {
    if (!ref.current) return;
    setBusy(true);
    try {
      const [{ default: html2canvas }, { jsPDF }] = await Promise.all([import("html2canvas"), import("jspdf")]);
      const canvas = await html2canvas(ref.current, { scale: 2, backgroundColor: "#ffffff", useCORS: true });
      const img = canvas.toDataURL("image/jpeg", 0.95);
      const pdf = new jsPDF({ unit: "mm", format: "a4" });
      const pw = 210, ph = 297;
      const ih = (canvas.height * pw) / canvas.width;
      let heightLeft = ih, pos = 0;
      pdf.addImage(img, "JPEG", 0, pos, pw, ih);
      heightLeft -= ph;
      while (heightLeft > 0) {
        pos -= ph;
        pdf.addPage();
        pdf.addImage(img, "JPEG", 0, pos, pw, ih);
        heightLeft -= ph;
      }
      pdf.save(`${name || "resume"}-designed.pdf`);
    } catch {
      alert("تعذّر تنزيل القالب — استخدم تنزيل PDF النصي.\nCouldn't export the designed template — use the plain PDF.");
    } finally {
      setBusy(false);
    }
  }

  const renderLines = (lines: string[]) =>
    lines.filter((l) => l.trim()).map((l, idx) => {
      const bullet = /^[-•*]/.test(l.trim());
      const content = l.trim().replace(/^[-•*]\s*/, "");
      const subhead = !bullet && content.length < 70 && /[A-Za-z]/.test(content) && (/\d{4}/.test(content) || /\bat\b|—|–|\|/.test(content));
      if (bullet) return <li key={idx} style={{ marginBottom: 3, lineHeight: 1.45 }}>{content}</li>;
      return <div key={idx} style={{ fontWeight: subhead ? 700 : 400, marginTop: subhead ? 8 : 2, marginBottom: 2, lineHeight: 1.45, color: subhead ? "#111827" : "#374151" }}>{content}</div>;
    });

  const sidebarCol = (
    <div key="sb" style={{ width: 250, background: showSidebarBg ? "#f3f4f6" : "#ffffff", padding: "24px 22px", borderInlineEnd: showSidebarBg ? undefined : "1px solid #e5e7eb" }}>
      {sidebar.map((s) => (
        <div key={s.heading} style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: accent, letterSpacing: 1, textTransform: "uppercase", borderBottom: `2px solid ${accent}`, paddingBottom: 4, marginBottom: 8 }}>{s.heading}</div>
          <ul style={{ margin: 0, paddingInlineStart: 16, fontSize: 12.5 }}>{renderLines(s.lines)}</ul>
        </div>
      ))}
    </div>
  );
  const mainCol = (
    <div key="mn" style={{ flex: 1, padding: "24px 30px" }}>
      {main.map((s) => (
        <div key={s.heading} style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: "#111827", letterSpacing: 0.5, textTransform: "uppercase", borderBottom: `2px solid ${headerCentered ? accent : "#e5e7eb"}`, paddingBottom: 4, marginBottom: 8 }}>{s.heading}</div>
          <ul style={{ margin: 0, paddingInlineStart: 18, fontSize: 12.8 }}>{renderLines(s.lines)}</ul>
        </div>
      ))}
    </div>
  );

  return (
    <div>
      {!preview && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <button onClick={downloadPdf} disabled={busy} className="btn-accent px-5 py-2.5 text-sm font-bold disabled:opacity-50">
            {busy ? "…" : "↓ تنزيل القالب المصمّم (PDF)"}
          </button>
          <span className="text-xs" style={{ color: "var(--faint)" }}>نسخة مصمّمة للعرض — للـ ATS استخدم PDF/Word النصي</span>
        </div>
      )}

      {/* Live preview (also the capture source) */}
      <div className={preview ? "" : "overflow-x-auto rounded-xl"} style={preview ? undefined : { border: "1px solid var(--line)" }}>
        <div ref={ref} dir="ltr" style={{ width: 794, minHeight: 1123, background: "#ffffff", color: "#374151", fontFamily: "Arial, Helvetica, sans-serif", fontSize: 13 }}>
          {/* Header */}
          <div style={{ background: headerBg, color: headerFg, padding: "28px 36px", textAlign: headerCentered ? "center" : "start", borderBottom: flatHeader ? `3px solid ${accent}` : undefined }}>
            <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: 0.3, color: flatHeader ? accent : headerFg }}>{parsed.name}</div>
            {parsed.contact && <div style={{ marginTop: 8, fontSize: 12.5, opacity: 0.95 }}>{parsed.contact}</div>}
          </div>
          {/* Body: two columns (sidebar side depends on variant) */}
          <div style={{ display: "flex", alignItems: "stretch" }}>
            {sidebar.length === 0 ? mainCol : sidebarRight ? [mainCol, sidebarCol] : [sidebarCol, mainCol]}
          </div>
        </div>
      </div>
    </div>
  );
}
