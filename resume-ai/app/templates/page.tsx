import type { Metadata } from "next";
import HubLinks from "../components/HubLinks";
import OrbBrand from "../components/OrbBrand";
import OrbSceneSetter from "../components/orb/OrbSceneSetter";
import Link from "next/link";
import TemplatesGallery from "./TemplatesGallery";

const BASE = process.env.NEXT_PUBLIC_APP_URL || "https://cv.rabit.sa";

export const metadata: Metadata = {
  title: "Resume Templates — ATS-Safe, RTL & English | Sira",
  description:
    "Browse professional, ATS-safe resume templates in Arabic (RTL) and English. Pick a design, then let AI fill it with your real experience — no fabricated facts. Free to start.",
  alternates: {
    canonical: `${BASE}/templates`,
    languages: { en: `${BASE}/templates`, ar: `${BASE}/templates`, "x-default": `${BASE}/templates` },
  },
  openGraph: { title: "Resume Templates — ATS-Safe, Arabic & English", description: "Professional resume templates that pass ATS, in RTL and English.", url: `${BASE}/templates` },
};

export default function TemplatesPage() {
  return (
    <main className="min-h-screen" style={{ background: "var(--bg)", color: "var(--fg)" }}>
      <OrbSceneSetter visible mood="idle" top="14vh" left="86%" size={100} />
      <nav className="sticky top-0 z-50" style={{ background: "linear-gradient(180deg, rgba(5,7,13,0.85), transparent)" }}>
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2.5">
            <OrbBrand size={26} />
            <span className="text-[15px] font-bold tracking-tight">Sira</span>
          </Link>
          <div className="flex items-center gap-4">
            <Link href="/pricing" className="text-sm font-semibold" style={{ color: "var(--muted)" }}>Pricing</Link>
            <Link href="/optimize" className="btn-accent px-4 py-2 text-sm">Free scan →</Link>
          </div>
        </div>
      </nav>

      <section className="mx-auto max-w-6xl px-6 py-14">
        <div className="mb-10 text-center">
          <div className="chip mb-4">● Templates</div>
          <h1 className="text-4xl font-extrabold tracking-tight">Professional resume templates</h1>
          <p className="mx-auto mt-3 max-w-2xl" style={{ color: "var(--muted)" }}>
            Every template is <strong>ATS-safe</strong> and works in both <strong>Arabic (RTL)</strong> and English. Pick a design — then AI fills it with <em>your</em> real experience, never invented facts.
          </p>
        </div>
        <TemplatesGallery />
        <p className="mt-10 text-center text-sm" style={{ color: "var(--faint)" }}>
          Designed PDF is great for recruiters &amp; LinkedIn. For the applicant-tracking upload, use the plain ATS PDF/Word — both are included.
        </p>
      </section>
          <HubLinks current="/templates" />
    </main>
  );
}
