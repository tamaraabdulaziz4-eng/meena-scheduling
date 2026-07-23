"use client";
import { useEffect, useMemo, useRef, useState } from "react";

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
  // Models sometimes bury the contact line (email/phone) further down the
  // header block or inside the summary — pull the first line that looks like
  // contact info out of the top of the document so it renders under the name,
  // not mid-section.
  const looksContact = (s: string) => /@|(\+?\d[\d\s()-]{6,})/.test(s) && s.length < 160;
  if (!looksContact(contact)) {
    for (let k = i; k < Math.min(i + 10, nonEmpty.length); k++) {
      const cand = nonEmpty[k].trim();
      if (cand && !isHeading(cand) && looksContact(cand)) {
        contact = contact ? contact : cand;
        nonEmpty.splice(k, 1);
        break;
      }
    }
  }

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

// ALL variants are single-column: research consensus (Jobscan, Resume.io, and
// every 2026 ATS formatting guide) is that multi-column layouts, tables, and
// sidebars get scrambled by parsers. Variants differ in typography and header
// treatment only — the structure underneath is identical and ATS-safe:
// standard headings, reverse-chronological, 10-12pt body, 0.5-1in margins.
export type TemplateVariant = "classic" | "modern" | "minimal" | "elegant" | "column";

// A CV pasted or generated in English must render LTR even inside the Arabic
// UI (and vice versa) — the page language says nothing about the CV language.
// Majority script of the content decides the layout direction.
export function detectDir(text: string): "ltr" | "rtl" {
  const sample = text.slice(0, 1200);
  const arabic = (sample.match(/[؀-ۿ]/g) || []).length;
  const latin = (sample.match(/[A-Za-z]/g) || []).length;
  return arabic > latin ? "rtl" : "ltr";
}

export default function ResumeTemplate({ text, name = "resume", accent = "#0f766e", variant = "classic", preview = false, dir = "auto", fitWidth = false }: { text: string; name?: string; accent?: string; variant?: TemplateVariant; preview?: boolean; dir?: "ltr" | "rtl" | "auto"; fitWidth?: boolean }) {
  const parsed = useMemo(() => parse(text), [text]);
  const ref = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  // Scale the A4-width (794px) page down to fit the container so the preview is
  // never cropped on mobile; PDF capture still uses the full-res `ref`.
  const [fit, setFit] = useState(1);
  const [pageH, setPageH] = useState(0);
  useEffect(() => {
    if (!fitWidth) return;
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      setFit(Math.min(1, el.clientWidth / 794));
      if (ref.current) setPageH(ref.current.scrollHeight);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitWidth, text, variant, dir]);

  const isRtl = (dir === "auto" ? detectDir(text) : dir) === "rtl";

  // Per-variant typography (structure is identical & ATS-safe in all of them).
  const headerCentered = variant === "elegant";
  const serif = variant === "elegant";
  const strict = variant === "column"; // "ATS Pro": zero decoration beyond bold + rules

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
      const subhead = !bullet && content.length < 70 && /[A-Za-z؀-ۿ]/.test(content) && (/\d{4}/.test(content) || /\bat\b|—|–|\|/.test(content));
      if (bullet) return <li key={idx} style={{ marginBottom: 4, lineHeight: 1.5 }}>{content}</li>;
      return <div key={idx} style={{ fontWeight: subhead ? 700 : 400, marginTop: subhead ? 10 : 2, marginBottom: 2, lineHeight: 1.5, color: subhead ? "#111827" : "#374151" }}>{content}</div>;
    });

  // Per-variant section-heading treatment. Same 13-14px bold uppercase base
  // (≈12pt — the recruiter-preferred heading size); only the rule/accent moves.
  const sectionHeadingStyle: React.CSSProperties = {
    fontSize: 14,
    fontWeight: 700,
    letterSpacing: serif ? 2 : 1,
    textTransform: "uppercase",
    marginBottom: 8,
    color: strict || variant === "minimal" ? "#111827" : variant === "modern" ? accent : "#111827",
    fontFamily: serif ? "Georgia, 'Times New Roman', serif" : undefined,
    ...(variant === "modern"
      ? { borderInlineStart: `4px solid ${accent}`, paddingInlineStart: 10 }
      : { paddingBottom: 4, borderBottom: variant === "classic" ? `2px solid ${accent}` : serif ? `1px solid #9ca3af` : `1.5px solid #d1d5db` }),
  };

  // Single-column body — the only structure every ATS parses reliably.
  // ~64px side padding ≈ 0.85in margins on A4; body 13.5px ≈ 10.5pt.
  const body = (
    <div style={{ padding: "22px 64px 40px" }}>
      {parsed.sections.map((s) => (
        <div key={s.heading} style={{ marginBottom: 18 }}>
          <div style={sectionHeadingStyle}>{s.heading}</div>
          <ul style={{ margin: 0, paddingInlineStart: 18, fontSize: 13.5 }}>{renderLines(s.lines)}</ul>
        </div>
      ))}
    </div>
  );

  return (
    <div>
      {!preview && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <button onClick={downloadPdf} disabled={busy} className="btn-accent px-5 py-2.5 text-sm font-bold disabled:opacity-50">
            {busy ? "…" : isRtl ? "↓ تنزيل القالب المصمّم (PDF)" : "↓ Download designed (PDF)"}
          </button>
          <span className="text-xs" style={{ color: "var(--faint)" }}>{isRtl ? "نسخة مصمّمة للعرض — للـ ATS استخدم PDF/Word النصي" : "Designed for viewing — for ATS use the plain PDF/Word"}</span>
        </div>
      )}

      {/* Live preview (also the capture source). dir drives RTL for Arabic;
          the contact line stays LTR so phone/email/dates read correctly. */}
      <div ref={wrapRef} className={preview ? "" : "rounded-xl"} style={preview ? undefined : { border: "1px solid var(--line)", overflow: "hidden", height: fitWidth && pageH ? pageH * fit : undefined }}>
        <div style={fitWidth ? { width: 794, transform: `scale(${fit})`, transformOrigin: isRtl ? "top right" : "top left" } : undefined}>
        <div ref={ref} dir={isRtl ? "rtl" : "ltr"} lang={isRtl ? "ar" : undefined} style={{ width: 794, minHeight: 1123, background: "#ffffff", color: "#374151", fontFamily: isRtl ? "'Segoe UI', Tahoma, Arial, sans-serif" : "Arial, Helvetica, sans-serif", fontSize: 13.5, textAlign: isRtl ? "right" : "left" }}>
          {/* Header: white background always (colored header blocks confuse some
              parsers and waste toner). Name ≈ 22pt; contact one line below. */}
          <div style={{ padding: "40px 64px 0", textAlign: headerCentered ? "center" : "start" }}>
            <div style={{ fontSize: 29, fontWeight: serif ? 700 : 800, letterSpacing: serif ? 1.5 : 0.3, color: strict || variant === "minimal" ? "#111827" : accent, fontFamily: serif ? "Georgia, 'Times New Roman', serif" : undefined }}>{parsed.name}</div>
            {parsed.contact && <div dir="ltr" style={{ marginTop: 8, fontSize: 12.5, color: "#4b5563", textAlign: headerCentered ? "center" : isRtl ? "right" : "left", unicodeBidi: "plaintext" }}>{parsed.contact}</div>}
            <div style={{ marginTop: 14, borderBottom: strict ? "1.5px solid #111827" : variant === "classic" ? `3px solid ${accent}` : variant === "modern" ? `2px solid ${accent}` : serif ? "1px solid #9ca3af" : "1.5px solid #d1d5db" }} />
          </div>
          {body}
        </div>
        </div>
      </div>
    </div>
  );
}
