"use client";
/** Frosted-glass surface — the "owning" world (GLASS). Light, soft, elevated. */
export default function GlassCard({
  children, className = "", style,
}: { children: React.ReactNode; className?: string; style?: React.CSSProperties }) {
  return (
    <div className={`glass-surface ${className}`} style={style}>
      {children}
    </div>
  );
}
