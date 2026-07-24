import { ImageResponse } from "next/og";
import { NextRequest } from "next/server";

export const runtime = "edge";

/** Dynamic social-share card: "My resume scored 92/100". Every multi-child
 *  div declares display:flex (required by Satori). */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const score = Math.max(0, Math.min(100, parseInt(p.get("score") || "0") || 0));
  const label = score >= 75 ? "SHORTLISTED" : score >= 55 ? "BORDERLINE" : "NEEDS WORK";
  const accent = score >= 75 ? "#4ade80" : score >= 55 ? "#fbbf24" : "#f87171";

  return new ImageResponse(
    (
      <div style={{ height: "100%", width: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "#08090a", color: "#f4f5f3", fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 30 }}>
          <div style={{ width: 44, height: 44, borderRadius: 10, background: "#4ade80", color: "#05130a", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 26, fontWeight: 800, marginRight: 14 }}>R</div>
          <div style={{ display: "flex", fontSize: 30, fontWeight: 700 }}>Sira</div>
        </div>
        <div style={{ display: "flex", fontSize: 26, color: "#8a8a8a", letterSpacing: 6 }}>MY ATS RESUME SCORE</div>
        <div style={{ display: "flex", alignItems: "baseline" }}>
          <div style={{ display: "flex", fontSize: 220, fontWeight: 800, color: accent, lineHeight: 1 }}>{score}</div>
          <div style={{ display: "flex", fontSize: 70, color: "#555" }}>/100</div>
        </div>
        <div style={{ display: "flex", marginTop: 14, padding: "10px 26px", borderRadius: 12, background: `${accent}22`, border: `2px solid ${accent}`, color: accent, fontSize: 28, fontWeight: 700, letterSpacing: 3 }}>{label}</div>
        <div style={{ display: "flex", marginTop: 40, fontSize: 26, color: "#8a8a8a" }}>Check your resume free at cv.rabit.sa</div>
      </div>
    ),
    { width: 1200, height: 630 }
  );
}
