/**
 * Infinite scrolling strip of the ATS platforms our output survives —
 * the Lumio-style "integrations" trust band, rendered as styled wordmarks
 * (no logo assets needed, fully server-rendered).
 */
const SYSTEMS = [
  "Workday", "Greenhouse", "Taleo", "Lever", "SAP SuccessFactors",
  "Oracle HCM", "iCIMS", "BambooHR", "Jadarat جدارات", "Bayt.com",
  "LinkedIn Jobs", "SmartRecruiters", "Ashby", "Jobvite",
];

export default function AtsMarquee({ label }: { label: string }) {
  // Track duplicated once → translateX(-50%) loops seamlessly.
  const items = [...SYSTEMS, ...SYSTEMS];
  return (
    <div className="py-10" style={{ borderTop: "1px solid var(--line)" }}>
      <p className="mb-6 text-center font-mono text-[11px] uppercase tracking-[0.25em]" style={{ color: "var(--faint)" }}>
        {label}
      </p>
      <div className="marquee">
        <div className="marquee-track">
          {items.map((s, i) => (
            <span
              key={`${s}-${i}`}
              className="whitespace-nowrap font-mono text-sm font-semibold tracking-wide"
              style={{ color: "rgba(244,245,243,0.38)" }}
            >
              {s}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
