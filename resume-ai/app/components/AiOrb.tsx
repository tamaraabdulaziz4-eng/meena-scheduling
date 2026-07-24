"use client";

/**
 * رابط — ECLIPSE (v4). A monochrome light phenomenon, not a colored marble:
 * a black moon core · a rotating silver corona crescent · a field of
 * particles · two tilted metallic halo rings · a soft bloom spilling into
 * the room. Default identity = silver/white on black (harmony through
 * restraint). Moods tint the LIGHT only at charged moments — thinking
 * burns violet, payment turns gold, success flashes green. Same body,
 * different light. Pure CSS + one inline SVG — no WebGL, no deps.
 */
import type { CSSProperties } from "react";

export type OrbState = "idle" | "listening" | "thinking" | "talking" | "golden" | "locked" | "done" | "lost";

/* Deterministic particle field — golden-angle scatter in a disc band around
   the core (between the halo rings). Generated once, scaled by the orb box. */
const DOTS = Array.from({ length: 120 }, (_, i) => {
  const angle = i * 2.39996; // golden angle
  const band = 0.62 + 0.36 * ((i * 0.7301) % 1); // radius 0.62–0.98 of half-box
  const r = band * 100;
  return {
    x: 100 + Math.cos(angle) * r,
    y: 100 + Math.sin(angle) * r * 0.92, // slight vertical squash → depth
    d: 0.45 + ((i * 0.37) % 1) * 0.55,
    o: 0.10 + ((i * 0.517) % 1) * 0.45,
  };
});

export default function AiOrb({
  size = 40,
  thinking = false,
  state,
  className = "",
  style,
  light = false,
}: {
  size?: number;
  thinking?: boolean;
  state?: OrbState;
  className?: string;
  style?: CSSProperties;
  /** Render on a LIGHT surface (the glass/document world): a luminous violet
   *  marble instead of the black eclipse, which would read as a black hole. */
  light?: boolean;
}) {
  const mode = state ?? (thinking ? "thinking" : "idle");
  return (
    <span
      aria-hidden
      className={`ai-orb ${mode !== "idle" ? mode : ""} ${size < 100 ? "mini" : ""} ${light ? "on-light" : ""} ${className}`}
      style={{ ["--orb-size" as string]: `${size}px`, ...style }}
    >
      <span className="orb-bloom" />
      <svg className="orb-field" viewBox="0 0 200 200" aria-hidden>
        {DOTS.map((p, i) => (
          <circle key={i} cx={p.x.toFixed(1)} cy={p.y.toFixed(1)} r={p.d.toFixed(2)} fill="currentColor" opacity={p.o.toFixed(2)} />
        ))}
      </svg>
      <span className="orb-halo r1" />
      <span className="orb-halo r2" />
      <span className="orb-sphere">
        <span className="orb-core" />
        <span className="orb-corona" />
        <span className="orb-floorlight" />
      </span>
    </span>
  );
}
