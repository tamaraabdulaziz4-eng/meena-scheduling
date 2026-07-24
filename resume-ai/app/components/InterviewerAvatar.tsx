"use client";

/**
 * Free "talking person" interviewer — an illustrated SVG human face that blinks
 * and moves its mouth while the AI is speaking (driven by the `speaking` prop,
 * wired to speechSynthesis start/end). No paid streaming-avatar service needed;
 * gives a real "someone is talking to you" feel for the live mock interview.
 */
export default function InterviewerAvatar({ speaking = false, label = "المُقابِل" }: { speaking?: boolean; label?: string }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3">
      <div className="relative flex items-center justify-center" style={{ width: 172, height: 172 }}>
        {speaking && (
          <>
            <span className="ia-ring" style={{ animationDelay: "0s" }} />
            <span className="ia-ring" style={{ animationDelay: "0.6s" }} />
          </>
        )}
        <div className={`ia-face ${speaking ? "ia-speaking" : "ia-idle"}`}>
          <svg viewBox="0 0 160 160" width="150" height="150" aria-hidden>
            <defs>
              <clipPath id="ia-clip"><circle cx="80" cy="80" r="76" /></clipPath>
              <linearGradient id="ia-bg" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#7c3aed" /><stop offset="1" stopColor="#4c1d95" />
              </linearGradient>
            </defs>
            <g clipPath="url(#ia-clip)">
              <rect width="160" height="160" fill="url(#ia-bg)" />
              {/* shoulders / collar */}
              <path d="M28 168c0-26 24-40 52-40s52 14 52 40v10H28z" fill="#1f2937" />
              <path d="M62 130 L80 150 L98 130 L92 122 H68 Z" fill="#e5e7eb" />
              <path d="M78 128 h4 l-2 20 z" fill="#9ca3af" />
              {/* neck */}
              <rect x="70" y="104" width="20" height="24" rx="8" fill="#e3ac86" />
              {/* head */}
              <ellipse cx="80" cy="74" rx="34" ry="38" fill="#f0bd97" />
              {/* hair */}
              <path d="M44 72c0-24 16-40 36-40s36 16 36 40c0-10-6-16-10-16 2-8-6-16-14-16-4-8-24-8-30 2-10 2-18 12-18 30z" fill="#3f2d23" />
              {/* ears */}
              <circle cx="46" cy="78" r="6" fill="#e3ac86" /><circle cx="114" cy="78" r="6" fill="#e3ac86" />
              {/* eyebrows */}
              <rect x="58" y="62" width="16" height="3.4" rx="1.7" fill="#3f2d23" />
              <rect x="86" y="62" width="16" height="3.4" rx="1.7" fill="#3f2d23" />
              {/* eyes (blink) */}
              <g className="ia-eye"><ellipse cx="66" cy="72" rx="6" ry="6.6" fill="#fff" /><circle cx="66" cy="73" r="3" fill="#2a2118" /></g>
              <g className="ia-eye"><ellipse cx="94" cy="72" rx="6" ry="6.6" fill="#fff" /><circle cx="94" cy="73" r="3" fill="#2a2118" /></g>
              {/* nose */}
              <path d="M80 76 v9 l-4 3" fill="none" stroke="#c98f6a" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
              {/* mouth (animates while speaking) */}
              <g className={speaking ? "ia-mouth-talk" : "ia-mouth-idle"} style={{ transformOrigin: "80px 96px" }}>
                <path d="M70 96 q10 8 20 0 q-10 4 -20 0z" fill="#7a3b34" />
              </g>
            </g>
            <circle cx="80" cy="80" r="76" fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="2" />
          </svg>
        </div>
      </div>

      {/* Equalizer */}
      <div className="flex h-6 items-end gap-1">
        {[0, 1, 2, 3, 4, 5, 6].map((i) => (
          <span key={i} className={speaking ? "ia-bar" : "ia-bar-idle"} style={{ animationDelay: `${i * 0.08}s` }} />
        ))}
      </div>

      <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: "var(--muted)" }}>
        <span className="inline-block h-2 w-2 rounded-full" style={{ background: speaking ? "#a78bfa" : "var(--faint)", boxShadow: speaking ? "0 0 8px #a78bfa" : "none" }} />
        {label} {speaking ? "· يتحدّث…" : "· ينصت"}
      </div>
    </div>
  );
}
