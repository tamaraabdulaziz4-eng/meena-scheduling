"use client";

/**
 * Animated AI interviewer avatar — a premium, self-contained visual "person"
 * on the other end of the call. No HeyGen/video needed: a gradient orb that
 * gently floats when idle and pulses with an equalizer when the AI is speaking,
 * driven by the `speaking` prop (wired to speechSynthesis start/end). Gives the
 * page a real two-person video-call feel.
 */
export default function InterviewerAvatar({ speaking = false, label = "المُقابِل" }: { speaking?: boolean; label?: string }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4">
      <div className="relative flex items-center justify-center" style={{ width: 168, height: 168 }}>
        {/* Pulse rings while speaking */}
        {speaking && (
          <>
            <span className="ia-ring" style={{ animationDelay: "0s" }} />
            <span className="ia-ring" style={{ animationDelay: "0.6s" }} />
          </>
        )}
        {/* Orb */}
        <div className={`ia-orb ${speaking ? "ia-speaking" : "ia-idle"}`}>
          <svg viewBox="0 0 24 24" width="66" height="66" fill="none" stroke="#05130a" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="8" r="3.4" />
            <path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6" />
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
        <span className="inline-block h-2 w-2 rounded-full" style={{ background: speaking ? "#4ade80" : "var(--faint)", boxShadow: speaking ? "0 0 8px #4ade80" : "none" }} />
        {label} {speaking ? "· يتحدّث…" : "· ينصت"}
      </div>
    </div>
  );
}
