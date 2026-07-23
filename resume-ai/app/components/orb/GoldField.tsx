"use client";
/** Rising golden sparks behind the golden orb — luxury = money, at the vault. */
const SPARKS = Array.from({ length: 18 }, (_, i) => ({
  left: (i * 53) % 100,
  delay: (i % 9) * 0.8,
  dur: 5 + (i % 5),
}));
export default function GoldField() {
  return (
    <div className="gold-field" aria-hidden>
      {SPARKS.map((s, i) => (
        <span key={i} className="gold-spark" style={{ left: `${s.left}%`, bottom: 0, animationDelay: `${s.delay}s`, animationDuration: `${s.dur}s` }} />
      ))}
    </div>
  );
}
