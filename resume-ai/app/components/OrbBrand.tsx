/**
 * The nav LOGO mark — deliberately NOT the living AiOrb. The constitution says
 * one mounted orb, always: the big flying presence is THE orb. This is a small,
 * flat, static echo of it — a violet→pink gradient disc with a specular
 * highlight — so a page never shows two identical orbs. Pure CSS, no animation,
 * safe in server components.
 */
export default function OrbBrand({ size = 26 }: { size?: number }) {
  return (
    <span
      className="relative inline-block shrink-0"
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background:
          "radial-gradient(circle at 34% 30%, #c4b5fd 0%, #8b5cf6 38%, #7c3aed 72%, #6d28d9 100%)",
        boxShadow:
          "0 2px 10px -2px rgba(139,92,246,0.6), inset 0 1px 2px rgba(255,255,255,0.55), inset 0 -2px 4px rgba(76,29,149,0.5)",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: "16%",
          left: "22%",
          width: "34%",
          height: "26%",
          borderRadius: "50%",
          background: "rgba(255,255,255,0.75)",
          filter: "blur(1px)",
        }}
      />
    </span>
  );
}
