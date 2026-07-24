import type { TemplateDef } from "../lib/templateCatalog";

/**
 * A lightweight, recognizable mini-mock of a resume template — a tiny white
 * "paper" whose layout signature (single column / sidebar / bold header …) and
 * accent color distinguish it at a glance. Used in the template CARD gallery on
 * the reveal step (a real ResumeTemplate per card would be far too heavy).
 */
export default function TemplateThumb({ def }: { def: TemplateDef }) {
  const a = def.accent;
  const v = def.variant;
  const Bar = ({ w, c = "#d4d7dd", h = 2.5 }: { w: string | number; c?: string; h?: number }) => (
    <div style={{ width: w, height: h, background: c, borderRadius: 2 }} />
  );
  const Head = () => (
    <div style={{ height: 3.5, width: "42%", background: a, borderRadius: 2, marginTop: 7, marginBottom: 4 }} />
  );
  const lines = (
    <>
      <Head />
      <div style={{ display: "flex", flexDirection: "column", gap: 2.5 }}>
        <Bar w="100%" /><Bar w="92%" /><Bar w="76%" />
      </div>
      <Head />
      <div style={{ display: "flex", flexDirection: "column", gap: 2.5 }}>
        <Bar w="88%" /><Bar w="96%" />
      </div>
    </>
  );

  return (
    <div style={{ background: "#fff", borderRadius: 7, overflow: "hidden", aspectRatio: "3 / 4", display: "flex", boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.06)" }}>
      {(v === "column") && (
        <div style={{ width: "34%", background: a, padding: 6, display: "flex", flexDirection: "column", gap: 3 }}>
          <div style={{ width: "80%", height: 4, background: "rgba(255,255,255,0.9)", borderRadius: 2 }} />
          <div style={{ width: "60%", height: 2.5, background: "rgba(255,255,255,0.55)", borderRadius: 2, marginTop: 2 }} />
          <div style={{ width: "70%", height: 2.5, background: "rgba(255,255,255,0.45)", borderRadius: 2, marginTop: 8 }} />
          <div style={{ width: "55%", height: 2.5, background: "rgba(255,255,255,0.45)", borderRadius: 2 }} />
        </div>
      )}
      <div style={{ flex: 1, padding: 8 }}>
        {/* name — bold/accent for 'bold'/'modern', ink otherwise; centered for elegant */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: v === "elegant" ? "center" : "flex-start", gap: 3 }}>
          <div style={{ width: v === "elegant" ? "62%" : "58%", height: 5, background: v === "modern" ? a : "#1f2430", borderRadius: 2 }} />
          <div style={{ width: v === "elegant" ? "44%" : "40%", height: 2.5, background: "#9aa0ab", borderRadius: 2 }} />
          {v === "elegant" && <div style={{ width: "30%", height: 1.5, background: a, borderRadius: 2, marginTop: 2 }} />}
        </div>
        {lines}
      </div>
    </div>
  );
}
