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

// Arabic section headings (Modern Standard Arabic) so RTL and bilingual resumes
// parse into the same sections as English ones.
const HEADINGS_AR = [
  "الملخص المهني", "الملخص", "نبذة", "الهدف الوظيفي",
  "المهارات", "المهارات الأساسية", "المهارات التقنية",
  "الخبرة", "الخبرة العملية", "الخبرات", "التاريخ الوظيفي",
  "التعليم", "المؤهلات", "الشهادات", "اللغات", "المشاريع",
  "البيانات الشخصية", "المعلومات الشخصية", "الإنجازات", "الجوائز", "المراجع",
];

function isHeading(line: string): boolean {
  // Bilingual headings look like "EXPERIENCE · الخبرة" — test each side.
  const parts = line.split(/[·|/–—-]/).map((p) => p.trim()).filter(Boolean);
  const candidates = parts.length > 1 ? [line.trim(), ...parts] : [line.trim()];
  for (const c of candidates) {
    const t = c.replace(/:$/, "").trim();
    if (t.length > 42) continue;
    if (HEADINGS.includes(t.toUpperCase())) return true;
    if (HEADINGS_AR.includes(t)) return true;
    // A short ALL-CAPS Latin line with no bullet/email is a heading.
    if (/^[A-Z][A-Z &/]{2,38}$/.test(t) && !t.includes("@")) return true;
  }
  return false;
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

// "column" is the research-backed ATS-optimal single-column layout; the others
// are two-column designs for human/LinkedIn use.
export type TemplateVariant = "classic" | "modern" | "minimal" | "elegant" | "column";

export default function ResumeTemplate({ text, name = "resume", accent = "#0f766e", variant = "classic", preview = false, dir = "ltr" }: { text: string; name?: string; accent?: string; variant?: TemplateVariant; preview?: boolean; dir?: "ltr" | "rtl" }) {
  const parsed = useMemo(() => parse(text), [text]);
  const ref = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);

  const sidebar = parsed.sections.filter((s) => SIDEBAR.has(s.heading));
  const main = parsed.sections.filter((s) => !SIDEBAR.has(s.heading));

  // Per-variant styling — same parsed content, different visual treatment so the
  // gallery can offer genuinely distinct named templates (not just recolors).
  const singleColumn = variant === "column";
  const sidebarRight = variant === "modern";
  const headerCentered = variant === "elegant" || singleColumn;
  const flatHeader = variant === "minimal" || singleColumn; // white header, accent text
  const showSidebarBg = variant !== "minimal";
  const headerBg = flatHeader ? "#ffffff" : accent;
  const headerFg = flatHeader ? "#111827" : "#ffffff";
  const isRtl = dir === "rtl";

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

  // Research-backed ATS-optimal layout: one column, all sections stacked in
  // reverse-chronological order, a single accent rule under each heading.
  const singleColBody = (
    <div style={{ padding: "20px 40px 32px" }}>
      {parsed.sections.map((s) => (
        <div key={s.heading} style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13.5, fontWeight: 800, color: accent, letterSpacing: 0.8, textTransform: "uppercase", borderBottom: `1.5px solid ${accent}`, paddingBottom: 3, marginBottom: 7 }}>{s.heading}</div>
          <ul style={{ margin: 0, paddingInlineStart: 18, fontSize: 12.8, listStyleType: SIDEBAR.has(s.heading) ? "none" : undefined }}>{renderLines(s.lines)}</ul>
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

      {/* Live preview (also the capture source). dir drives RTL for Arabic;
          the contact line stays LTR so phone/email/dates read correctly. */}
      <div className={preview ? "" : "overflow-x-auto rounded-xl"} style={preview ? undefined : { border: "1px solid var(--line)" }}>
        <div ref={ref} dir={dir} lang={isRtl ? "ar" : undefined} style={{ width: 794, minHeight: 1123, background: "#ffffff", color: "#374151", fontFamily: isRtl ? "'Segoe UI', Tahoma, Arial, sans-serif" : "Arial, Helvetica, sans-serif", fontSize: 13, textAlign: isRtl ? "right" : "left" }}>
          {/* Header */}
          <div style={{ background: headerBg, color: headerFg, padding: "28px 36px", textAlign: headerCentered ? "center" : "start", borderBottom: flatHeader ? `3px solid ${accent}` : undefined }}>
            <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: 0.3, color: flatHeader ? accent : headerFg }}>{parsed.name}</div>
            {parsed.contact && <div dir="ltr" style={{ marginTop: 8, fontSize: 12.5, opacity: 0.95, textAlign: isRtl ? "right" : "left", unicodeBidi: "plaintext" }}>{parsed.contact}</div>}
          </div>
          {/* Body: single-column (ATS) or two-column (sidebar side depends on variant + direction) */}
          {singleColumn ? singleColBody : (
            <div style={{ display: "flex", alignItems: "stretch" }}>
              {sidebar.length === 0 ? mainCol : sidebarRight ? [mainCol, sidebarCol] : [sidebarCol, mainCol]}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
