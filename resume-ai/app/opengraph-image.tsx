import { ImageResponse } from "next/og";

// Branded default social-share card (og:image + twitter:image site-wide).
// Pure JSX/divs — no external assets — so it statically optimizes at build.
// Every multi-child div declares display:flex (required by Satori).
export const alt = "Sira — Honest AI Resume Optimizer";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "0 100px",
          background: "#08090a",
          color: "#f4f5f3",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", marginBottom: 44 }}>
          <div style={{ width: 56, height: 56, borderRadius: 13, background: "#a78bfa", color: "#05130a", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 34, fontWeight: 800, marginRight: 18 }}>R</div>
          <div style={{ display: "flex", fontSize: 40, fontWeight: 700 }}>Sira</div>
        </div>
        <div style={{ display: "flex", fontSize: 68, fontWeight: 800, lineHeight: 1.1, maxWidth: 900 }}>
          Honest AI resume optimization in <span style={{ color: "#a78bfa", marginLeft: 16 }}>10 seconds</span>
        </div>
        <div style={{ display: "flex", marginTop: 30, fontSize: 32, color: "#9a9a9a", maxWidth: 880, lineHeight: 1.35 }}>
          Free ATS match score, missing keywords, and a rewrite that never invents a fact you didn&apos;t provide.
        </div>
        <div style={{ display: "flex", marginTop: 52, fontSize: 26, color: "#a78bfa", fontWeight: 600, letterSpacing: 1 }}>cv.rabit.sa</div>
      </div>
    ),
    { ...size }
  );
}
