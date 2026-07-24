"use client";
/**
 * JOURNEY — the approved cosmic gated landing, wired to the REAL brain.
 *
 * Structure = the approved prototype (scrollytelling intro → 5 locked stages
 * → finale). Data = the real product: /api/interview turns drive the chat,
 * /api/optimize builds the CV + ATS score, TEMPLATE_CATALOG renders the real
 * templates, PdfExport/DocxExport/PublishLink produce real files, /pricing
 * takes the payment. Nothing on screen is invented: the score is the real
 * matchScore, the paper lines are the brain's real resume_lines.
 *
 * The scroll engine is a faithful port of the prototype's: one rAF loop,
 * lerped progress (P += (target-P)*.085), smoothstep scene visibility, and
 * the traveling orb keyframes — all DOM writes via refs, zero re-renders.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useReducedMotion } from "framer-motion";
import { track } from "@vercel/analytics";
import { useOrbScene } from "./orb/OrbProvider";
import PdfExport from "./PdfExport";
import DocxExport from "./DocxExport";
import PublishLink from "./PublishLink";
import TemplateThumb from "./TemplateThumb";
import ResumeTemplate from "./ResumeTemplate";
import { TEMPLATE_CATALOG } from "../lib/templateCatalog";
import type { TemplateDef } from "../lib/templateCatalog";
import { saveResume } from "../lib/localdata";
import "../journey.css";

type Lang = "ar" | "en";
type OutLang = "en" | "ar" | "both";
interface Msg { who: "ai" | "user"; text: string; typing?: boolean }
interface Chip { label: string; patch?: Record<string, unknown> }
interface Profile {
  role: string; name: string; contact: string; summary: string;
  education: string; skills: string; extras: string[];
  wovenLines: string[]; jobAd: string;
}
const EMPTY: Profile = { role: "", name: "", contact: "", summary: "", education: "", skills: "", extras: [], wovenLines: [], jobAd: "" };

const T = {
  ar: {
    badge: "مدعوم بالذكاء الاصطناعي",
    h1a: "سيرتك تُبنى", h1b: "بالمحادثة", h1c: "سطراً سطراً",
    sub: "العقل الكوني يسألك، تجاوب — والسيرة تتكوّن أمامك لحظياً. دقيقتان، مجاناً، بدون تسجيل.",
    scrollHint: "اسحب لتبدأ الرحلة", scroll: "اسحب",
    cap1a: "من السير الذاتية تُرفضها أنظمة الفرز ATS —", cap1b: "قبل أن يقرأها إنسان",
    db1: "أنا محاسب في شركة مقاولات من ٦ سنوات",
    db2: "يعني تقفل القيود الشهرية — لكم فرع تدير الحسابات؟",
    cap2a: "مقابلة مركّزة تكتب من كلامك أنت —", cap2b: "ولا تختلق رقماً واحداً",
    dpName: "أحمد العتيبي", dpRole: "محاسب أول",
    exp: "الخبرة العملية", edu: "التعليم", skills: "المهارات", extras: "إضافات",
    dpExp: "محاسب أول — المتحدة للمقاولات · ٦ سنوات",
    dpB1: "• خفّض أخطاء القفلة الشهرية ٣٠٪ بأتمتة التسويات",
    dpB2: "• يدير دفاتر ١٥ فرعاً بإيرادات سنوية ٤٠ مليون ريال",
    dpSk: "IFRS · SAP · التقارير المالية · قيادة الفريق",
    cap3: "سيرة احترافية بدرجة توافق ATS — خلال دقيقتين",
    brand: "سيرة", login: "دخول", journey: "رحلتك",
    step: "الخطوة", of5: "من ٥",
    st0t: "دورك — العقل جاهز", st0s: "أجب عن أسئلة المستشار، والسيرة تتبنى قدامك.",
    advisor: "المستشار", online: "متصل",
    greet: "ما مهنتك؟",
    typePh: "اكتب إجابتك…",
    building: "تُبنى الآن…", done2: "اكتملت ✓",
    axes: ["الدور", "الملخص", "الخبرة", "المهارات", "التعليم", "هويتك"],
    sumSec: "الملخص المهني",
    have_cv: "عندي سيرة — حدّثها", tool_pricing: "الأسعار", tool_account: "حسابي",
    paste_ph: "الصق سيرتك الحالية هنا، أو ارفع ملف…",
    upload: "إرفاق ملف", uploading: "جارٍ قراءة الملف…", upload_fail: "تعذّرت قراءة الملف — الصق النص مباشرة.",
    cv_short: "النص قصير — الصق السيرة كاملة.",
    goal_q: "استلمت سيرتك. ما الخطوة التالية؟",
    goal_add: "أضف خبرة", goal_tailor: "فصّلها على وظيفة", goal_improve: "حسّنها",
    jobad_q: "الصق إعلان الوظيفة، أو اكتب «تخطَّ»",
    skip: "تخطَّ",
    net_fail: "انقطع الاتصال لحظة — إجابتك محفوظة.", retry: "أعد المحاولة",
    edit_prompt: "عدّل السطر:",
    welcome_back: "أهلاً بعودتك. نكمل من حيث توقفنا؟",
    continue_btn: "متابعة", restart_btn: "من جديد",
    mic_title: "أجب صوتياً",
    st1t: "درجتك", st1s: "هكذا تقرأك أنظمة الفرز.",
    lock1: "أكمل المقابلة أولاً", lock2: "شاهد درجتك أولاً", lock3: "اختر التصميم أولاً",
    lock4: "حمّل سيرتك أولاً", lock5: "خطوة واحدة تفصلك",
    scoreLbl: "درجة توافق سيرتك مع ATS", scoring: "يحسب درجتك…",
    verdict_hi: "قوي — جاهز للتقديم", verdict_mid: "جيد — خطوة أقرب", verdict_low: "يحتاج تحسيناً — وقد حُسّن فعلاً",
    score_note: "القالب عمود واحد متوافق مع القراءة الآلية ✓",
    build_fail: "استغرق الأمر أكثر من المعتاد — إعادة المحاولة؟",
    next1: "اختر تصميمك ↓",
    st2t: "لوّن سيرتك", st2s: "اختيار واحد — وسيرتك تتلوّن فوراً.",
    browse_templates: "كل القوالب ←",
    st3t: "خذها معك", st3s: "PDF للتقديم، Word للتعديل.",
    lang_pick: "لغة السيرة:", lang_opts: { en: "English", ar: "العربية", both: "الاثنين" } as Record<string, string>,
    lang_err: "تعذّر التحويل — حاول مرة أخرى.",
    wm_note: "النسخة المجانية تحمل علامة مائية — تُزال بالباقة.",
    st4t: "آخر خطوة", st4s: "اختر ما يناسبك — أو أكمل مجاناً بالعلامة المائية.",
    p1n: "يوم كامل", p2n: "٩٠ يوماً",
    sar: " ريال", once: "دفعة واحدة",
    p1a: "كل الأدوات والقوالب", p1b: "بدون علامة مائية", p1c: "وصول كامل ٢٤ ساعة",
    p2a: "كل مزايا اليوم الكامل", p2b: "وصول مفتوح ٩٠ يوماً", p2c: "مثالي لموسم توظيف نشط", p2d: "ضمان استرداد ٧ أيام",
    bestVal: "الأفضل قيمة", choose: "اختر", chooseB: "اختر الحزمة",
    freeLink: "أكمل مجاناً — بالعلامة المائية",
    planDay: "يوم كامل — ٣٥ ريالاً", plan90: "٩٠ يوماً — ٩٩ ريالاً", freePlan: "مجاني — بالعلامة مائية",
    finTa: "سيرتك", finTb: "بين يديك",
    finS: "بنيتها وأنت تشرب قهوتك — وهذا ملخص رحلتك:",
    sumTplP: "قالب", sumScoreP: "درجة",
    dlAgain: "↓ تحميل مرة ثانية", restart: "ابدأ من جديد",
    afterCv: "وما بعد السيرة — أدواتك تكمل معك:",
    t1: "تحضير المقابلات", t1d: "أسئلة متوقعة على دورك بالضبط مع إجابات نموذجية مبنية على سيرتك.",
    t2: "مقابلة فيديو مباشرة", t2d: "تدرّب بصوتك مع محاور ذكي يقيّم إجاباتك ويعطيك ملاحظات فورية.",
    t3: "تحسين لينكدإن", t3d: "ملف متناسق مع سيرتك — عناوين ونبذة وكلمات يبحث عنها مسؤولو التوظيف.",
    q1: "هل الذكاء يختلق خبرات أو أرقام؟",
    a1: "أبداً. القاعدة الأولى هي الصدق: يعيد صياغة ما تكتبه أنت فقط بلغة مهنية، وأي رقم ناقص يُترك لك مكان مخصص لتعبئته بنفسك.",
    q2: "هل السيرة متوافقة مع أنظمة ATS؟",
    a2: "نعم — كل القوالب بعمود واحد وبدون جداول تكسر القراءة الآلية، وتظهر لك درجة توافق واضحة قبل التحميل.",
    q3: "أحتاج أسوّي حساب؟",
    a3: "لا. بنيت سيرتك كاملة الآن بدون تسجيل. الحساب اختياري فقط لحفظ سيرك سحابياً.",
    footBrand: "سيرة — cv.rabit.sa", terms: "الشروط", privacy: "الخصوصية", contact: "الأسعار",
  },
  en: {
    badge: "Powered by AI",
    h1a: "Your resume, built", h1b: "by conversation", h1c: "line by line",
    sub: "The cosmic mind asks, you answer — and your resume materializes live. Two minutes, free, no signup.",
    scrollHint: "Scroll to begin the journey", scroll: "Scroll",
    cap1a: "of resumes are filtered out by ATS screening —", cap1b: "before a human ever reads them",
    db1: "I've been an accountant at a construction firm for 6 years",
    db2: "So you close monthly books — for how many branches?",
    cap2a: "A focused interview that writes from your words —", cap2b: "and never invents a number",
    dpName: "Ahmed Al-Otaibi", dpRole: "Senior Accountant",
    exp: "EXPERIENCE", edu: "EDUCATION", skills: "SKILLS", extras: "ADDITIONAL",
    dpExp: "Senior Accountant — United Contracting · 6 years",
    dpB1: "• Cut monthly-close errors 30% by automating reconciliations",
    dpB2: "• Managed books for 15 branches, SAR 40M annual revenue",
    dpSk: "IFRS · SAP · Financial Reporting · Team Leadership",
    cap3: "A professional resume with an ATS score — in two minutes",
    brand: "Sira", login: "Sign in", journey: "Journey",
    step: "Step", of5: "of 5",
    st0t: "Your turn — the mind is ready", st0s: "Answer the Advisor's questions, and the resume builds in front of you.",
    advisor: "Advisor", online: "online",
    greet: "What's your current role?",
    typePh: "Type your answer…",
    building: "Building…", done2: "Complete ✓",
    axes: ["Role", "Summary", "Experience", "Skills", "Education", "Identity"],
    sumSec: "PROFESSIONAL SUMMARY",
    have_cv: "I have a resume — update it", tool_pricing: "Pricing", tool_account: "Account",
    paste_ph: "Paste your current resume here, or upload a file…",
    upload: "Upload file", uploading: "Reading file…", upload_fail: "Couldn't read the file — paste the text instead.",
    cv_short: "That's too short — paste the full resume.",
    goal_q: "Got your resume. What's next?",
    goal_add: "Add experience", goal_tailor: "Tailor to a job", goal_improve: "Improve it",
    jobad_q: "Paste the job ad, or type “skip”",
    skip: "skip",
    net_fail: "Connection hiccup — your answer is saved.", retry: "Retry",
    edit_prompt: "Edit this line:",
    welcome_back: "Welcome back. Continue where we left off?",
    continue_btn: "Continue", restart_btn: "Start fresh",
    mic_title: "Answer by voice",
    st1t: "Your score", st1s: "This is how screening systems read you.",
    lock1: "Finish the interview first", lock2: "See your score first", lock3: "Pick a design first",
    lock4: "Download your resume first", lock5: "One step away",
    scoreLbl: "Your resume's ATS match score", scoring: "Scoring…",
    verdict_hi: "Strong — ready to apply", verdict_mid: "Good — one step closer", verdict_low: "Needed work — and got it",
    score_note: "Single-column, machine-readable template ✓",
    build_fail: "This took longer than usual — retry?",
    next1: "Pick your design ↓",
    st2t: "Color your resume", st2s: "One pick — and it recolors instantly.",
    browse_templates: "All templates ←",
    st3t: "Take it with you", st3s: "PDF to apply, Word to tweak.",
    lang_pick: "Resume language:", lang_opts: { en: "English", ar: "العربية", both: "Both" } as Record<string, string>,
    lang_err: "Conversion failed — try again.",
    wm_note: "The free copy carries a watermark — removed with any plan.",
    st4t: "One last step", st4s: "Choose what fits — or continue free with the watermark.",
    p1n: "Full Day", p2n: "90 Days",
    sar: " SAR", once: "one-time",
    p1a: "Every tool & template", p1b: "No watermark", p1c: "24-hour full access",
    p2a: "Everything in Full Day", p2b: "90-day open access", p2c: "Ideal for an active job hunt", p2d: "7-day money-back guarantee",
    bestVal: "Best value", choose: "Choose", chooseB: "Get it",
    freeLink: "Continue free — with watermark",
    planDay: "Full Day — SAR 35", plan90: "90 Days — SAR 99", freePlan: "Free — with watermark",
    finTa: "Your resume is", finTb: "yours",
    finS: "You built it over a coffee — here's your journey:",
    sumTplP: "Template", sumScoreP: "Score",
    dlAgain: "↓ Download again", restart: "Start over",
    afterCv: "Beyond the resume — your tools continue:",
    t1: "Interview Prep", t1d: "Expected questions for your exact role, with model answers built from your resume.",
    t2: "Live Video Interview", t2d: "Practice out loud with an AI interviewer that scores your answers instantly.",
    t3: "LinkedIn Optimizer", t3d: "A profile aligned with your resume — headline, about, and keywords recruiters search.",
    q1: "Does the AI invent experience or numbers?",
    a1: "Never. Rule one is honesty: it only rephrases what you write into professional language, and any missing number is left as a slot for you to fill.",
    q2: "Is the resume ATS-compatible?",
    a2: "Yes — every template is single-column with no parsing-breaking tables, and you see a clear match score before downloading.",
    q3: "Do I need an account?",
    a3: "No. You just built a full resume with no signup. An account is optional — only to save your resumes in the cloud.",
    footBrand: "Sira — cv.rabit.sa", terms: "Terms", privacy: "Privacy", contact: "Pricing",
  },
};

/* fetch with timeout */
async function fetchT(url: string, body: object, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}
/* read the ndjson stream from /api/optimize */
async function readNdjson(res: Response, field: string): Promise<{ text: string; score?: number; watermark?: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: "" };
  const dec = new TextDecoder();
  let buf = ""; let text = ""; let score: number | undefined; let watermark: boolean | undefined;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n"); buf = lines.pop() || "";
    for (const ln of lines) {
      if (!ln.trim()) continue;
      try {
        const msg = JSON.parse(ln);
        if (msg.t === "result") { if (msg.d?.[field]) text = msg.d[field]; if (typeof msg.d?.matchScore === "number") score = msg.d.matchScore; watermark = msg.d?.watermark; }
      } catch { /* partial line */ }
    }
  }
  return { text, score, watermark };
}

/* typewriter for AI messages */
function TypedText({ text, onDone, instant }: { text: string; onDone: () => void; instant: boolean }) {
  const [n, setN] = useState(instant ? text.length : 0);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  useEffect(() => {
    if (n >= text.length) { doneRef.current(); return; }
    const id = setTimeout(() => setN((v) => v + 1), 24);
    return () => clearTimeout(id);
  }, [n, text]);
  return <>{text.slice(0, n)}{n < text.length && <span className="jn-caret" />}</>;
}

const AR_NUM = ["١", "٢", "٣", "٤", "٥"];
const CIRC = 402; // ring circumference

export default function Journey({ lang }: { lang: Lang }) {
  const t = T[lang];
  const rtl = lang === "ar";
  const DRAFT_KEY = `ra_journey_${lang}`;
  const reduce = useReducedMotion() ?? false;

  // the shared site orb yields to the journey's own traveling orb
  useOrbScene(null, []);

  /* ── journey state ── */
  const [stage, setStage] = useState(0);           // highest unlocked stage (0..5)
  const [justOpened, setJustOpened] = useState(-1);
  const [introDone, setIntroDone] = useState(false);

  /* ── interview state ── */
  const [profile, setProfile] = useState<Profile>(EMPTY);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [chips, setChips] = useState<Chip[]>([]);
  const [thinking, setThinking] = useState(false);
  const [progress, setProgress] = useState(0);
  const [netFail, setNetFail] = useState(false);
  const [started, setStarted] = useState(false);
  const [welcomeBack, setWelcomeBack] = useState(false);
  const [takeover, setTakeover] = useState(false);   // interview owns the screen until the CV is built
  const [paperOpen, setPaperOpen] = useState(false); // mobile bottom-sheet for the live paper

  /* ── update mode ── */
  const [mode, setMode] = useState<"new" | "update">("new");
  const [pasteMode, setPasteMode] = useState(false);
  const [cvBase, setCvBase] = useState("");
  const [uploading, setUploading] = useState(false);
  const [goalMode, setGoalMode] = useState(false);
  const [jobAdMode, setJobAdMode] = useState<null | "add" | "tailor">(null);

  /* ── build / score / templates / download / plans ── */
  const [cv, setCv] = useState("");
  const [score, setScore] = useState<{ value: number; watermark: boolean } | null>(null);
  const [scorePhase, setScorePhase] = useState<"idle" | "working" | "done" | "failed">("idle");
  const [buildFail, setBuildFail] = useState(false);
  const [tpl, setTpl] = useState<TemplateDef>(TEMPLATE_CATALOG[0]);
  const [tplPicked, setTplPicked] = useState(false);
  const [outChoice, setOutChoice] = useState<OutLang>(lang);
  const [langBusy, setLangBusy] = useState(false);
  const [langErr, setLangErr] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [plan, setPlan] = useState("");
  const [next1Shown, setNext1Shown] = useState(false);

  /* ── voice ── */
  const [micOn, setMicOn] = useState(false);
  const [micSupported, setMicSupported] = useState(false);
  const recRef = useRef<{ stop: () => void } | null>(null);
  const startedTrackRef = useRef(false);

  /* ── scroll-engine refs ── */
  const trackRef = useRef<HTMLDivElement>(null);
  const orbRef = useRef<HTMLDivElement>(null);
  const progRef = useRef<HTMLDivElement>(null);
  const progNumRef = useRef<HTMLDivElement>(null);
  const progBarRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLDivElement>(null);
  const giantRef = useRef<HTMLSpanElement>(null);
  const sceneRefs = useRef<(HTMLDivElement | null)[]>([]);
  const bitRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const stageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const msgsRef = useRef<HTMLDivElement>(null);
  const ringFgRef = useRef<SVGCircleElement>(null);
  const scoreNumRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingAns = useRef("");

  /* ═══ intro fade ═══ */
  useEffect(() => {
    const id = setTimeout(() => setIntroDone(true), 850);
    return () => clearTimeout(id);
  }, []);

  /* ═══ mic support + draft restore ═══ */
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    setMicSupported(Boolean(w.webkitSpeechRecognition || w.SpeechRecognition));
    try {
      const saved = localStorage.getItem(DRAFT_KEY);
      if (saved) { const d = JSON.parse(saved); if (Array.isArray(d?.msgs) && d.msgs.length > 0) setWelcomeBack(true); }
    } catch { /* noop */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ═══ THE SCROLL ENGINE — faithful port of the prototype ═══ */
  useEffect(() => {
    const trackEl = trackRef.current;
    if (!trackEl) return;
    const orbKeys = [[50, 33, 1], [82, 20, 0.46], [80, 74, 0.5], [76, 58, 0.86], [76, 58, 0.86]];
    const chatBits: [string, number][] = [["db1", 0.12], ["db2", 0.5], ["cap2", 0.82]];
    const paperBits: [string, number][] = [["dl1", 0.08], ["dl2", 0.32], ["dl3", 0.56], ["dl4", 0.78], ["cap3", 0.9]];
    const sstep = (a: number, b: number, x: number) => { x = Math.min(1, Math.max(0, (x - a) / (b - a))); return x * x * (3 - 2 * x); };
    const lerp = (a: number, b: number, tt: number) => a + (b - a) * tt;
    let P = 0;
    let raf = 0;

    const paint = () => {
      const H = window.innerHeight, W = window.innerWidth;
      const scenes = sceneRefs.current;
      const done = P > 0.985;
      if (progRef.current) progRef.current.style.opacity = done ? "0" : "1";
      if (progNumRef.current) progNumRef.current.textContent = Math.round(P * 100) + "%";
      if (progBarRef.current) progBarRef.current.style.width = (P * 100) + "%";
      if (pillRef.current) pillRef.current.style.opacity = done ? "1" : "0";
      const f = P * scenes.length, i = Math.min(scenes.length - 1, Math.floor(f)), tt = f - i;
      const k0 = orbKeys[i], k1 = orbKeys[i + 1];
      const ox = lerp(k0[0], k1[0], tt), oy = lerp(k0[1], k1[1], tt), os = lerp(k0[2], k1[2], tt);
      if (orbRef.current) {
        orbRef.current.style.opacity = done ? "0" : "1";
        orbRef.current.style.transform = `translate3d(calc(${(ox / 100 * W)}px - 115px),calc(${(oy / 100 * H)}px - 115px),0) scale(${os})`;
      }
      const seg = 1 / scenes.length;
      scenes.forEach((sc, j) => {
        if (!sc) return;
        const sp = Math.min(1, Math.max(0, (P - j * seg) / seg));
        const vis = (j === scenes.length - 1) ? sstep(0, 0.14, sp) : sstep(0, 0.14, sp) * (1 - sstep(0.88, 1, sp));
        sc.style.opacity = String(vis);
        sc.style.transform = `translateY(${(1 - sstep(0, 0.2, sp)) * 34}px)`;
      });
      const spOf = (j: number) => Math.min(1, Math.max(0, (P - j * seg) / seg));
      if (giantRef.current) giantRef.current.textContent = String(Math.round(sstep(0.08, 0.8, spOf(1)) * 75));
      const sp2 = spOf(2);
      chatBits.forEach(([id, th]) => {
        const el = bitRefs.current[id]; if (!el) return;
        const v = sstep(th, th + 0.16, sp2);
        el.style.opacity = String(v);
        el.style.transform = `translateY(${(1 - v) * 16}px) scale(${0.94 + 0.06 * v})`;
      });
      const sp3 = spOf(3);
      paperBits.forEach(([id, th]) => {
        const el = bitRefs.current[id]; if (!el) return;
        const v = sstep(th, th + 0.15, sp3);
        el.style.opacity = String(v);
        el.style.transform = `translateY(${(1 - v) * 12}px)`;
        el.style.filter = `blur(${(1 - v) * 4}px)`;
      });
    };

    if (reduce) { P = 1; paint(); return; }
    paint(); // first frame — establishes the initial scene/orb/progress state
    const loop = () => {
      const target = Math.min(1, Math.max(0, window.scrollY / (trackEl.offsetHeight - window.innerHeight)));
      // sleep when settled — no painting unless the scroll actually moved
      if (Math.abs(target - P) > 0.0004) {
        P += (target - P) * 0.085;
        paint();
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [reduce]);

  /* ═══ reveal-on-scroll for tools/faq/footer ═══ */
  useEffect(() => {
    const els = document.querySelectorAll(".jn-rv");
    const io = new IntersectionObserver((es) => {
      es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } });
    }, { threshold: 0.16 });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  /* ═══ chat autoscroll ═══ */
  useEffect(() => {
    msgsRef.current?.scrollTo({ top: msgsRef.current.scrollHeight, behavior: reduce ? "auto" : "smooth" });
  }, [msgs, thinking, reduce]);

  /* ═══ stage system ═══ */
  const stageRef = useRef(0);
  const unlockTo = useCallback((n: number) => {
    if (n <= stageRef.current) return;
    stageRef.current = n;
    setStage(n);
    setJustOpened(n);
    setTimeout(() => stageRefs.current[n]?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" }), 300);
    setTimeout(() => setJustOpened(-1), 1400);
    persist({ stage: n });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduce]);
  const unlockNext = useCallback(() => unlockTo(stageRef.current + 1), [unlockTo]);

  /* ═══ persistence ═══ */
  const persist = useCallback((next: Partial<{ profile: Profile; msgs: Msg[]; mode: string; cvBase: string; progress: number; cv: string; score: { value: number; watermark: boolean } | null; stage: number }>) => {
    try {
      const cur = { profile, msgs: msgs.slice(-30), mode, cvBase, progress, cv, score, stage: stageRef.current };
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...cur, ...next, msgs: (next.msgs ?? msgs).slice(-30).map((m) => ({ who: m.who, text: m.text })) }));
    } catch { /* noop */ }
  }, [profile, msgs, mode, cvBase, progress, cv, score, DRAFT_KEY]);

  function restoreDraft() {
    try {
      const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || "{}");
      if (d?.profile) setProfile({ ...EMPTY, ...d.profile });
      if (Array.isArray(d?.msgs)) setMsgs(d.msgs);
      if (typeof d?.progress === "number") setProgress(d.progress);
      if (d?.mode === "update") { setMode("update"); if (typeof d.cvBase === "string") setCvBase(d.cvBase); }
      // a finished build resumes AT the result, not at the interview
      if (typeof d?.cv === "string" && d.cv && d.score && typeof d.score.value === "number") {
        setCv(d.cv);
        setScore({ value: d.score.value, watermark: d.score.watermark !== false });
        setScorePhase("done");
        const st = Math.max(1, Math.min(5, Number(d.stage) || 1));
        stageRef.current = st;
        setStage(st);
        if (typeof d.progress !== "number") setProgress(100);
      }
      setStarted(true);
    } catch { /* keep fresh */ }
    setWelcomeBack(false);
  }
  function hardRestart() {
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* noop */ }
    window.location.reload();
  }

  /* ═══ merge a profile_patch from the brain ═══ */
  function mergePatch(p: Profile, patch: Record<string, unknown>): Profile {
    const n = { ...p, extras: [...p.extras], wovenLines: [...p.wovenLines] };
    if (typeof patch.name === "string" && patch.name) n.name = patch.name.slice(0, 100);
    if (typeof patch.contact === "string" && patch.contact) n.contact = patch.contact.slice(0, 200);
    if (typeof patch.role === "string" && patch.role) n.role = patch.role.slice(0, 120);
    if (typeof patch.targetRole === "string" && patch.targetRole) n.role = patch.targetRole.slice(0, 120);
    if (typeof patch.summary === "string" && patch.summary) n.summary = patch.summary.slice(0, 700);
    if (typeof patch.education === "string" && patch.education) n.education = patch.education.slice(0, 400);
    if (typeof patch.certifications === "string" && patch.certifications) {
      const cert = patch.certifications.slice(0, 300);
      if (!n.education.includes(cert)) n.education = n.education ? `${n.education}\n${cert}` : cert;
    }
    if (typeof patch.skills === "string" && patch.skills) n.skills = String(patch.skills).slice(0, 400);
    if (Array.isArray(patch.skills)) n.skills = patch.skills.map(String).filter(Boolean).slice(0, 12).join("، ");
    if (typeof patch.jobAd === "string" && patch.jobAd) n.jobAd = patch.jobAd.slice(0, 3000);
    if (Array.isArray(patch.extras)) n.extras.push(...patch.extras.map(String).slice(0, 6));
    if (Array.isArray(patch.experiences)) {
      for (const ex of patch.experiences as Array<Record<string, unknown>>) {
        // header may arrive as a string or as {title, company, start_date}
        let head = "";
        if (typeof ex?.header === "string") head = ex.header;
        else if (ex?.header && typeof ex.header === "object") {
          const h = ex.header as Record<string, unknown>;
          head = [h.title, h.company].filter(Boolean).join(" — ") + (h.start_date ? ` | ${h.start_date}` : "");
        }
        const bullets = Array.isArray(ex?.bullets) ? (ex.bullets as unknown[]).map((b) => `- ${String(b).replace(/^[-•]\s*/, "")}`) : [];
        if (!head) { n.wovenLines.push(...bullets); continue; }
        const at = n.wovenLines.indexOf(head);
        if (at === -1) {
          n.wovenLines.push(head, ...bullets);
        } else {
          // replace the existing entry (header + its bullets up to the next header)
          let end = at + 1;
          while (end < n.wovenLines.length && /^[-•]/.test(n.wovenLines[end].trim())) end++;
          n.wovenLines.splice(at, end - at, head, ...bullets);
        }
      }
    }
    return n;
  }

  /* ═══ THE BRAIN TURN — real /api/interview ═══ */
  async function sendTurn(answer: string, seedProfile?: Profile) {
    const base = seedProfile ?? profile;
    const history = msgs.slice(-10);
    setThinking(true);
    setNetFail(false);
    pendingAns.current = answer;
    orbRef.current?.classList.add("thinking");
    let data: { action?: string; axis?: number; say?: string; profile_patch?: Record<string, unknown>; resume_lines?: string[]; chips?: Chip[]; progress?: number } | null = null;
    for (let attempt = 0; attempt < 2 && !data; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 2500));
      try {
        const res = await fetchT("/api/interview", {
          action: "turn", lang: outChoice, answer,
          targetRole: base.role,
          profile: { role: base.role, name: base.name, contact: base.contact, education: base.education, skills: base.skills, summary: base.summary, wovenLines: base.wovenLines.slice(-30), outputLang: outChoice },
          history: history.map((m) => ({ who: m.who, text: m.text })),
        }, 90000);
        const j = await res.json();
        if (res.ok && (j.say || (Array.isArray(j.resume_lines) && j.resume_lines.length))) data = j;
      } catch { /* retry */ }
    }
    setThinking(false);
    orbRef.current?.classList.remove("thinking");
    if (!data) { setNetFail(true); return; }
    const merged = mergePatch(base, data.profile_patch || {});
    // FINISH recaps are ignored — the profile already holds every line
    const newLines = data.action === "FINISH" ? [] : (Array.isArray(data.resume_lines) ? data.resume_lines.map(String).filter(Boolean) : []);
    for (const ln of newLines) if (!merged.wovenLines.includes(ln)) merged.wovenLines.push(ln);
    setProfile(merged);
    if (typeof data.progress === "number") {
      const pv = data.progress > 0 && data.progress <= 1 ? data.progress * 100 : data.progress;
      setProgress((prev) => Math.max(prev, Math.min(100, Math.round(pv))));
    }
    setChips(Array.isArray(data.chips) ? data.chips.slice(0, 4) : []);
    const say = String(data.say || "").trim();
    // functional append — never overwrite the user's just-added bubble (stale-state bug)
    setMsgs((m) => {
      const next: Msg[] = say ? [...m, { who: "ai", text: say, typing: true }] : m;
      persist({ profile: merged, msgs: next });
      return next;
    });
    if (data.action === "FINISH") {
      if (say) finalizeRef.current = true;   // finalize after the farewell types out
      else finalize(merged);                  // no farewell — build immediately
    }
  }

  /* ═══ send handler ═══ */
  async function onSend(raw?: string) {
    const text = (raw ?? input).trim();
    if (!text) return;
    setInput("");
    if (!startedTrackRef.current) { startedTrackRef.current = true; track("interview_started", { lang }); }
    track("question_answered", {});

    if (pasteMode) {
      if (text.length < 100) { setMsgs((m) => [...m, { who: "ai", text: t.cv_short, typing: true }]); return; }
      setCvBase(text.slice(0, 8000)); setPasteMode(false); setMode("update"); setGoalMode(true);
      setMsgs((m) => [...m, { who: "user", text: text.slice(0, 60) + "…" }, { who: "ai", text: t.goal_q, typing: true }]);
      return;
    }
    if (jobAdMode) {
      const isSkip = new RegExp(`^(${t.skip}|تخط|skip|لا|no)`, "i").test(text);
      const jd = isSkip ? "" : text.slice(0, 3000);
      const p2 = { ...profile, jobAd: jd };
      setProfile(p2);
      setMsgs((m) => [...m, { who: "user", text: isSkip ? t.skip : text.slice(0, 60) }]);
      const jm = jobAdMode; setJobAdMode(null);
      if (jm === "tailor") runUpdate(p2);
      else sendTurn(lang === "ar" ? "خلّنا نكمل" : "let's continue", p2);
      return;
    }
    setMsgs((m) => [...m, { who: "user", text }]);
    setChips([]);
    sendTurn(text);
  }

  function pickChip(c: Chip) {
    const patched = c.patch ? mergePatch(profile, c.patch) : profile;
    if (c.patch) setProfile(patched);
    setChips([]);
    const text = c.label.replace(/^[➕🎯✨\s]+/, "").trim();
    if (!text) return;
    if (!startedTrackRef.current) { startedTrackRef.current = true; track("interview_started", { lang }); }
    setMsgs((m) => [...m, { who: "user", text }]);
    sendTurn(text, patched);
  }

  /* ═══ update-mode entry ═══ */
  function startUpdate() {
    if (!startedTrackRef.current) { startedTrackRef.current = true; track("interview_started", { lang, mode: "update" }); }
    setStarted(true);
    setPasteMode(true);
    setMsgs((m) => [...m, { who: "ai", text: t.paste_ph, typing: true }]);
  }
  async function onFile(file: File | null) {
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData(); fd.append("file", file);
      const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 45000);
      let res: Response;
      try { res = await fetch("/api/extract", { method: "POST", body: fd, signal: ctrl.signal }); } finally { clearTimeout(timer); }
      const j = await res.json();
      if (!res.ok || !j.text) throw new Error("failed");
      setInput(j.text);
    } catch { setMsgs((m) => [...m, { who: "ai", text: t.upload_fail, typing: true }]); }
    finally { setUploading(false); }
  }
  function chooseGoal(goal: "add" | "tailor" | "improve") {
    setGoalMode(false);
    const label = goal === "add" ? t.goal_add : goal === "tailor" ? t.goal_tailor : t.goal_improve;
    setMsgs((m) => [...m, { who: "user", text: label }]);
    if (goal === "improve") { runUpdate(profile); return; }
    setJobAdMode(goal);
    setMsgs((m) => [...m, { who: "ai", text: t.jobad_q, typing: true }]);
  }

  /* ═══ assemble + finalize (real /api/optimize) ═══ */
  const finalizeRef = useRef(false);
  function assembleResume(p: Profile): string {
    // canonical ATS order: header → summary → experience → skills → education → extras
    const parts: string[] = [];
    if (p.name) parts.push(p.name);
    if (p.contact) parts.push(p.contact);
    if (p.role) parts.push(p.role);
    if (p.summary) parts.push(`\n${rtl ? "الملخص المهني" : "PROFESSIONAL SUMMARY"}\n${p.summary}`);
    if (p.wovenLines.length) parts.push(`\n${rtl ? "الخبرة العملية" : "WORK EXPERIENCE"}\n${p.wovenLines.join("\n")}`);
    if (p.skills) parts.push(`\n${rtl ? "المهارات" : "SKILLS"}\n${p.skills}`);
    if (p.education) parts.push(`\n${rtl ? "التعليم والشهادات" : "EDUCATION & CERTIFICATIONS"}\n${p.education}`);
    if (p.extras.length) parts.push(`\n${rtl ? "إضافات" : "ADDITIONAL"}\n${p.extras.map((x) => `- ${x}`).join("\n")}`);
    return parts.join("\n");
  }
  async function finalize(p: Profile) {
    setScorePhase("working"); setBuildFail(false);
    try {
      const resumeText = assembleResume(p).slice(0, 8000);
      const jd = p.jobAd.trim().length >= 30 ? p.jobAd : "";
      const res = await fetchT("/api/optimize", { resume: resumeText, jobDescription: jd, outLang: outChoice }, 90000);
      const { text: opt, score: sc, watermark } = await readNdjson(res, "optimizedResume");
      if (!opt) throw new Error("empty");
      setCv(opt);
      if (typeof sc === "number") {
        const sc2 = { value: sc, watermark: watermark !== false };
        setScore(sc2); setScorePhase("done");
        persist({ cv: opt, score: sc2, stage: 1 });
      } else setScorePhase("failed");
      track("cv_completed", { lang, mode });
      try { saveResume({ title: `${p.name || "CV"} — ${p.role || "journey"}`, source: "built", text: opt }); } catch { /* noop */ }
    } catch { setBuildFail(true); setScorePhase("failed"); }
  }
  async function runUpdate(p: Profile) {
    setScorePhase("working"); setBuildFail(false);
    try {
      const additions = [...p.wovenLines, ...p.extras.map((x) => `- ${x}`)].join("\n");
      const resumeText = (additions
        ? `${cvBase}\n\nADDITIONAL EXPERIENCE CONFIRMED BY THE CANDIDATE (integrate these real facts):\n${additions}`
        : cvBase).slice(0, 8000);
      const jd = p.jobAd.trim().length >= 30 ? p.jobAd : "";
      const res = await fetchT("/api/optimize", { resume: resumeText, jobDescription: jd, outLang: outChoice }, 90000);
      const { text: opt, score: sc, watermark } = await readNdjson(res, "optimizedResume");
      if (!opt) throw new Error("empty");
      setCv(opt);
      if (typeof sc === "number") {
        const sc2 = { value: sc, watermark: watermark !== false };
        setScore(sc2); setScorePhase("done");
        persist({ cv: opt, score: sc2, stage: 1 });
      } else setScorePhase("failed");
      track("cv_completed", { lang, mode: "update" });
      try { saveResume({ title: `${p.name || "CV"} — ${rtl ? "محدثة" : "updated"}`, source: "optimized", text: opt }); } catch { /* noop */ }
    } catch { setBuildFail(true); setScorePhase("failed"); }
  }

  /* ═══ output language switch (real re-optimize) ═══ */
  async function switchLang(choice: OutLang, force = false) {
    if (langBusy || (choice === outChoice && !force)) return;
    setOutChoice(choice); setLangBusy(true); setLangErr(false);
    try {
      const source = (mode === "update" ? cvBase || cv : assembleResume(profile)).slice(0, 8000);
      const jd = profile.jobAd.trim().length >= 30 ? profile.jobAd : "";
      const res = await fetchT("/api/optimize", { resume: source, jobDescription: jd, outLang: choice }, 90000);
      const { text: opt } = await readNdjson(res, "optimizedResume");
      if (!opt) throw new Error("empty");
      setCv(opt);
    } catch { setLangErr(true); }
    finally { setLangBusy(false); }
  }

  /* ═══ voice ═══ */
  function toggleMic() {
    if (micOn) { recRef.current?.stop(); return; }
    const w = window as unknown as { webkitSpeechRecognition?: new () => SR; SpeechRecognition?: new () => SR };
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) return;
    interface SR { lang: string; interimResults: boolean; continuous: boolean; onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onend: (() => void) | null; onerror: (() => void) | null; start: () => void; stop: () => void }
    const rec = new Ctor();
    rec.lang = lang === "ar" ? "ar-SA" : "en-US";
    rec.interimResults = true; rec.continuous = false;
    rec.onresult = (e) => {
      const res = e.results[e.results.length - 1];
      if (res?.[0]) setInput(res[0].transcript);
    };
    rec.onend = () => setMicOn(false);
    rec.onerror = () => setMicOn(false);
    recRef.current = rec;
    setMicOn(true);
    rec.start();
  }

  /* ═══ tap-to-edit a woven line (clear the field to delete it) ═══ */
  function editLine(idx: number) {
    const cur = profile.wovenLines[idx];
    const next = window.prompt(t.edit_prompt, cur.replace(/^- /, ""));
    if (next == null) return;
    setProfile((p) => {
      const wl = [...p.wovenLines];
      if (!next.trim()) wl.splice(idx, 1);
      else wl[idx] = cur.startsWith("- ") ? `- ${next.trim()}` : next.trim();
      return { ...p, wovenLines: wl };
    });
  }
  function editSummary() {
    const next = window.prompt(t.edit_prompt, profile.summary);
    if (next == null || !next.trim()) return;
    setProfile((p) => ({ ...p, summary: next.trim() }));
  }

  /* ═══ greet when the interview stage scrolls into view ═══ */
  useEffect(() => {
    const el = stageRefs.current[0];
    if (!el || started || welcomeBack) return;
    const io = new IntersectionObserver((es) => {
      es.forEach((e) => {
        if (e.isIntersecting && !started) {
          setStarted(true);
          setMsgs((m) => (m.length ? m : [{ who: "ai", text: t.greet, typing: true }]));
          io.disconnect();
        }
      });
    }, { threshold: 0.35 });
    io.observe(el);
    return () => io.disconnect();
  }, [started, welcomeBack, t.greet]);

  /* ═══ FINISH → finalize after the last message types out ═══ */
  const lastMsgTyping = msgs.length > 0 && msgs[msgs.length - 1].typing === true;
  const handleTypedDone = useCallback(() => {
    setMsgs((m) => {
      if (!m.length || !m[m.length - 1].typing) return m;
      const next = [...m];
      next[next.length - 1] = { ...next[next.length - 1], typing: false };
      return next;
    });
    if (finalizeRef.current) {
      finalizeRef.current = false;
      setTimeout(() => finalize(profileRef.current), 400);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const profileRef = useRef(profile);
  profileRef.current = profile;

  /* ═══ score ring animation when stage 1 opens ═══ */
  useEffect(() => {
    if (stage < 1 || scorePhase !== "done" || !score) return;
    const target = score.value;
    const t1 = setTimeout(() => { if (ringFgRef.current) ringFgRef.current.style.strokeDashoffset = String(CIRC - (CIRC * target) / 100); }, 300);
    let raf = 0; let t0: number | null = null;
    if (reduce) { if (scoreNumRef.current) scoreNumRef.current.textContent = String(target); setNext1Shown(true); }
    else {
      const tick = (ts: number) => {
        if (!t0) t0 = ts;
        const p = Math.min((ts - t0) / 1500, 1);
        if (scoreNumRef.current) scoreNumRef.current.textContent = String(Math.round(target * (1 - Math.pow(1 - p, 3))));
        if (p < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }
    const t2 = setTimeout(() => setNext1Shown(true), reduce ? 400 : 2100);
    return () => { clearTimeout(t1); clearTimeout(t2); cancelAnimationFrame(raf); };
  }, [stage, scorePhase, score, reduce]);

  /* ═══ TAKEOVER — once the conversation starts, it owns the screen (scroll
     locked, stages hidden behind) until the CV is built; then it releases and
     the journey glides to the score stage ═══ */
  useEffect(() => {
    if (!started) return;
    // hard scroll lock: pinning the body collapses the document's scroll range,
    // so neither wheel nor programmatic scrolling can move past the conversation
    let lockedAt = 0;
    const lock = () => {
      lockedAt = window.scrollY;
      document.documentElement.style.overflow = "hidden";
      document.body.style.overflow = "hidden";
      document.body.style.position = "fixed";
      document.body.style.top = `-${lockedAt}px`;
      document.body.style.width = "100%";
      document.body.classList.add("jn-takeover-on");
    };
    const unlock = () => {
      document.documentElement.style.overflow = "";
      document.body.style.overflow = "";
      document.body.style.position = "";
      document.body.style.top = "";
      document.body.style.width = "";
      document.body.classList.remove("jn-takeover-on");
      window.scrollTo(0, lockedAt);
    };
    if (scorePhase === "done" || scorePhase === "failed") {
      setTakeover(false);
      unlock();
      unlockTo(1);
      return;
    }
    setTakeover(true);
    lock();
    return () => unlock();
  }, [started, scorePhase, unlockTo]);

  /* focus the input when the theater opens (desktop pointers only — never pop
     the mobile keyboard uninvited) */
  useEffect(() => {
    if (!takeover) return;
    if (window.matchMedia("(pointer: fine)").matches) inputRef.current?.focus({ preventScroll: true });
  }, [takeover]);

  const verdict = score ? (score.value >= 75 ? { txt: t.verdict_hi, cls: "" } : score.value >= 55 ? { txt: t.verdict_mid, cls: " mid" } : { txt: t.verdict_low, cls: " mid" }) : null;
  const tplName = (tp: TemplateDef) => (rtl ? tp.nameAr : tp.name);
  const busy = thinking || lastMsgTyping || scorePhase === "working";

  /* ═══════════════════════ RENDER ═══════════════════════ */
  const num = (i: number) => (rtl ? AR_NUM[i] : String(i + 1));
  const ghostCount = Math.max(0, 4 - [profile.name || profile.role, profile.wovenLines.length, profile.education, profile.skills].filter(Boolean).length);
  // ATS-map coverage: role | summary | experience | skills | education | identity
  const axesDone = [
    Boolean(profile.role),
    Boolean(profile.summary),
    profile.wovenLines.length >= 2,
    Boolean(profile.skills),
    Boolean(profile.education),
    Boolean(profile.name || profile.contact),
  ];

  return (
    <div className="journey-root">
      <div className={`jn-intro${introDone || reduce ? " done" : ""}`} aria-hidden />
      <div className="jn-vignette" aria-hidden />
      <div className="jn-grain" aria-hidden />

      {/* the traveling orb */}
      <div ref={orbRef} className="jn-orb-trav" aria-hidden>
        <div className="jn-orb-halo" />
        <div className="jn-ring r1" /><div className="jn-ring r2" /><div className="jn-ring r3" />
        <div className="jn-spin"><div className="jn-pt" /></div>
        <div className="jn-spin s2"><div className="jn-pt" /></div>
        <div className="jn-orb-core" />
      </div>

      {/* scroll progress */}
      <div ref={progRef} className="jn-prog" aria-hidden>
        <div className="num" ref={progNumRef}>0%</div>
        <div className="track-line"><i ref={progBarRef} /></div>
        <div>{t.scroll}</div>
      </div>

      {/* steps pill */}
      <div ref={pillRef} className="jn-steps-pill">
        <span className="lbl">{t.journey}</span>
        {[0, 1, 2, 3, 4].map((i) => (
          <span key={i} className={`jn-step-dot${i < stage ? " done" : ""}${i === Math.min(stage, 4) ? " cur" : ""}`} />
        ))}
      </div>

      {/* ══ SCROLLYTELLING TRACK ══ */}
      <div ref={trackRef} className="jn-track">
        <div className="jn-stick">
          <div className="jn-scene" ref={(el) => { sceneRefs.current[0] = el; }}>
            <span className="jn-badge"><i /><span>{t.badge}</span></span>
            <h1 className="jn-h1">{t.h1a} <em>{t.h1b}</em><br />{t.h1c}</h1>
            <p className="jn-hero-sub">{t.sub}</p>
            <div className="jn-scroll-hint">⌄<br /><span>{t.scrollHint}</span></div>
          </div>
          <div className="jn-scene" ref={(el) => { sceneRefs.current[1] = el; }}>
            <div className="jn-giant"><span ref={giantRef}>0</span><small>%</small></div>
            <p className="jn-cap">{t.cap1a}<br />{t.cap1b}</p>
          </div>
          <div className="jn-scene" ref={(el) => { sceneRefs.current[2] = el; }}>
            <div className="jn-demo-chat">
              <div className="jn-db me" ref={(el) => { bitRefs.current.db1 = el; }}>{t.db1}</div>
              <div className="jn-db ai" ref={(el) => { bitRefs.current.db2 = el; }}>{t.db2}</div>
            </div>
            <p className="jn-cap" ref={(el) => { bitRefs.current.cap2 = el; }}>{t.cap2a}<br />{t.cap2b}</p>
          </div>
          <div className="jn-scene" ref={(el) => { sceneRefs.current[3] = el; }}>
            <div className="jn-demo-paper">
              <div className="jn-dl" ref={(el) => { bitRefs.current.dl1 = el; }}>
                <div className="n">{t.dpName}</div><div className="r">{t.dpRole}</div><hr />
              </div>
              <div className="jn-dl" ref={(el) => { bitRefs.current.dl2 = el; }}>
                <div className="s">{t.exp}</div><div className="l"><b>{t.dpExp.split("·")[0]}</b>·{t.dpExp.split("·")[1]}</div>
              </div>
              <div className="jn-dl" ref={(el) => { bitRefs.current.dl3 = el; }}>
                <div className="l">{t.dpB1}</div><div className="l">{t.dpB2}</div>
              </div>
              <div className="jn-dl" ref={(el) => { bitRefs.current.dl4 = el; }}>
                <div className="s">{t.skills}</div><div className="l">{t.dpSk}</div>
              </div>
            </div>
            <p className="jn-cap" ref={(el) => { bitRefs.current.cap3 = el; }}>{t.cap3}</p>
          </div>
        </div>
      </div>

      {/* ══ THE GATED JOURNEY ══ */}
      <div className="jn-after">
        <div className="jn-wrap">

          <header className="jn-topbar">
            <div className="jn-brand"><div className="jn-orb-mini" /><span>{t.brand}</span></div>
            <div className="jn-top-actions">
              <Link
                href={rtl ? "/" : "/ar"}
                onClick={() => { try { localStorage.setItem("ra_lang_choice", rtl ? "en" : "ar"); localStorage.setItem("ra_lang", rtl ? "en" : "ar"); } catch { /* noop */ } }}
                className="jn-pill-btn"
              >{rtl ? "EN" : "ع"}</Link>
              <Link href={rtl ? "/account?lang=ar" : "/account"} className="jn-pill-btn solid">{t.login}</Link>
            </div>
          </header>

          {/* ── STAGE 0: the interview — TAKES OVER the screen until built ── */}
          <div className={`jn-stage${takeover ? " takeover" : ""}`} ref={(el) => { stageRefs.current[0] = el; }}>
            <div className="jn-stage-tag"><span>{t.step}</span> <span className="n">{num(0)}</span> <span>{t.of5}</span></div>
            <h2 className="jn-sec-title">{t.st0t}</h2>
            <p className="jn-sec-sub">{t.st0s}</p>
            <div className="jn-stage-body">
              <div className="jn-takeover-box">
              <div className="jn-takeover-head">
                <span>{t.step}</span> <span className="n">{num(0)}</span> <span>{t.of5}</span>
                <span className="tt">· {t.st0t}</span>
                {progress > 0 && <span className="prog">{progress}%</span>}
              </div>
              {welcomeBack && (
                <div className="jn-dl-card" style={{ marginBottom: 16, textAlign: "center" }}>
                  <div style={{ fontSize: 14, marginBottom: 12 }}>{t.welcome_back}</div>
                  <div className="jn-btn-row">
                    <button className="jn-btn jn-btn-violet" onClick={restoreDraft}>{t.continue_btn}</button>
                    <button className="jn-btn jn-btn-ghost" onClick={() => setWelcomeBack(false)}>{t.restart_btn}</button>
                  </div>
                </div>
              )}
              <div className="jn-interview-grid">
                <div className="jn-chat-card">
                  <div className="jn-chat-head">
                    <div className={`jn-orb-mini${thinking ? " thinking" : ""}`} />
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{t.advisor}</div>
                    <div className="st" style={{ marginInlineStart: "auto" }}>{t.online}</div>
                    {progress > 0 && <div className="prog">{progress}%</div>}
                  </div>
                  <div className="jn-msgs" ref={msgsRef}>
                    {msgs.map((m, i) => (
                      <div key={i} className={`jn-msg ${m.who}`}>
                        {m.who === "ai" && m.typing && i === msgs.length - 1
                          ? <TypedText text={m.text} onDone={handleTypedDone} instant={reduce} />
                          : m.text}
                      </div>
                    ))}
                    {thinking && <div className="jn-msg ai"><span className="jn-tdots"><i /><i /><i /></span></div>}
                  </div>
                  {!busy && !goalMode && chips.length > 0 && (
                    <div className="jn-chips">
                      {chips.map((c, i) => (
                        <button key={i} className="jn-chip-ans" style={{ animationDelay: `${i * 0.07}s` }} onClick={() => pickChip(c)}>{c.label}</button>
                      ))}
                    </div>
                  )}
                  {!busy && goalMode && (
                    <div className="jn-chips">
                      <button className="jn-chip-ans" onClick={() => chooseGoal("add")}>{t.goal_add}</button>
                      <button className="jn-chip-ans" style={{ animationDelay: ".07s" }} onClick={() => chooseGoal("tailor")}>{t.goal_tailor}</button>
                      <button className="jn-chip-ans" style={{ animationDelay: ".14s" }} onClick={() => chooseGoal("improve")}>{t.goal_improve}</button>
                    </div>
                  )}
                  {netFail && (
                    <div className="jn-netfail">{t.net_fail} <button onClick={() => { setNetFail(false); sendTurn(pendingAns.current); }}>{t.retry}</button></div>
                  )}
                  <div className="jn-chat-input">
                    <input
                      ref={inputRef}
                      type="text"
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") onSend(); }}
                      placeholder={t.typePh}
                      disabled={thinking || scorePhase === "working"}
                    />
                    {pasteMode && (
                      <label className="jn-mic" style={{ display: "grid", placeItems: "center", cursor: "pointer" }} title={t.upload}>
                        {uploading ? "…" : "📎"}
                        <input type="file" accept=".pdf,.docx,.txt,.md" hidden disabled={uploading} onChange={(e) => { onFile(e.target.files?.[0] ?? null); e.target.value = ""; }} />
                      </label>
                    )}
                    {micSupported && !pasteMode && (
                      <button className={`jn-mic${micOn ? " on" : ""}`} onClick={toggleMic} title={t.mic_title} aria-label={t.mic_title}>🎙</button>
                    )}
                    <button className="jn-send" onClick={() => onSend()} disabled={!input.trim() || thinking} aria-label="send">↑</button>
                  </div>
                  <div className="jn-sub-links">
                    {!pasteMode && <button onClick={startUpdate}>{t.have_cv}</button>}
                    {!pasteMode && <span>·</span>}
                    <Link href="/pricing">{t.tool_pricing}</Link>
                    <span>·</span>
                    <Link href={rtl ? "/account?lang=ar" : "/account"}>{t.tool_account}</Link>
                  </div>
                </div>

                {/* the live paper — the ATS template the brain fills, axis by axis */}
                <div className={`jn-paper-wrap${paperOpen ? " open" : ""}`}>
                  <div className={`jn-paper-live${scorePhase === "working" ? " working" : ""}`}>{cv ? t.done2 : t.building}</div>
                  <div className="jn-axes">
                    {t.axes.map((a, i) => {
                      const done = axesDone[i];
                      const cur = !done && i === axesDone.findIndex((d) => !d);
                      return <span key={i} className={`jn-axis${done ? " on" : ""}${cur ? " cur" : ""}`}>{a}{done ? " ✓" : ""}</span>;
                    })}
                  </div>
                  <div className="jn-paper">
                    {profile.name && <div className="jn-pl"><div className="jn-ph-name">{profile.name}</div></div>}
                    {profile.contact && <div className="jn-pl"><div className="jn-p-line" style={{ fontSize: 11 }}>{profile.contact}</div></div>}
                    {profile.role && <div className="jn-pl"><div className="jn-ph-role">{profile.role}</div><hr className="jn-ph-line" /></div>}
                    {profile.summary && (
                      <div className="jn-pl">
                        <div className="jn-p-sec">{t.sumSec}</div>
                        <div className="jn-p-line editable" title="✎" onClick={editSummary}>{profile.summary}</div>
                      </div>
                    )}
                    {profile.wovenLines.length > 0 && (
                      <div className="jn-pl">
                        <div className="jn-p-sec">{t.exp}</div>
                        {profile.wovenLines.map((ln, i) => {
                          const head = !/^[-•]/.test(ln.trim());
                          return (
                            <div key={i} className={`jn-p-line editable${head ? " head" : ""}`} title="✎" onClick={() => editLine(i)}>
                              {head ? <b>{ln}</b> : ln}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {profile.skills && <div className="jn-pl"><div className="jn-p-sec">{t.skills}</div><div className="jn-p-line">{profile.skills}</div></div>}
                    {profile.education && <div className="jn-pl"><div className="jn-p-sec">{t.edu}</div><div className="jn-p-line" style={{ whiteSpace: "pre-wrap" }}>{profile.education}</div></div>}
                    {profile.extras.length > 0 && (
                      <div className="jn-pl">
                        <div className="jn-p-sec">{t.extras}</div>
                        {profile.extras.map((x, i) => <div key={i} className="jn-p-line">• {x}</div>)}
                      </div>
                    )}
                    {Array.from({ length: ghostCount }).map((_, i) => (
                      <div key={i} className="jn-ghost" style={{ width: `${[42, 88, 70, 80][i % 4]}%` }} />
                    ))}
                  </div>
                </div>
              </div>
              <button className="jn-paper-fab" onClick={() => setPaperOpen((o) => !o)} aria-expanded={paperOpen}>
                {rtl ? "📄 سيرتك" : "📄 Your CV"}
              </button>
              </div>
            </div>
          </div>

          {/* ── STAGE 1: the score ── */}
          <div className={`jn-stage${stage < 1 ? " locked" : ""}${justOpened === 1 ? " open-anim" : ""}`} ref={(el) => { stageRefs.current[1] = el; }}>
            <div className="jn-stage-tag"><span>{t.step}</span> <span className="n">{num(1)}</span> <span>{t.of5}</span></div>
            <h2 className="jn-sec-title">{t.st1t}</h2>
            <p className="jn-sec-sub">{t.st1s}</p>
            <div className="jn-lock-veil"><span className="jn-lock-chip"><b>✦</b> <span>{t.lock1}</span></span></div>
            <div className="jn-stage-body">
              <div className="jn-score">
                <div className="jn-score-label">{t.scoreLbl}</div>
                <div className="jn-ring-wrap">
                  <svg width="150" height="150" viewBox="0 0 150 150">
                    <defs>
                      <linearGradient id="jn-gg" x1="0" y1="0" x2="1" y2="1">
                        <stop offset="0%" stopColor="#4ade80" /><stop offset="100%" stopColor="#059669" />
                      </linearGradient>
                    </defs>
                    <circle className="jn-ring-bg" cx="75" cy="75" r="64" />
                    <circle
                      ref={ringFgRef}
                      className={`jn-ring-fg${scorePhase === "working" || scorePhase === "idle" ? " working" : ""}`}
                      cx="75" cy="75" r="64"
                      strokeDasharray={scorePhase === "done" ? CIRC : undefined}
                      strokeDashoffset={scorePhase === "done" ? CIRC : undefined}
                    />
                  </svg>
                  <div className="jn-ring-num">
                    <b ref={scoreNumRef}>{scorePhase === "done" && score ? 0 : "…"}</b>
                    <span>/ 100</span>
                  </div>
                </div>
                {scorePhase === "working" && <div className="jn-score-note">{t.scoring}</div>}
                {scorePhase === "done" && verdict && (
                  <>
                    <div className={`jn-score-verdict${verdict.cls}`}>{verdict.txt}</div>
                    <div className="jn-score-note">{t.score_note}{score?.watermark !== false ? ` · ${t.wm_note}` : ""}</div>
                  </>
                )}
                {scorePhase === "failed" && (
                  <div style={{ marginTop: 14 }}>
                    <div className="jn-score-note" style={{ marginBottom: 10 }}>{t.build_fail}</div>
                    <button className="jn-btn jn-btn-violet" style={{ maxWidth: 220, margin: "0 auto" }} onClick={() => (mode === "update" ? runUpdate(profile) : finalize(profile))}>{t.retry}</button>
                  </div>
                )}
              </div>
              <div className="jn-next-wrap">
                {next1Shown && scorePhase === "done" && <button className="jn-next-btn show" onClick={unlockNext}>{t.next1}</button>}
              </div>
            </div>
          </div>

          {/* ── STAGE 2: templates ── */}
          <div className={`jn-stage${stage < 2 ? " locked" : ""}${justOpened === 2 ? " open-anim" : ""}`} ref={(el) => { stageRefs.current[2] = el; }}>
            <div className="jn-stage-tag"><span>{t.step}</span> <span className="n">{num(2)}</span> <span>{t.of5}</span></div>
            <h2 className="jn-sec-title">{t.st2t}</h2>
            <p className="jn-sec-sub">{t.st2s}</p>
            <div className="jn-lock-veil"><span className="jn-lock-chip"><b>✦</b> <span>{t.lock2}</span></span></div>
            <div className="jn-stage-body">
              <div className="jn-tpl-grid">
                {TEMPLATE_CATALOG.map((tp) => (
                  <button
                    key={tp.slug}
                    className={`jn-tpl${tpl.slug === tp.slug ? " sel" : ""}`}
                    aria-pressed={tpl.slug === tp.slug}
                    onClick={() => {
                      setTpl(tp);
                      if (!tplPicked) { setTplPicked(true); setTimeout(() => unlockNext(), 750); }
                    }}
                  >
                    <TemplateThumb def={tp} />
                    <span className="tn">{tpl.slug === tp.slug && <span className="jn-tpl-check">✓</span>}{tplName(tp)}</span>
                  </button>
                ))}
              </div>
              <div style={{ textAlign: "center", marginTop: 12 }}>
                <Link href={rtl ? "/templates?lang=ar" : "/templates"} className="jn-pill-btn">{t.browse_templates}</Link>
              </div>
              {cv && (
                <div className="jn-preview-wrap">
                  <ResumeTemplate text={cv} name={profile.name || "resume"} variant={tpl.variant} accent={tpl.accent} fitWidth />
                </div>
              )}
            </div>
          </div>

          {/* ── STAGE 3: download ── */}
          <div className={`jn-stage${stage < 3 ? " locked" : ""}${justOpened === 3 ? " open-anim" : ""}`} ref={(el) => { stageRefs.current[3] = el; }}>
            <div className="jn-stage-tag"><span>{t.step}</span> <span className="n">{num(3)}</span> <span>{t.of5}</span></div>
            <h2 className="jn-sec-title">{t.st3t}</h2>
            <p className="jn-sec-sub">{t.st3s}</p>
            <div className="jn-lock-veil"><span className="jn-lock-chip"><b>✦</b> <span>{t.lock3}</span></span></div>
            <div className="jn-stage-body">
              <div className="jn-dl-card" onClickCapture={(e) => {
                if ((e.target as HTMLElement).closest("button") && !downloaded) {
                  setDownloaded(true);
                  track("download_clicked", { lang });
                  setTimeout(() => unlockNext(), 900);
                }
              }}>
                <div style={{ marginBottom: 14 }}>
                  <div style={{ marginBottom: 8, fontSize: 12.5, fontWeight: 700 }}>{t.lang_pick}</div>
                  <div className="jn-lang-row">
                    {(["en", "ar", "both"] as const).map((c) => (
                      <button key={c} className={outChoice === c ? "on" : ""} disabled={langBusy} onClick={() => switchLang(c)}>{t.lang_opts[c]}</button>
                    ))}
                  </div>
                  {langErr && <button onClick={() => { setLangErr(false); switchLang(outChoice, true); }} style={{ marginTop: 8, fontSize: 12, color: "#f87171", background: "none", border: "none", cursor: "pointer" }}>{t.lang_err}</button>}
                </div>
                {cv && (
                  <>
                    <div className="jn-btn-row">
                      <PdfExport text={cv} watermark={score?.watermark !== false} lang={lang} label="↓ PDF" />
                      <DocxExport text={cv} watermark={score?.watermark !== false} lang={lang} filename={lang === "ar" ? "resume-ar.docx" : "resume.docx"} label="↓ Word" />
                    </div>
                    <div style={{ marginTop: 14 }}>
                      <PublishLink ar={rtl} text={cv} name={profile.name} role={profile.role} />
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* ── STAGE 4: plans ── */}
          <div className={`jn-stage${stage < 4 ? " locked" : ""}${justOpened === 4 ? " open-anim" : ""}`} ref={(el) => { stageRefs.current[4] = el; }}>
            <div className="jn-stage-tag"><span>{t.step}</span> <span className="n">{num(4)}</span> <span>{t.of5}</span></div>
            <h2 className="jn-sec-title">{t.st4t}</h2>
            <p className="jn-sec-sub">{t.st4s}</p>
            <div className="jn-lock-veil"><span className="jn-lock-chip"><b>✦</b> <span>{t.lock4}</span></span></div>
            <div className="jn-stage-body">
              <div className="jn-plans">
                <div className="jn-plan">
                  <h3>{t.p1n}</h3>
                  <div className="price">35<small>{t.sar}</small></div>
                  <div className="per">{t.once}</div>
                  <ul><li>{t.p1a}</li><li>{t.p1b}</li><li>{t.p1c}</li></ul>
                  <Link href="/pricing" className="btn" onClick={() => { setPlan(t.planDay); unlockNext(); }}>{t.choose}</Link>
                </div>
                <div className="jn-plan hot">
                  <div className="tag">{t.bestVal}</div>
                  <h3>{t.p2n}</h3>
                  <div className="price">99<small>{t.sar}</small></div>
                  <div className="per">{t.once}</div>
                  <ul><li>{t.p2a}</li><li>{t.p2b}</li><li>{t.p2c}</li><li>{t.p2d}</li></ul>
                  <Link href="/pricing" className="btn" onClick={() => { setPlan(t.plan90); unlockNext(); }}>{t.chooseB}</Link>
                </div>
              </div>
              <button className="jn-free-link" onClick={() => { setPlan(t.freePlan); unlockNext(); }}>{t.freeLink}</button>
            </div>
          </div>

          {/* ── STAGE 5: finale ── */}
          <div className={`jn-stage${stage < 5 ? " locked" : ""}${justOpened === 5 ? " open-anim" : ""}`} ref={(el) => { stageRefs.current[5] = el; }}>
            <div className="jn-lock-veil"><span className="jn-lock-chip"><b>✦</b> <span>{t.lock5}</span></span></div>
            <div className="jn-stage-body">
              <div className="jn-finale">
                <div className="jn-fin-orb">
                  <div className="jn-fin-ring" /><div className="jn-fin-ring" /><div className="jn-fin-ring" />
                  <div className="core" />
                </div>
                <h2>{t.finTa} <em>{t.finTb}</em></h2>
                <p className="sub">{t.finS}</p>
                <div className="jn-summary">
                  <span className="jn-sum-chip"><i /><span>{profile.role || profile.name || "—"}</span></span>
                  {score && <span className="jn-sum-chip"><i /><span>{t.sumScoreP} {score.value}</span></span>}
                  <span className="jn-sum-chip"><i /><span>{t.sumTplP} {tplName(tpl)}</span></span>
                  {plan && <span className="jn-sum-chip"><i /><span>{plan}</span></span>}
                </div>
                <div className="jn-fin-actions">
                  {cv && <PdfExport text={cv} watermark={score?.watermark !== false} lang={lang} label={t.dlAgain} />}
                  <button className="jn-btn jn-btn-ghost" style={{ flex: "0 1 auto", padding: "14px 30px" }} onClick={hardRestart}>{t.restart}</button>
                </div>
              </div>

              <section style={{ paddingTop: 44 }}>
                <div className="jn-sec-sub" style={{ marginBottom: 18 }}>{t.afterCv}</div>
                <div className="jn-tools">
                  <Link href={rtl ? "/interview?lang=ar" : "/interview"} className="jn-tool jn-rv">
                    <div className="ic">◉</div><h3>{t.t1}</h3><p>{t.t1d}</p>
                  </Link>
                  <Link href="/interview-live" className="jn-tool jn-rv">
                    <div className="ic">▶</div><h3>{t.t2}</h3><p>{t.t2d}</p>
                  </Link>
                  <Link href={rtl ? "/linkedin?lang=ar" : "/linkedin"} className="jn-tool jn-rv">
                    <div className="ic">in</div><h3>{t.t3}</h3><p>{t.t3d}</p>
                  </Link>
                </div>
              </section>

              <section style={{ paddingTop: 36 }}>
                <div className="jn-faq jn-rv">
                  <details open>
                    <summary>{t.q1}</summary>
                    <div className="a">{t.a1}</div>
                  </details>
                  <details>
                    <summary>{t.q2}</summary>
                    <div className="a">{t.a2}</div>
                  </details>
                  <details>
                    <summary>{t.q3}</summary>
                    <div className="a">{t.a3}</div>
                  </details>
                </div>
              </section>

              <footer className="jn-footer jn-rv">
                <div>{t.footBrand}</div>
                <div className="links">
                  <Link href="/terms">{t.terms}</Link>
                  <Link href="/privacy">{t.privacy}</Link>
                  <Link href="/pricing">{t.contact}</Link>
                </div>
              </footer>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
