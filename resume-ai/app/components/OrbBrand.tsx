"use client";
import AiOrb from "./AiOrb";

/** Client wrapper so server components (SEO pages) can render the orb brand mark. */
export default function OrbBrand({ size = 26 }: { size?: number }) {
  return (
    <span className="inline-flex" aria-hidden>
      <AiOrb size={size} />
    </span>
  );
}
