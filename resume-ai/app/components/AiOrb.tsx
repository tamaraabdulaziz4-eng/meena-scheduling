"use client";

/**
 * The AI presence orb — inspired by orbs.jakubantalik.com (Jakub Antalík's
 * "thinking orb"): a glossy sphere with blurred color blobs drifting inside,
 * a soft outer glow, slow breathing at rest and a faster churn while the AI
 * is working. Pure CSS (see .ai-orb* in globals.css) — no WebGL, no deps.
 *
 * Drop it next to anything the AI touches so the whole site reads as one
 * living assistant wired into every line.
 */
export default function AiOrb({ size = 40, thinking = false, state, className = "" }: { size?: number; thinking?: boolean; state?: "idle" | "listening" | "thinking" | "talking"; className?: string }) {
  const mode = state ?? (thinking ? "thinking" : "idle");
  return (
    <span
      aria-hidden
      className={`ai-orb ${mode !== "idle" ? mode : ""} ${className}`}
      style={{ ["--orb-size" as string]: `${size}px` }}
    >
      <span className="ai-orb-blob b1" />
      <span className="ai-orb-blob b2" />
      <span className="ai-orb-blob b3" />
      <span className="ai-orb-sheen" />
    </span>
  );
}
