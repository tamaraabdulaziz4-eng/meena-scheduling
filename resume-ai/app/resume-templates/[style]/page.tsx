import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { TEMPLATES, TEMPLATE_SLUGS, getTemplate } from "../../lib/templates";
import TemplatePreview from "../../components/TemplatePreview";

const BASE = process.env.NEXT_PUBLIC_APP_URL || "https://cv.rabit.sa";

export function generateStaticParams() {
  return TEMPLATE_SLUGS.map((style) => ({ style }));
}

export async function generateMetadata({ params }: { params: Promise<{ style: string }> }): Promise<Metadata> {
  const { style } = await params;
  const t = getTemplate(style);
  if (!t) return {};
  return {
    title: `Free ${t.name} Resume Template (2026) — ATS-Friendly`,
    description: `${t.tagline} Free ${t.keyword} you can fill in and download in minutes. ATS score: ${t.atsScore}/100.`,
    keywords: `${t.keyword}, free ${t.keyword}, ${t.name.toLowerCase()} cv template, resume template ${t.name.toLowerCase()}`,
    alternates: { canonical: `${BASE}/resume-templates/${t.slug}` },
    openGraph: { title: `Free ${t.name} Resume Template`, description: t.tagline, type: "website" },
  };
}

export default async function Page({ params }: { params: Promise<{ style: string }> }) {
  const { style } = await params;
  const t = getTemplate(style);
  if (!t) notFound();
  const others = TEMPLATES.filter((x) => x.slug !== t.slug);

  const faqs = [
    { q: `Is this ${t.name} resume template free?`, a: `Yes — the ${t.name} template is completely free to use. Fill it in with our builder and download it, no payment or sign-up for the first resume.` },
    { q: `Is the ${t.name} template ATS-friendly?`, a: `${t.atsNote} It scores ${t.atsScore}/100 on ATS-safety.` },
    { q: `Can I edit this template in Word?`, a: `You build and edit it right here, then download as plain text or a print-ready PDF you can open anywhere.` },
  ];
  const ld = { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faqs.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })) };

  return (
    <main className="min-h-screen" style={{ background: "var(--bg)", color: "var(--fg)" }}>
      <nav className="sticky top-0 z-50 backdrop-blur" style={{ background: "rgba(8,9,10,0.7)", borderBottom: "1px solid var(--line)" }}>
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg font-mono text-sm font-bold" style={{ background: "var(--accent)", color: "#05130a" }}>R</div>
            <span className="text-[15px] font-bold tracking-tight">ResumeAI</span>
          </Link>
          <Link href="/build" className="btn-accent px-4 py-2 text-sm">Use this template</Link>
        </div>
      </nav>

      <div className="mx-auto max-w-5xl px-6 py-10">
        <div className="mb-6 font-mono text-xs" style={{ color: "var(--faint)" }}>
          <Link href="/" style={{ color: "var(--faint)" }}>Home</Link> › <Link href="/resume-templates" style={{ color: "var(--faint)" }}>Templates</Link> › {t.name}
        </div>

        <div className="grid items-center gap-10 lg:grid-cols-2">
          <div>
            <div className="chip mb-4">● Free · ATS score {t.atsScore}/100</div>
            <h1 className="text-4xl font-extrabold leading-tight tracking-tight">Free {t.name} Resume Template</h1>
            <p className="mt-4 text-lg leading-relaxed" style={{ color: "var(--muted)" }}>{t.tagline}</p>
            <p className="mt-3 text-sm" style={{ color: "var(--muted)" }}><strong>Best for:</strong> {t.bestFor}</p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link href="/build" className="btn-accent px-6 py-3">Use this template free →</Link>
              <Link href="/optimize" className="btn-ghost px-6 py-3 font-semibold" style={{ color: "var(--fg)" }}>Already have a resume? Check it</Link>
            </div>
            <div className="card mt-6 p-4 text-sm" style={{ color: "var(--muted)" }}>
              <span style={{ color: t.atsScore >= 90 ? "var(--accent)" : "#fbbf24" }}>● ATS note:</span> {t.atsNote}
            </div>
          </div>
          <div className="mx-auto w-full max-w-xs"><TemplatePreview t={t} /></div>
        </div>

        <section className="mt-16">
          <h2 className="mb-4 text-2xl font-bold tracking-tight">FAQ</h2>
          <div className="space-y-4">
            {faqs.map((f) => (
              <div key={f.q} className="card p-5"><h3 className="font-bold">{f.q}</h3><p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>{f.a}</p></div>
            ))}
          </div>
        </section>

        <section className="mt-16">
          <h2 className="mb-4 text-2xl font-bold tracking-tight">More free resume templates</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {others.map((o) => (
              <Link key={o.slug} href={`/resume-templates/${o.slug}`} className="card card-hover p-4">
                <div className="font-bold">{o.name}</div>
                <div className="mt-1 text-xs" style={{ color: "var(--faint)" }}>ATS {o.atsScore}/100</div>
              </Link>
            ))}
          </div>
        </section>
      </div>

      <footer className="px-6 py-10" style={{ borderTop: "1px solid var(--line)" }}>
        <p className="text-center font-mono text-xs" style={{ color: "var(--faint)" }}>© 2026 ResumeAI · a resume service by Rabit</p>
      </footer>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }} />
    </main>
  );
}
