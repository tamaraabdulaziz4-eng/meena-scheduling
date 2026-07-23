"use client";

/**
 * رابط — THE LIVING AURORA SPHERE (v3).
 * One entity, five organs: atmosphere (halo) · sphere body · twin aurora
 * currents · hot core · eclipse rim. Moods re-tune the same body via CSS
 * custom properties — it never becomes a different object, it *feels*
 * different. Pure CSS (see .ai-orb in globals.css) — no WebGL, no deps.
 *
 * Drop it next to anything the AI touches so the whole site reads as one
 * living assistant wired into every line.
 */
import type { CSSProperties } from "react";

export type OrbState = "idle" | "listening" | "thinking" | "talking" | "golden" | "locked" | "done" | "lost";

export default function AiOrb({
  size = 40,
  thinking = false,
  state,
  className = "",
  style,
}: {
  size?: number;
  thinking?: boolean;
  state?: OrbState;
  className?: string;
  style?: CSSProperties;
}) {
  const mode = state ?? (thinking ? "thinking" : "idle");
  return (
    <span
      aria-hidden
      className={`ai-orb ${mode !== "idle" ? mode : ""} ${className}`}
      style={{ ["--orb-size" as string]: `${size}px`, ...style }}
    >
      <span className="orb-atmo" />
      <span className="orb-sphere">
        <span className="orb-aur a" />
        <span className="orb-aur b" />
        <span className="orb-core" />
        <span className="orb-rim" />
        <span className="orb-sheen" />
      </span>
    </span>
  );
}
