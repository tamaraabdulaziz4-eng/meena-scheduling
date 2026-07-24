"use client";
/**
 * Cinematic scroll-driven landing — replaces the classic homepage on / and /ar.
 *
 * Story arc (brief): rejection → mirror (live scan) → score → transformation →
 * bilingual → templates → how it works → honest pricing → FAQ → finale.
 * The page brightens zone by zone: ink navy → twilight → light → white.
 *
 * Rules enforced here: ONE visible CTA per viewport with the same verb, the
 * embedded scan has a 60s timeout + friendly retry (never an infinite spinner),
 * the on-screen preview is always English (the Arabic payoff is the download —
 * framed honestly), inputs are 16px+ and touch targets 44px+.
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  motion,
  useScroll,
  useTransform,
  useMotionValueEvent,
  useReducedMotion,
  useInView,
} from "framer-motion";
import { track } from "@vercel/analytics";
import { TEMPLATE_CATALOG } from "../lib/templateCatalog";
import AiOrb from "./AiOrb";

type Lang = "ar" | "en";

interface ScanOutcome {
  matchScore: number;
  afterScore?: number;
  matchSummary: string;
  missingKeywords: string[];
  presentKeywords: string[];
  skillsGap: string[];
  improvements: { area: string; issue: string; fix: string; source?: string }[];
  optimizedResume: string;
  locked?: boolean;
  watermark?: boolean;
}

/* ────────────────────────── copy ────────────────────────── */

const T = {
  ar: {
    nav_lang: "English",
    nav_lang_href: "/",
    hero_kicker: "cv.rabit.sa",
    hero_h1_a: "سيرتك الذاتية يرفضها روبوت…",
    hero_h1_b: "قبل ما يشوفها إنسان.",
    hero_stat: "75% من السير الذاتية ما توصل لمسؤول التوظيف.",
    hero_cta: "شاهد ما يحدث لسيرتك ↓",
    mirror_h2: "الصق سيرتك — شفها بعيون نظام التوظيف",
    mirror_sub: "مجاني، بدون تسجيل، خلال ثوانٍ.",
    mirror_ph: "الصق نص سيرتك الذاتية هنا…",
    mirror_cta: "افحص الآن",
    mirror_min: "الصق ٢٠٠ حرف على الأقل عشان يكون الفحص دقيق.",
    scanning: ["يقرأ سيرتك…", "يحلل الكلمات المفتاحية…", "يقارن مع أنظمة التوظيف…"],
    scan_fail: "الاتصال تأخر — ما راح نخليك تنتظر أكثر.",
    scan_retry: "أعد المحاولة",
    score_h2: "نتيجتك أمام الروبوت",
    score_low: "سيرتك ما تعبر الفلتر الحالي. الحل مو خبرة أكثر — كلمات أفضل.",
    score_high: "أساس قوي — خلنا نوصلها للقمة.",
    score_missing: "أهم كلمات ناقصة:",
    score_cta: "كمّل التحسين الكامل — مجاناً ←",
    tr_h2: "نفس الخبرة. نفس السنوات. كلمات مختلفة تماماً.",
    tr_before: "قبل",
    tr_after: "بعد",
    tr_note: "مثال حقيقي للتوضيح — التحسين ما يخترع خبرة، يعيد صياغة خبرتك أنت.",
    bi_h2: "وظيفة تتطلب الإنجليزية وأخرى العربية؟",
    bi_sub: "ليش تختار — اللغتين بضغطة وحدة.",
    bi_note: "المعاينة بالإنجليزية — ملف Word العربي يجيك مضبوط RTL عند التنزيل.",
    tpl_h2: "10 قوالب. كلها تعبر الروبوت — وتبهر الإنسان.",
    how_h2: "كيف تشتغل",
    how_steps: [
      "الصق سيرتك أو ابنِ وحدة من الصفر",
      "اختر لغة الإخراج (إنجليزي | عربي | الاثنين) و10 قوالب",
      "نزّلها Word أو PDF أو شاركها برابط",
    ],
    price_h2: "ادفع مرة وحدة. سيرتك تصير ملكك.",
    price_amount: "35",
    price_cur: "ريال",
    price_note: "مو اشتراك. ما فيه تجديد تلقائي. الفحص والتحليل يظلون مجانيين — المدفوع يفك التنزيل بدون علامة مائية.",
    price_cta: "جرّب مجاناً — وبعدين قرر",
    faq_h2: "أسئلة تدور في بالك",
    faq: [
      ["هل المعلومات تنحفظ عندكم؟", "الفحص يتم بدون تسجيل، وسيرتك ما تُنشر إلا إذا أنت اخترت مشاركتها برابط."],
      ["هل السيرة العربية فعلاً RTL؟", "ملف Word العربي يتنزّل بتنسيق RTL صحيح — مو نص مقلوب."],
      ["هل تخترقون أنظمة الشركات؟", "لا. نفحص سيرتك بمعايير أنظمة ATS المعروفة ونحسّن صياغتها — بدون أي اختلاق."],
      ["ليش أدفع 35 ريال؟", "المدفوع يفك التنزيل النظيف بدون علامة مائية — مرة وحدة، مو اشتراك."],
    ],
    fin_h2: "خلصت القراءة عن سيرة أفضل.",
    fin_sub: "خطوتك الأولى تبدأ الآن ↓",
    fin_scan: "افحص سيرتي — مجاناً",
    fin_build: "ما عندي سيرة — ابنِ لي وحدة",
    build_href: "/ar/build",
    optimize_href: "/ar/optimize",
    draft_key: "ra_ar_optimize_draft",
    result_key: "ra_ar_optimize_result",
  },
  en: {
    nav_lang: "عربي",
    nav_lang_href: "/ar",
    hero_kicker: "cv.rabit.sa",
    hero_h1_a: "Your resume is rejected by a robot…",
    hero_h1_b: "before a human ever sees it.",
    hero_stat: "75% of resumes never reach the recruiter.",
    hero_cta: "See what happens to yours ↓",
    mirror_h2: "Paste your resume — see it through the ATS's eyes",
    mirror_sub: "Free, no signup, seconds.",
    mirror_ph: "Paste your resume text here…",
    mirror_cta: "Scan it now",
    mirror_min: "Paste at least 200 characters for an accurate scan.",
    scanning: ["Reading your resume…", "Analyzing keywords…", "Comparing against ATS rules…"],
    scan_fail: "The connection stalled — we won't keep you waiting.",
    scan_retry: "Try again",
    score_h2: "Your score against the robot",
    score_low: "Your resume doesn't clear the filter yet. The fix isn't more experience — it's better words.",
    score_high: "Strong foundation — let's take it to the top.",
    score_missing: "Top missing keywords:",
    score_cta: "Continue the full optimization — free →",
    tr_h2: "Same experience. Same years. Entirely different words.",
    tr_before: "Before",
    tr_after: "After",
    tr_note: "Illustrative real example — optimization never invents experience, it rewords yours.",
    bi_h2: "One job wants English, another Arabic?",
    bi_sub: "Why choose — both languages, one click.",
    bi_note: "The preview is English — the Arabic Word file downloads with true RTL.",
    tpl_h2: "10 templates. All pass the robot — and impress the human.",
    how_h2: "How it works",
    how_steps: [
      "Paste your resume or build one from scratch",
      "Pick the output language (English | Arabic | Both) and one of 10 templates",
      "Download Word or PDF, or share it with a link",
    ],
    price_h2: "Pay once. Own your resume forever.",
    price_amount: "35",
    price_cur: "SAR",
    price_note: "Not a subscription. No auto-renewal. Scanning and analysis stay free — paying unlocks clean, watermark-free downloads.",
    price_cta: "Try it free — then decide",
    faq_h2: "Questions on your mind",
    faq: [
      ["Is my data stored?", "Scanning needs no signup, and your resume is never published unless you choose to share it with a link."],
      ["Is the Arabic resume really RTL?", "The Arabic Word file downloads with correct RTL formatting — not flipped text."],
      ["Do you hack company systems?", "No. We score your resume against known ATS criteria and improve the wording — never fabricating anything."],
      ["Why pay SAR 35?", "Paying unlocks the clean, watermark-free download — one time, not a subscription."],
    ],
    fin_h2: "Reading about a better resume is over.",
    fin_sub: "Your first step starts now ↓",
    fin_scan: "Scan my resume — free",
    fin_build: "No resume yet — build me one",
    build_href: "/build",
    optimize_href: "/optimize",
    draft_key: "ra_optimize_draft",
    result_key: "ra_optimize_result",
  },
} as const;

/* ─────────────────── shared bits ─────────────────── */

const GREEN = "#22C55E";
const RED = "#E5484D";
const INK = "#0B1220";

/** Fires a scene_view analytics event once when the scene scrolls into view. */
function Scene({
  id,
  className,
  style,
  children,
}: {
  id: string;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const inView = useInView(ref, { amount: 0.4, once: true });
  useEffect(() => {
    if (inView) track("scene_view", { scene: id });
  }, [inView, id]);
  return (
    <section ref={ref} id={id} className={className} style={style}>
      {children}
    </section>
  );
}

function Rise({ children, delay = 0, className }: { children: React.ReactNode; delay?: number; className?: string }) {
  const reduced = useReducedMotion();
  if (reduced) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 28 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.4 }}
      transition={{ duration: 0.6, delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}

/* ─────────────────── demo CV copy (scene 3) ─────────────────── */

const DEMO_BEFORE = [
  "Responsible for sales in the region",
  "Helped customers with their problems",
  "Worked with the team on projects",
  "Did reports for the manager",
];
const DEMO_AFTER = [
  "Drove regional B2B sales pipeline across 3 cities",
  "Resolved 40+ customer escalations monthly, lifting CSAT",
  "Led cross-functional delivery of 5 client projects",
  "Built weekly KPI reports adopted by management",
];

/* ════════════════════════ component ════════════════════════ */

export default function LandingScroll({ lang }: { lang: Lang }) {
  const t = T[lang];
  const rtl = lang === "ar";
  const reduced = useReducedMotion();

  /* ── embedded scan state ── */
  const [resume, setResume] = useState("");
  const [phase, setPhase] = useState<"idle" | "scanning" | "done" | "failed">("idle");
  const [scanMsg, setScanMsg] = useState(0);
  const [result, setResult] = useState<ScanOutcome | null>(null);
  const [dial, setDial] = useState(0);
  const scoreRef = useRef<HTMLDivElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);

  // Rotating "what the AI is doing" line while scanning.
  useEffect(() => {
    if (phase !== "scanning") return;
    const id = setInterval(() => setScanMsg((m) => (m + 1) % t.scanning.length), 2200);
    return () => clearInterval(id);
  }, [phase, t.scanning.length]);

  // Count the dial up when a result lands.
  useEffect(() => {
    if (!result) return;
    if (reduced) { setDial(result.matchScore); return; }
    let n = 0;
    const target = result.matchScore;
    const id = setInterval(() => {
      n = Math.min(target, n + Math.max(1, Math.round(target / 40)));
      setDial(n);
      if (n >= target) clearInterval(id);
    }, 28);
    return () => clearInterval(id);
  }, [result, reduced]);

  async function runScan() {
    const text = resume.trim();
    if (text.length < 200) return;
    setPhase("scanning");
    setResult(null);
    track("scan_started", { where: "landing", lang });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    try {
      const res = await fetch("/api/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({ resume: text, jobDescription: "", outLang: "en" }),
      });
      const ctype = res.headers.get("content-type") || "";
      if (!ctype.includes("ndjson")) {
        const data = await res.json();
        throw new Error(data.error || "failed");
      }
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let got: ScanOutcome | null = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.t === "result") got = msg.d;
            else if (msg.t === "error") throw new Error(msg.d);
          } catch (e) {
            if (e instanceof Error && e.message !== line) throw e;
          }
        }
      }
      if (!got) throw new Error("incomplete");
      setResult(got);
      setPhase("done");
      track("scan_completed", { where: "landing", score: got.matchScore });
      // Hand the full result to the optimizer so "continue" resumes instantly.
      try {
        localStorage.setItem(t.draft_key, JSON.stringify({ resume: text, jobDescription: "", mode: "general" }));
        localStorage.setItem(t.result_key, JSON.stringify(got));
      } catch { /* storage blocked — non-fatal */ }
      setTimeout(() => scoreRef.current?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" }), 150);
    } catch {
      setPhase("failed");
    } finally {
      clearTimeout(timer);
    }
  }

  /* ── scene 3 scroll scrub ── */
  const trRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress: trP } = useScroll({ target: trRef, offset: ["start start", "end end"] });
  const beforeOpacity = useTransform(trP, [0, 0.45], [1, 0]);
  const afterOpacity = useTransform(trP, [0.35, 0.75], [0, 1]);
  const [trScore, setTrScore] = useState(38);
  useMotionValueEvent(trP, "change", (v) => setTrScore(Math.round(38 + Math.min(1, Math.max(0, (v - 0.3) / 0.5)) * 40)));

  /* ── bilingual flip ── */
  const [flipped, setFlipped] = useState(false);
  useEffect(() => {
    if (reduced) return;
    const id = setInterval(() => setFlipped((f) => !f), 3200);
    return () => clearInterval(id);
  }, [reduced]);

  /* ── FAQ ── */
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  const dialColor = dial < 60 ? RED : GREEN;
  const circumference = 2 * Math.PI * 54;

  return (
    <div dir={rtl ? "rtl" : "ltr"} style={{ background: INK, color: "#f4f5f3" }}>
      {/* ── minimal nav: logo + language only (one CTA rule — the page itself is the CTA) ── */}
      <nav className="fixed inset-x-0 top-0 z-50" style={{ background: "rgba(11,18,32,0.72)", backdropFilter: "blur(10px)", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
        <div className="mx-auto flex max-w-5xl items-center justify-between px-5 py-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg font-mono text-sm font-bold" style={{ background: GREEN, color: "#ffffff" }}>R</div>
            <span className="text-[15px] font-bold tracking-tight">Sira</span>
          </div>
          <Link href={t.nav_lang_href} className="flex min-h-11 items-center px-3 text-sm font-semibold" style={{ color: GREEN }}>{t.nav_lang}</Link>
        </div>
      </nav>

      {/* ═══ SCENE 0 — the rejection (hero) ═══ */}
      <Scene id="s0-rejection" className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-5 pt-20 text-center">
        <div aria-hidden className="pointer-events-none absolute inset-0" style={{ background: `radial-gradient(60% 50% at 50% 30%, rgba(229,72,77,0.08), transparent 70%)` }} />
        {/* falling CV card + stamp */}
        <motion.div
          initial={reduced ? false : { y: -140, opacity: 0, rotate: -6 }}
          animate={reduced ? {} : { y: 0, opacity: 1, rotate: -3 }}
          transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
          className="relative mb-10 w-64 rounded-lg p-5 text-start shadow-2xl sm:w-72"
          style={{ background: "#f8fafc", color: "#1f2937" }}
        >
          <div className="mb-2 h-3 w-2/3 rounded" style={{ background: "#cbd5e1" }} />
          <div className="mb-1.5 h-2 w-full rounded" style={{ background: "#e2e8f0" }} />
          <div className="mb-1.5 h-2 w-11/12 rounded" style={{ background: "#e2e8f0" }} />
          <div className="mb-4 h-2 w-4/5 rounded" style={{ background: "#e2e8f0" }} />
          <div className="mb-1.5 h-2 w-full rounded" style={{ background: "#e2e8f0" }} />
          <div className="h-2 w-3/4 rounded" style={{ background: "#e2e8f0" }} />
          <motion.div
            initial={reduced ? false : { scale: 2.4, opacity: 0, rotate: -18 }}
            animate={reduced ? {} : { scale: 1, opacity: 1, rotate: -14 }}
            transition={{ delay: 0.9, duration: 0.28, ease: "easeIn" }}
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded border-4 px-3 py-1 font-mono text-xl font-black tracking-widest"
            style={{ borderColor: RED, color: RED, background: "rgba(255,255,255,0.85)" }}
            dir="ltr"
          >
            REJECTED
          </motion.div>
        </motion.div>

        <Rise>
          <h1 className="mx-auto max-w-2xl text-3xl font-extrabold leading-snug sm:text-5xl sm:leading-tight">
            {t.hero_h1_a}
            <br />
            <span style={{ color: RED }}>{t.hero_h1_b}</span>
          </h1>
        </Rise>
        <Rise delay={0.15}>
          <p className="mx-auto mt-5 max-w-md text-base sm:text-lg" style={{ color: "rgba(244,245,243,0.65)", lineHeight: 1.8 }}>{t.hero_stat}</p>
        </Rise>
        <Rise delay={0.3}>
          <button
            onClick={() => { track("cta_click", { cta: "hero_scroll" }); mirrorRef.current?.scrollIntoView({ behavior: reduced ? "auto" : "smooth" }); }}
            className="mt-10 min-h-11 rounded-full px-8 py-3 text-base font-bold"
            style={{ background: GREEN, color: "#ffffff" }}
          >
            {t.hero_cta}
          </button>
        </Rise>
        <motion.div
          aria-hidden
          animate={reduced ? {} : { y: [0, 8, 0] }}
          transition={{ repeat: Infinity, duration: 1.8 }}
          className="absolute bottom-6 text-2xl"
          style={{ color: "rgba(244,245,243,0.35)" }}
        >
          ↓
        </motion.div>
      </Scene>

      {/* ═══ SCENE 1 — the mirror (embedded scan) ═══ */}
      <Scene id="s1-mirror" className="relative px-5 py-24" style={{ background: "linear-gradient(180deg, #0B1220 0%, #171233 100%)" }}>
        <div ref={mirrorRef} className="mx-auto max-w-2xl scroll-mt-24">
          <Rise>
            <div className="flex items-center gap-4">
              <AiOrb size={52} thinking={phase === "scanning"} />
              <h2 className="text-2xl font-extrabold sm:text-4xl">{t.mirror_h2}</h2>
            </div>
            <p className="mt-3 text-base" style={{ color: "rgba(244,245,243,0.6)", lineHeight: 1.8 }}>{t.mirror_sub}</p>
          </Rise>
          <Rise delay={0.1}>
            <div className="mt-8 rounded-2xl p-4" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.09)" }}>
              <textarea
                value={resume}
                onChange={(e) => setResume(e.target.value)}
                placeholder={t.mirror_ph}
                rows={8}
                dir="auto"
                className="w-full resize-y rounded-xl p-4 outline-none"
                style={{ background: "rgba(11,18,32,0.7)", color: "#f4f5f3", border: "1px solid rgba(255,255,255,0.08)", fontSize: 16, lineHeight: 1.7 }}
              />
              {phase === "scanning" ? (
                <div className="mt-4 flex min-h-11 items-center gap-3 px-2" aria-live="polite">
                  <AiOrb size={34} thinking />
                  <span className="font-mono text-sm" style={{ color: GREEN }}>{t.scanning[scanMsg]}</span>
                </div>
              ) : phase === "failed" ? (
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl p-4" style={{ background: "rgba(229,72,77,0.1)", border: "1px solid rgba(229,72,77,0.35)" }}>
                  <span className="text-sm" style={{ color: "#fca5a5" }}>{t.scan_fail}</span>
                  <button onClick={runScan} className="min-h-11 rounded-lg px-5 text-sm font-bold" style={{ background: GREEN, color: "#ffffff" }}>{t.scan_retry}</button>
                </div>
              ) : (
                <div className="mt-4 flex flex-col gap-2">
                  <button
                    onClick={runScan}
                    disabled={resume.trim().length < 200}
                    className="min-h-12 w-full rounded-xl text-base font-bold disabled:opacity-40"
                    style={{ background: GREEN, color: "#ffffff" }}
                  >
                    {t.mirror_cta}
                  </button>
                  {resume.trim().length > 0 && resume.trim().length < 200 && (
                    <p className="text-xs" style={{ color: "rgba(244,245,243,0.5)" }}>{t.mirror_min}</p>
                  )}
                </div>
              )}
            </div>
          </Rise>
        </div>
      </Scene>

      {/* ═══ SCENE 2 — the score reveal ═══ */}
      {result && (
        <Scene id="s2-score" className="px-5 py-24" style={{ background: "#171233" }}>
          <div ref={scoreRef} className="mx-auto max-w-2xl text-center">
            <h2 className="text-2xl font-extrabold sm:text-4xl">{t.score_h2}</h2>
            <div className="mx-auto mt-10 h-44 w-44" dir="ltr">
              <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90">
                <circle cx="60" cy="60" r="54" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="10" />
                <circle
                  cx="60" cy="60" r="54" fill="none" stroke={dialColor} strokeWidth="10" strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={circumference * (1 - dial / 100)}
                  style={{ transition: "stroke-dashoffset 0.1s linear" }}
                />
              </svg>
              <div className="relative -mt-32 text-5xl font-black" style={{ color: dialColor }}>{dial}</div>
              <div className="text-xs" style={{ color: "rgba(244,245,243,0.45)" }}>/100</div>
            </div>
            <p className="mx-auto mt-10 max-w-md text-base font-semibold" style={{ lineHeight: 1.8 }}>
              {result.matchScore < 60 ? t.score_low : t.score_high}
            </p>
            {result.missingKeywords.length > 0 && (
              <div className="mt-6">
                <p className="text-sm" style={{ color: "rgba(244,245,243,0.55)" }}>{t.score_missing}</p>
                <div className="mt-3 flex flex-wrap justify-center gap-2">
                  {result.missingKeywords.slice(0, 3).map((k) => (
                    <span key={k} className="rounded-full px-4 py-1.5 text-sm" style={{ background: "rgba(229,72,77,0.14)", color: "#fca5a5", border: "1px solid rgba(229,72,77,0.3)" }}>{k}</span>
                  ))}
                </div>
              </div>
            )}
            <Link
              href={t.optimize_href}
              onClick={() => track("cta_click", { cta: "continue_optimize" })}
              className="mt-10 inline-block min-h-12 rounded-xl px-10 py-3.5 text-base font-bold"
              style={{ background: GREEN, color: "#ffffff" }}
            >
              {t.score_cta}
            </Link>
          </div>
        </Scene>
      )}

      {/* ═══ SCENE 3 — the transformation (scroll scrub) ═══ */}
      <div ref={trRef} style={{ height: reduced ? "auto" : "220vh", background: "#171233" }}>
        <Scene id="s3-transformation" className={reduced ? "px-5 py-24" : "sticky top-0 flex min-h-screen flex-col items-center justify-center px-5"}>
          <h2 className="mx-auto max-w-xl text-center text-2xl font-extrabold sm:text-4xl">{t.tr_h2}</h2>
          <div className="relative mx-auto mt-10 w-full max-w-md" dir="ltr">
            <motion.div style={reduced ? {} : { opacity: beforeOpacity }} className="rounded-2xl p-6" aria-hidden={!reduced}>
              <div className="mb-3 flex items-center justify-between">
                <span className="rounded px-2 py-0.5 font-mono text-xs font-bold" style={{ background: "rgba(229,72,77,0.15)", color: RED }}>{t.tr_before}</span>
              </div>
              {DEMO_BEFORE.map((l) => (
                <p key={l} className="mb-2 rounded-lg px-4 py-2.5 text-sm" style={{ background: "rgba(255,255,255,0.05)", color: "rgba(244,245,243,0.6)" }}>{l}</p>
              ))}
            </motion.div>
            {!reduced && (
              <motion.div style={{ opacity: afterOpacity }} className="absolute inset-0 rounded-2xl p-6">
                <div className="mb-3 flex items-center justify-between">
                  <span className="rounded px-2 py-0.5 font-mono text-xs font-bold" style={{ background: "rgba(139,92,246,0.15)", color: GREEN }}>{t.tr_after}</span>
                </div>
                {DEMO_AFTER.map((l) => (
                  <p key={l} className="mb-2 rounded-lg px-4 py-2.5 text-sm" style={{ background: "rgba(139,92,246,0.08)", color: "#f4f5f3", border: "1px solid rgba(139,92,246,0.2)" }}>{l}</p>
                ))}
              </motion.div>
            )}
            {reduced && (
              <div className="mt-4 rounded-2xl p-6">
                <span className="rounded px-2 py-0.5 font-mono text-xs font-bold" style={{ background: "rgba(139,92,246,0.15)", color: GREEN }}>{t.tr_after}</span>
                {DEMO_AFTER.map((l) => (
                  <p key={l} className="mb-2 mt-2 rounded-lg px-4 py-2.5 text-sm" style={{ background: "rgba(139,92,246,0.08)", color: "#f4f5f3" }}>{l}</p>
                ))}
              </div>
            )}
          </div>
          <div className="mt-8 font-mono text-lg font-black" dir="ltr" style={{ color: trScore >= 60 ? GREEN : RED }}>
            {reduced ? "38 → 78" : trScore}<span className="text-sm font-normal" style={{ color: "rgba(244,245,243,0.4)" }}>/100</span>
          </div>
          <p className="mx-auto mt-4 max-w-sm text-center text-xs" style={{ color: "rgba(244,245,243,0.45)", lineHeight: 1.8 }}>{t.tr_note}</p>
        </Scene>
      </div>

      {/* ═══ SCENE 4 — bilingual flip ═══ */}
      <Scene id="s4-bilingual" className="px-5 py-24" style={{ background: "linear-gradient(180deg, #171233 0%, #f3f4f6 100%)" }}>
        <div className="mx-auto max-w-2xl text-center">
          <Rise>
            <h2 className="text-2xl font-extrabold text-white sm:text-4xl" style={{ textShadow: "0 1px 12px rgba(11,18,32,0.5)" }}>{t.bi_h2}</h2>
            <p className="mt-3 text-base font-semibold" style={{ color: "rgba(255,255,255,0.85)", textShadow: "0 1px 8px rgba(11,18,32,0.5)" }}>{t.bi_sub}</p>
          </Rise>
          <Rise delay={0.1}>
            <div className="mx-auto mt-10 h-64 w-full max-w-sm" style={{ perspective: 1000 }}>
              <div
                className="relative h-full w-full transition-transform duration-700"
                style={{ transformStyle: "preserve-3d", transform: flipped ? "rotateY(180deg)" : "rotateY(0deg)" }}
              >
                <div className="absolute inset-0 rounded-2xl bg-white p-6 text-start shadow-xl" style={{ backfaceVisibility: "hidden", color: "#1f2937" }} dir="ltr">
                  <p className="font-bold">AHMED AL-QAHTANI</p>
                  <p className="text-xs" style={{ color: "#6b7280" }}>Sales Manager · Riyadh</p>
                  <div className="mt-3 h-2 w-full rounded" style={{ background: "#e5e7eb" }} />
                  <div className="mt-2 h-2 w-5/6 rounded" style={{ background: "#e5e7eb" }} />
                  <div className="mt-2 h-2 w-4/6 rounded" style={{ background: "#e5e7eb" }} />
                  <p className="mt-4 font-mono text-[10px] font-bold" style={{ color: GREEN }}>ENGLISH</p>
                </div>
                <div className="absolute inset-0 rounded-2xl bg-white p-6 text-right shadow-xl" style={{ backfaceVisibility: "hidden", transform: "rotateY(180deg)", color: "#1f2937" }} dir="rtl">
                  <p className="font-bold">أحمد القحطاني</p>
                  <p className="text-xs" style={{ color: "#6b7280" }}>مدير مبيعات · الرياض</p>
                  <div className="mt-3 h-2 w-full rounded" style={{ background: "#e5e7eb" }} />
                  <div className="mt-2 h-2 w-5/6 rounded" style={{ background: "#e5e7eb" }} />
                  <div className="mt-2 h-2 w-4/6 rounded" style={{ background: "#e5e7eb" }} />
                  <p className="mt-4 font-mono text-[10px] font-bold" style={{ color: GREEN }}>العربية · RTL</p>
                </div>
              </div>
            </div>
            <p className="mx-auto mt-6 max-w-sm text-xs" style={{ color: "#374151", lineHeight: 1.8 }}>{t.bi_note}</p>
          </Rise>
        </div>
      </Scene>

      {/* ═══ SCENE 5 — templates gallery (horizontal snap) ═══ */}
      <Scene id="s5-templates" className="py-24" style={{ background: "#f3f4f6", color: "#111827" }}>
        <Rise className="px-5 text-center">
          <h2 className="mx-auto max-w-xl text-2xl font-extrabold sm:text-4xl">{t.tpl_h2}</h2>
        </Rise>
        <div className="mt-10 flex snap-x snap-mandatory gap-4 overflow-x-auto px-5 pb-4" dir="ltr">
          {TEMPLATE_CATALOG.map((tp) => (
            <div key={tp.slug} className="w-44 shrink-0 snap-center">
              <div className="relative h-56 rounded-xl bg-white p-4 shadow-md" style={{ borderTop: `4px solid ${tp.accent}` }}>
                {tp.best && (
                  <span className="absolute -top-2 right-2 rounded-full px-2 py-0.5 text-[10px] font-bold text-white" style={{ background: tp.accent }}>PRO</span>
                )}
                <div className="mb-2 h-3 w-3/4 rounded" style={{ background: tp.accent, opacity: 0.85 }} />
                <div className="mb-1.5 h-1.5 w-full rounded bg-gray-200" />
                <div className="mb-1.5 h-1.5 w-11/12 rounded bg-gray-200" />
                <div className="mb-3 h-1.5 w-4/5 rounded bg-gray-200" />
                <div className="mb-1.5 h-1.5 w-full rounded bg-gray-100" />
                <div className="mb-1.5 h-1.5 w-10/12 rounded bg-gray-100" />
                <div className="h-1.5 w-3/4 rounded bg-gray-100" />
              </div>
              <p className="mt-2 text-center text-sm font-semibold">{rtl ? tp.nameAr : tp.name}</p>
            </div>
          ))}
        </div>
      </Scene>

      {/* ═══ SCENE 6 — how it works ═══ */}
      <Scene id="s6-how" className="px-5 py-24" style={{ background: "#fafafa", color: "#111827" }}>
        <div className="mx-auto max-w-xl">
          <Rise>
            <h2 className="text-center text-2xl font-extrabold sm:text-4xl">{t.how_h2}</h2>
          </Rise>
          <div className="mt-10 space-y-4">
            {t.how_steps.map((s, i) => (
              <Rise key={s} delay={i * 0.12}>
                <div className="flex items-center gap-4 rounded-2xl bg-white p-5 shadow-sm" style={{ border: "1px solid #e5e7eb" }}>
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full font-mono text-lg font-black text-white" style={{ background: GREEN }} dir="ltr">{i + 1}</span>
                  <p className="text-base font-semibold" style={{ lineHeight: 1.8 }}>{s}</p>
                </div>
              </Rise>
            ))}
          </div>
        </div>
      </Scene>

      {/* ═══ SCENE 7 — honest pricing ═══ */}
      <Scene id="s7-pricing" className="px-5 py-24" style={{ background: "#ffffff", color: "#111827" }}>
        <div className="mx-auto max-w-md text-center">
          <Rise>
            <h2 className="text-2xl font-extrabold sm:text-4xl">{t.price_h2}</h2>
          </Rise>
          <Rise delay={0.1}>
            <div className="mt-10 rounded-3xl p-8 shadow-lg" style={{ border: `2px solid ${GREEN}` }}>
              <div className="flex items-baseline justify-center gap-2" dir="ltr">
                <span className="text-6xl font-black">{t.price_amount}</span>
                <span className="text-xl font-bold" style={{ color: "#6b7280" }}>{t.price_cur}</span>
              </div>
              <p className="mt-5 text-sm" style={{ color: "#4b5563", lineHeight: 1.9 }}>{t.price_note}</p>
              <Link
                href={t.optimize_href}
                onClick={() => track("cta_click", { cta: "pricing_try_free" })}
                className="mt-7 inline-block min-h-12 w-full rounded-xl px-8 py-3.5 text-base font-bold text-white"
                style={{ background: GREEN, color: "#ffffff" }}
              >
                {t.price_cta}
              </Link>
            </div>
          </Rise>
        </div>
      </Scene>

      {/* ═══ SCENE 8 — FAQ ═══ */}
      <Scene id="s8-faq" className="px-5 py-24" style={{ background: "#ffffff", color: "#111827" }}>
        <div className="mx-auto max-w-xl">
          <Rise>
            <h2 className="text-center text-2xl font-extrabold sm:text-4xl">{t.faq_h2}</h2>
          </Rise>
          <div className="mt-10 space-y-3">
            {t.faq.map(([q, a], i) => (
              <div key={q} className="overflow-hidden rounded-2xl" style={{ border: "1px solid #e5e7eb" }}>
                <button
                  onClick={() => setOpenFaq(openFaq === i ? null : i)}
                  aria-expanded={openFaq === i}
                  className="flex min-h-12 w-full items-center justify-between gap-3 px-5 py-4 text-start text-base font-semibold"
                >
                  {q}
                  <span className="shrink-0 text-lg" style={{ color: GREEN }}>{openFaq === i ? "−" : "+"}</span>
                </button>
                {openFaq === i && (
                  <p className="px-5 pb-5 text-sm" style={{ color: "#4b5563", lineHeight: 1.9 }}>{a}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      </Scene>

      {/* ═══ SCENE 9 — finale ═══ */}
      <Scene id="s9-finale" className="flex min-h-[80vh] flex-col items-center justify-center px-5 py-24 text-center" style={{ background: "#ffffff", color: "#111827" }}>
        <Rise>
          <h2 className="mx-auto max-w-xl text-3xl font-extrabold sm:text-5xl" style={{ lineHeight: 1.4 }}>{t.fin_h2}</h2>
          <p className="mt-4 text-lg font-semibold" style={{ color: "#4b5563" }}>{t.fin_sub}</p>
        </Rise>
        <Rise delay={0.15}>
          <div className="mt-10 flex w-full max-w-sm flex-col gap-3">
            {result ? (
              /* A scan already ran on this page — continue the real workflow
                 with the result carried over, don't loop back to the top. */
              <Link
                href={t.optimize_href}
                onClick={() => track("cta_click", { cta: "finale_continue" })}
                className="min-h-13 rounded-xl px-8 py-4 text-lg font-bold"
                style={{ background: GREEN, color: "#ffffff" }}
              >
                {t.score_cta}
              </Link>
            ) : (
              <button
                onClick={() => { track("cta_click", { cta: "finale_scan" }); mirrorRef.current?.scrollIntoView({ behavior: reduced ? "auto" : "smooth" }); }}
                className="min-h-13 rounded-xl px-8 py-4 text-lg font-bold"
                style={{ background: GREEN, color: "#ffffff" }}
              >
                {t.fin_scan}
              </button>
            )}
            <Link
              href={t.build_href}
              onClick={() => track("builder_started", { where: "landing_finale" })}
              className="min-h-12 rounded-xl px-8 py-3.5 text-base font-semibold"
              style={{ border: "2px solid #d1d5db", color: "#374151" }}
            >
              {t.fin_build}
            </Link>
          </div>
        </Rise>
        <footer className="mt-20 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs" style={{ color: "#9ca3af" }}>
          <span dir="ltr">© {new Date().getFullYear()} cv.rabit.sa</span>
          <Link href="/terms">{rtl ? "الشروط" : "Terms"}</Link>
          <Link href="/privacy">{rtl ? "الخصوصية" : "Privacy"}</Link>
          <Link href="/templates">{rtl ? "القوالب" : "Templates"}</Link>
          <Link href="/pricing">{rtl ? "الأسعار" : "Pricing"}</Link>
        </footer>
      </Scene>
    </div>
  );
}
