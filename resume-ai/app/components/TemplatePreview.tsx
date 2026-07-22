import { TemplateData } from "../lib/templates";

/** Renders a realistic sample resume in the given template's visual style —
 *  a real preview that also gives the SEO page unique visual content. */
export default function TemplatePreview({ t }: { t: TemplateData }) {
  const sidebar = t.layout === "sidebar";
  const H = ({ children }: { children: React.ReactNode }) => (
    <div style={{ color: t.accent, fontWeight: 700, fontSize: 11, letterSpacing: 1, textTransform: "uppercase", borderBottom: `2px solid ${t.accent}`, paddingBottom: 3, marginBottom: 6, marginTop: 12 }}>{children}</div>
  );
  const body = (
    <>
      <div style={{ fontSize: 22, fontWeight: 800, color: t.layout === "bold" ? t.accent : "#111" }}>Sara Al-Otaibi</div>
      <div style={{ fontSize: 10, color: "#555", marginTop: 2 }}>Marketing Specialist · sara@email.com · Riyadh</div>
      <H>Summary</H>
      <div style={{ fontSize: 10, color: "#333", lineHeight: 1.5 }}>Results-driven Marketing Specialist with 4+ years growing brand engagement and sales through data-led social campaigns.</div>
      <H>Experience</H>
      <div style={{ fontSize: 10.5, fontWeight: 700, color: "#111" }}>Sales &amp; Social Lead — Nahdi (2022–2024)</div>
      <ul style={{ margin: "4px 0", paddingInlineStart: 16, fontSize: 9.5, color: "#333", lineHeight: 1.5 }}>
        <li>Grew Instagram engagement 40% via a weekly content calendar</li>
        <li>Trained 2 staff and lifted branch NPS 12 points</li>
      </ul>
      <H>Education</H>
      <div style={{ fontSize: 10, color: "#333" }}>BBA, King Saud University — 2021</div>
    </>
  );
  return (
    <div style={{ background: "#fff", color: "#111", borderRadius: 10, padding: sidebar ? 0 : 22, fontFamily: t.font, boxShadow: "0 20px 60px -20px rgba(0,0,0,0.6)", overflow: "hidden", aspectRatio: "1 / 1.3", display: "flex" }}>
      {sidebar ? (
        <>
          <div style={{ width: "34%", background: t.accent, color: "#fff", padding: 16 }}>
            <div style={{ fontSize: 16, fontWeight: 800 }}>Sara Al-Otaibi</div>
            <div style={{ fontSize: 9, marginTop: 8, opacity: 0.9 }}>sara@email.com<br />Riyadh</div>
            <div style={{ fontWeight: 700, fontSize: 10, marginTop: 14, textTransform: "uppercase" }}>Skills</div>
            <div style={{ fontSize: 9, marginTop: 4, lineHeight: 1.7 }}>Social Media<br />Google Ads<br />Canva · Excel</div>
          </div>
          <div style={{ flex: 1, padding: 16 }}>{body}</div>
        </>
      ) : (
        <div style={{ flex: 1 }}>{body}</div>
      )}
    </div>
  );
}
