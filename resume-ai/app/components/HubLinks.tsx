import Link from "next/link";

/**
 * Cross-links every resource hub so no page stands alone — internal linking
 * for visitors AND for search crawlers. Server-safe (no hooks).
 */
const EN: [string, string][] = [
  ["Resume examples", "/resume-examples"],
  ["Skills by job", "/resume-skills"],
  ["Templates", "/resume-templates"],
  ["Cover letters", "/cover-letter-examples"],
  ["ATS checker", "/ats-resume-checker"],
  ["Free checker", "/free-resume-checker"],
  ["Interview prep", "/interview"],
  ["LinkedIn optimizer", "/linkedin"],
  ["Pricing", "/pricing"],
];
const AR: [string, string][] = [
  ["الرئيسية", "/ar"],
  ["افحص سيرتك", "/ar/optimize"],
  ["أمثلة السير", "/ar/resume-examples"],
  ["القوالب", "/templates"],
  ["تحضير المقابلة", "/ar/interview"],
  ["الأسعار", "/pricing"],
  ["حسابي", "/ar/account"],
];

export default function HubLinks({ current, ar = false }: { current?: string; ar?: boolean }) {
  const links = (ar ? AR : EN).filter(([, href]) => href !== current);
  return (
    <nav className="mx-auto flex max-w-4xl flex-wrap items-center justify-center gap-2 px-6 pb-12" aria-label="Explore more">
      {links.map(([label, href]) => (
        <Link key={href} href={href} className="rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors"
          style={{ border: "1px solid var(--line)", color: "var(--muted)" }}>{label}</Link>
      ))}
    </nav>
  );
}
