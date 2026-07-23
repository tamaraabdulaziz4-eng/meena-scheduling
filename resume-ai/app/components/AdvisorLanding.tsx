"use client";
/**
 * Landing v2 — "المستشار" (The Advisor). The page IS a conversation:
 * the Orb greets the visitor, interviews them one question at a time,
 * rephrases their casual words into professional CV lines live, grows the
 * CV in a glass panel beside the chat, asks honest gap questions as chips,
 * then builds + scores the CV and reveals it — downloads and all — without
 * ever leaving the page.
 *
 * Robustness (from the field bug reports, non-negotiable):
 * - Every AI call: 90s AbortController timeout + a friendly retry state.
 * - Draft saved to localStorage after EVERY answer → refresh = "welcome back".
 * - Browser back = one question back (history.pushState per question).
 * - Rephrase failure falls back to the visitor's raw words — never blocks.
 * - Voice input is feature-detected; no mic button on unsupported browsers.
 * - 16px inputs, 44px+ targets, works at 320px, reduced-motion = no typing fx.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { track } from "@vercel/analytics";
import AiOrb from "./AiOrb";
import ScoreRing from "./ScoreRing";
import PdfExport from "./PdfExport";
import DocxExport from "./DocxExport";
import PublishLink from "./PublishLink";
import ResumeTemplate from "./ResumeTemplate";
import { TEMPLATE_CATALOG } from "../lib/templateCatalog";
import { saveResume } from "../lib/localdata";

type Lang = "ar" | "en";

interface Job { header: string; bullets: string[] }
interface AdvisorData {
  targetRole: string;
  name: string;
  contact: string;
  jobs: Job[];
  education: string;
  skills: string;
  extras: string[];
  jobAd: string;
}
interface Msg { who: "ai" | "user"; text: string; lines?: string[] }
interface Gap { q: string; field: string }

type StepId =
  | "welcome" | "name" | "contact" | "jobHeader" | "jobDuties" | "moreJobs"
  | "education" | "skills" | "jobAd" | "gaps" | "build" | "reveal";

const EMPTY: AdvisorData = { targetRole: "", name: "", contact: "", jobs: [], education: "", skills: "", extras: [], jobAd: "" };

/* ────────────── copy ────────────── */
const T = {
  ar: {
    seo_h1: "سيرتك الذاتية بمقابلة — الذكاء الاصطناعي يبنيها معك سطراً بسطر",
    seo_sub: "كلم المستشار دقيقتين: يسألك، يعيد صياغة كلامك العادي لصياغة احترافية تعبر أنظمة التوظيف (ATS)، ويطلع لك سيرة جاهزة للتنزيل — مجاناً وبدون تسجيل.",
    greeting: "هلا 👋 أنا مستشارك المهني. خلني أبني لك سيرة تعبر الروبوت — بس كلمني دقيقتين. وش شغلك أو وش الوظيفة اللي تبيها؟",
    q_name: "تمام! وش اسمك الكامل؟",
    q_contact: "كيف يتواصلون معك؟ إيميل أو جوال (أو اكتب «تخطَّ»)",
    q_jobHeader: "احكِ لي عن آخر وظيفة: وش المسمى ووين؟ (مثال: محاسب — شركة النور، 2021-2024). إذا ما عندك خبرة اكتب «ما عندي»",
    q_jobDuties: "وش كنت تسوي هناك؟ احكِ بكلامك العادي وأنا أصيغه احترافي 😉",
    q_moreJobs: "عندك وظيفة ثانية نضيفها؟",
    q_education: "وش دراستك؟ (مثال: بكالوريوس محاسبة — جامعة الملك سعود، 2020) أو «تخطَّ»",
    q_skills: "اكتب مهاراتك — أي ترتيب، وأنا أرتبها",
    q_jobAd: "عندك إعلان وظيفة معيّن تبي نفصّل السيرة عليه؟ الصقه هنا، أو اكتب «تخطَّ»",
    gaps_intro: "قبل أطلع لك السيرة — ثلاث أشياء ممكن ترفع مستواها إذا عندك:",
    gap_yes: "نعم عندي",
    gap_no: "ما عندي",
    gap_answer_ph: "اكتبها هنا…",
    rephrased: "✨ الصياغة الاحترافية (اضغط أي سطر بالسيرة تعدله):",
    rephrase_fail: "سجلتها بكلامك — تقدر تعدلها من لوحة السيرة.",
    building: "ثواني… أرتب كل شي وأكتب سيرتك 🪄",
    build_fail: "تأخر الاتصال — ما راح أخليك تنتظر أكثر.",
    retry: "أعد المحاولة",
    welcome_back: "أهلاً بعودتك 👋 نكمل من وين وقفنا؟",
    continue_btn: "كمّل من وين وقفت",
    restart_btn: "ابدأ من جديد",
    yes: "نعم",
    no: "لا",
    skip_words: /^(تخط|تخطَّ|تخطى|skip|لا|ما عندي|مافي|ما فيه|لا يوجد)/i,
    no_exp_words: /^(ما عندي|مافي|لا|خريج|فريش|fresh)/i,
    input_ph: "اكتب جوابك…",
    send: "أرسل",
    mic_title: "جاوب بصوتك",
    listening: "أسمعك…",
    panel_title: "سيرتك تنمو",
    panel_ready: "سيرتك {p}% جاهزة",
    panel_edit_hint: "اضغط أي سطر لتعديله",
    have_cv: "عندي سيرة جاهزة — افحصها",
    reveal_title: "سيرتك جاهزة 🎉",
    reveal_score: "نتيجتها أمام أنظمة التوظيف",
    tpl_pick: "غيّر القالب:",
    unlock: "فك العلامة المائية — 35 ريال مرة وحدة",
    edit_save: "حفظ",
    progress_q: "سؤال {n} من {t}",
    sections: { exp: "الخبرة العملية", edu: "التعليم", skills: "المهارات", extras: "إضافات" },
    optimize_href: "/ar/optimize",
    generic_gaps: [
      { q: "عندك شهادة مهنية (مثل PMP أو غيرها)؟", field: "extras" },
      { q: "فيه رقم حقيقي يوصف شغلك؟ (حجم فريق، نسبة تحسّن…)", field: "duties" },
      { q: "تتكلم لغات غير العربية؟", field: "extras" },
    ] as Gap[],
  },
  en: {
    seo_h1: "Your resume, by interview — AI builds it with you line by line",
    seo_sub: "Talk to the Advisor for two minutes: it asks, rephrases your casual words into professional ATS-ready lines, and hands you a resume ready to download — free, no signup.",
    greeting: "Hi 👋 I'm your AI career advisor. Let me build you a robot-proof resume — just talk with me for two minutes. What do you do?",
    q_name: "Great! What's your full name?",
    q_contact: "How can employers reach you? Email or phone (or type \"skip\")",
    q_jobHeader: "Tell me about your latest job: title and where? (e.g. Accountant — Al Noor Co, 2021-2024). No experience yet? Type \"none\"",
    q_jobDuties: "What did you actually do there? Say it casually — I'll make it professional 😉",
    q_moreJobs: "Another job to add?",
    q_education: "Your education? (e.g. BSc Accounting — King Saud University, 2020) or \"skip\"",
    q_skills: "List your skills — any order, I'll organize them",
    q_jobAd: "Got a specific job posting to tailor for? Paste it here, or type \"skip\"",
    gaps_intro: "Before I write it — three things that could lift it if you have them:",
    gap_yes: "Yes, I have",
    gap_no: "I don't",
    gap_answer_ph: "Type it here…",
    rephrased: "✨ The professional version (tap any line in the CV to edit):",
    rephrase_fail: "Kept your words as-is — you can edit them in the CV panel.",
    building: "One moment… assembling everything and writing your resume 🪄",
    build_fail: "The connection stalled — I won't keep you waiting.",
    retry: "Try again",
    welcome_back: "Welcome back 👋 Continue where we left off?",
    continue_btn: "Continue where I stopped",
    restart_btn: "Start over",
    yes: "Yes",
    no: "No",
    skip_words: /^(skip|no|none|nothing|n\/a)/i,
    no_exp_words: /^(none|no experience|fresh|graduate|no)/i,
    input_ph: "Type your answer…",
    send: "Send",
    mic_title: "Answer by voice",
    listening: "Listening…",
    panel_title: "Your CV is growing",
    panel_ready: "Your CV is {p}% ready",
    panel_edit_hint: "Tap any line to edit it",
    have_cv: "I already have a resume — scan it",
    reveal_title: "Your resume is ready 🎉",
    reveal_score: "Its score against ATS robots",
    tpl_pick: "Switch template:",
    unlock: "Remove the watermark — SAR 35, one time",
    edit_save: "Save",
    progress_q: "Question {n} of {t}",
    sections: { exp: "Experience", edu: "Education", skills: "Skills", extras: "Extras" },
    optimize_href: "/optimize",
    generic_gaps: [
      { q: "Do you hold a professional certification (PMP or similar)?", field: "extras" },
      { q: "Is there a real number that describes your work? (team size, % improvement…)", field: "duties" },
      { q: "Do you speak languages besides English?", field: "extras" },
    ] as Gap[],
  },
} as const;

const GREEN = "#22C55E";

/* Fetch with a hard timeout — every AI call in the Advisor goes through this. */
async function fetchT(url: string, body: object, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify(body),
    });
  } finally {
    clearTimeout(timer);
  }
}

export default function AdvisorLanding({ lang }: { lang: Lang }) {
  const t = T[lang];
  const rtl = lang === "ar";
  const DRAFT_KEY = `ra_advisor_${lang}`;

  const [step, setStep] = useState<StepId>("welcome");
  const [data, setData] = useState<AdvisorData>(EMPTY);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [orbState, setOrbState] = useState<"idle" | "listening" | "thinking" | "talking">("talking");
  const [typed, setTyped] = useState("");
  const [resume, setResume] = useState<{ saved: boolean } | null>(null); // welcome-back prompt
  const [gaps, setGaps] = useState<Gap[]>([]);
  const [gapIdx, setGapIdx] = useState(0);
  const [gapAnswering, setGapAnswering] = useState(false);
  const [buildPhase, setBuildPhase] = useState<"idle" | "working" | "failed">("idle");
  const [cv, setCv] = useState("");
  const [score, setScore] = useState<{ value: number; watermark: boolean } | null>(null);
  const [scorePhase, setScorePhase] = useState<"idle" | "working" | "failed" | "done">("idle");
  const [tpl, setTpl] = useState(TEMPLATE_CATALOG[0]);
  const [editing, setEditing] = useState<{ path: string; value: string } | null>(null);
  const [micOn, setMicOn] = useState(false);
  const [micSupported, setMicSupported] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);
  const recRef = useRef<{ stop: () => void } | null>(null);
  const reducedRef = useRef(false);
  const startedRef = useRef(false);

  /* ── boot: reduced motion, mic support, saved draft, greeting ── */
  useEffect(() => {
    reducedRef.current = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    // Feature-detect voice input — the mic button simply doesn't exist elsewhere.
    const w = window as unknown as Record<string, unknown>;
    setMicSupported(Boolean(w.webkitSpeechRecognition || w.SpeechRecognition));
    try {
      const saved = localStorage.getItem(DRAFT_KEY);
      if (saved) {
        const d = JSON.parse(saved);
        if (d && d.step && d.step !== "welcome" && d.step !== "reveal") {
          setResume({ saved: true });
          return; // hold the greeting until they choose continue/restart
        }
      }
    } catch { /* ignore */ }
    beginGreeting();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function beginGreeting() {
    // Typed-out greeting (skipped for reduced motion).
    if (reducedRef.current) {
      setTyped(t.greeting);
      setMsgs([{ who: "ai", text: t.greeting }]);
      setOrbState("idle");
      return;
    }
    let i = 0;
    setOrbState("talking");
    const id = setInterval(() => {
      i += 2;
      setTyped(t.greeting.slice(0, i));
      if (i >= t.greeting.length) {
        clearInterval(id);
        setMsgs([{ who: "ai", text: t.greeting }]);
        setOrbState("idle");
      }
    }, 24);
  }

  /* ── draft persistence: after EVERY answer ── */
  const persist = useCallback((next: { step: StepId; data: AdvisorData; msgs: Msg[] }) => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ step: next.step, data: next.data, msgs: next.msgs.slice(-40) }));
    } catch { /* storage blocked — non-fatal */ }
  }, [DRAFT_KEY]);

  function restoreDraft() {
    try {
      const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || "{}");
      if (d?.data) setData({ ...EMPTY, ...d.data });
      if (Array.isArray(d?.msgs)) setMsgs(d.msgs);
      if (d?.step) setStep(d.step);
      setTyped(t.greeting);
      setMsgs((m) => [...m, { who: "ai", text: questionFor(d?.step || "name") }]);
    } catch { beginGreeting(); }
    setResume(null);
  }

  function questionFor(s: StepId): string {
    switch (s) {
      case "name": return t.q_name;
      case "contact": return t.q_contact;
      case "jobHeader": return t.q_jobHeader;
      case "jobDuties": return t.q_jobDuties;
      case "moreJobs": return t.q_moreJobs;
      case "education": return t.q_education;
      case "skills": return t.q_skills;
      case "jobAd": return t.q_jobAd;
      default: return t.greeting;
    }
  }

  /* ── browser back = one question back ── */
  const ORDER: StepId[] = useMemo(() => ["welcome", "name", "contact", "jobHeader", "jobDuties", "moreJobs", "education", "skills", "jobAd", "gaps", "build", "reveal"], []);
  useEffect(() => {
    const onPop = () => {
      setStep((cur) => {
        const i = ORDER.indexOf(cur);
        if (i <= 0 || cur === "build" || cur === "reveal") return cur;
        const prev = ORDER[i - 1] === "moreJobs" ? "jobDuties" : ORDER[i - 1];
        setMsgs((m) => [...m, { who: "ai", text: questionFor(prev) }]);
        return prev;
      });
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const advance = useCallback((next: StepId, nextData: AdvisorData, newMsgs: Msg[]) => {
    try { history.pushState({ step: next }, ""); } catch { /* ignore */ }
    setStep(next);
    setData(nextData);
    setMsgs(newMsgs);
    persist({ step: next, data: nextData, msgs: newMsgs });
  }, [persist]);

  /* ── auto-scroll chat ── */
  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: reducedRef.current ? "auto" : "smooth" });
  }, [msgs, busy]);

  /* ── the state machine ── */
  async function submit(raw?: string) {
    const text = (raw ?? input).trim();
    if (!text || busy) return;
    setInput("");
    if (!startedRef.current) { startedRef.current = true; track("interview_started", { lang }); }
    track("question_answered", { q: step });

    const say = (m: Msg[], aiText: string): Msg[] => [...m, { who: "ai", text: aiText }];
    let m: Msg[] = [...msgs, { who: "user", text }];
    const d: AdvisorData = { ...data, jobs: data.jobs.map((j) => ({ ...j, bullets: [...j.bullets] })) };

    switch (step) {
      case "welcome": {
        d.targetRole = text.slice(0, 120);
        advance("name", d, say(m, t.q_name));
        return;
      }
      case "name": {
        d.name = text.slice(0, 100);
        advance("contact", d, say(m, t.q_contact));
        return;
      }
      case "contact": {
        if (!t.skip_words.test(text)) d.contact = text.slice(0, 200);
        advance("jobHeader", d, say(m, t.q_jobHeader));
        return;
      }
      case "jobHeader": {
        if (t.no_exp_words.test(text)) {
          advance("education", d, say(m, t.q_education));
          return;
        }
        d.jobs.push({ header: text.slice(0, 200), bullets: [] });
        advance("jobDuties", d, say(m, t.q_jobDuties));
        return;
      }
      case "jobDuties": {
        // Rephrase the casual answer into professional bullets (fallback: raw).
        setBusy(true);
        setOrbState("thinking");
        setMsgs(m);
        let lines: string[] = [];
        try {
          const res = await fetchT("/api/interview", { action: "rephrase", text, targetRole: d.targetRole, lang }, 35000);
          const j = await res.json();
          if (res.ok && Array.isArray(j.lines) && j.lines.length) lines = j.lines.map((l: string) => l.replace(/^[-•*]\s*/, ""));
        } catch { /* fall back below */ }
        setBusy(false);
        setOrbState("idle");
        const job = d.jobs[d.jobs.length - 1];
        if (lines.length) {
          job.bullets.push(...lines);
          track("suggestion_accepted", { where: "advisor_rephrase" });
          m = [...m, { who: "ai", text: t.rephrased, lines }];
        } else {
          job.bullets.push(text.slice(0, 400));
          m = [...m, { who: "ai", text: t.rephrase_fail }];
        }
        if (d.jobs.length >= 3) {
          advance("education", d, say(m, t.q_education));
        } else {
          advance("moreJobs", d, say(m, t.q_moreJobs));
        }
        return;
      }
      case "moreJobs": {
        const yes = new RegExp(`^(${t.yes}|نعم|اي|ايه|yes|y)`, "i").test(text);
        if (yes) advance("jobHeader", d, say(m, t.q_jobHeader));
        else advance("education", d, say(m, t.q_education));
        return;
      }
      case "education": {
        if (!t.skip_words.test(text)) d.education = text.slice(0, 400);
        advance("skills", d, say(m, t.q_skills));
        return;
      }
      case "skills": {
        d.skills = text.slice(0, 400);
        advance("jobAd", d, say(m, t.q_jobAd));
        return;
      }
      case "jobAd": {
        if (!t.skip_words.test(text)) d.jobAd = text.slice(0, 3000);
        setMsgs(m);
        startGaps(d, m);
        return;
      }
      default:
        return;
    }
  }

  /* ── stage 3: honest gaps ── */
  async function startGaps(d: AdvisorData, m: Msg[]) {
    setBusy(true);
    setOrbState("thinking");
    let list: Gap[] = [];
    try {
      const summary = [
        d.jobs.length ? `- Jobs: ${d.jobs.map((j) => j.header).join(" ; ")}` : "- No work experience",
        d.education ? `- Education: ${d.education}` : "- No education given",
        d.skills ? `- Skills: ${d.skills}` : "- No skills given",
      ].join("\n");
      const res = await fetchT("/api/interview", { action: "gaps", targetRole: d.targetRole, stateSummary: summary, lang }, 35000);
      const j = await res.json();
      if (res.ok && Array.isArray(j.gaps) && j.gaps.length) list = j.gaps;
    } catch { /* generic below */ }
    if (!list.length) list = [...t.generic_gaps];
    setBusy(false);
    setOrbState("idle");
    setGaps(list);
    setGapIdx(0);
    setGapAnswering(false);
    advance("gaps", d, [...m, { who: "ai", text: t.gaps_intro }, { who: "ai", text: list[0].q }]);
  }

  function gapAnswer(yes: boolean) {
    if (!yes) {
      // Honest skip — nothing is invented, we just move on.
      nextGap([...msgs, { who: "user", text: t.gap_no }], data);
      return;
    }
    setGapAnswering(true);
  }

  function gapSubmit() {
    const text = input.trim();
    if (!text) return;
    setInput("");
    setGapAnswering(false);
    const d: AdvisorData = { ...data, extras: [...data.extras] };
    const g = gaps[gapIdx];
    if (g.field === "skills") d.skills = d.skills ? `${d.skills}, ${text.slice(0, 200)}` : text.slice(0, 200);
    else if (g.field === "duties" && d.jobs.length) d.jobs[d.jobs.length - 1].bullets.push(text.slice(0, 300));
    else if (g.field === "education" && !d.education) d.education = text.slice(0, 300);
    else d.extras.push(text.slice(0, 300));
    nextGap([...msgs, { who: "user", text }], d);
  }

  function nextGap(m: Msg[], d: AdvisorData) {
    const ni = gapIdx + 1;
    if (ni < gaps.length) {
      setGapIdx(ni);
      advance("gaps", d, [...m, { who: "ai", text: gaps[ni].q }]);
    } else {
      advance("build", d, [...m, { who: "ai", text: t.building }]);
      runBuild(d, [...m, { who: "ai", text: t.building }]);
    }
  }

  /* ── stage 4a: build the CV (90s timeout + retry) ── */
  async function runBuild(d: AdvisorData, m: Msg[]) {
    setBuildPhase("working");
    setOrbState("thinking");
    try {
      const experiences = d.jobs.map((j) => {
        // "محاسب — شركة النور، 2021-2024" → role/company/dates best-effort
        const hm = j.header.match(/^(.*?)[—–|]\s*(.*?)(?:[،,]\s*([\d\s–—-]{4,}.*))?$/);
        return {
          role: (hm?.[1] || j.header).trim().slice(0, 100),
          company: (hm?.[2] || "").trim().slice(0, 100),
          dates: (hm?.[3] || "").trim().slice(0, 60),
          duties: j.bullets.join("\n").slice(0, 800),
        };
      });
      const res = await fetchT("/api/build-cv", {
        name: d.name, contact: d.contact, targetRole: d.targetRole,
        experiences,
        education: d.education, skills: d.skills,
        extras: d.extras.join("; "),
        jobDescription: d.jobAd,
        outLang: lang,
      }, 90000);
      const ctype = res.headers.get("content-type") || "";
      if (!ctype.includes("ndjson")) {
        const j = await res.json();
        throw new Error(j.error || "failed");
      }
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let got: { cv: string } | null = null;
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
      if (!got?.cv) throw new Error("empty");
      setCv(got.cv);
      setBuildPhase("idle");
      setOrbState("idle");
      track("cv_completed", { lang });
      try { saveResume({ title: `${d.name || "CV"} — ${d.targetRole || "advisor"}`, source: "built", text: got.cv }); } catch { /* noop */ }
      advance("reveal", d, [...m, { who: "ai", text: t.reveal_title }]);
      runScore(got.cv, d);
    } catch {
      setBuildPhase("failed");
      setOrbState("idle");
    }
  }

  /* ── stage 4b: score it (non-blocking; failure just hides the ring) ── */
  async function runScore(cvText: string, d: AdvisorData) {
    setScorePhase("working");
    try {
      const res = await fetchT("/api/optimize", { resume: cvText, jobDescription: d.jobAd, outLang: lang === "ar" ? "ar" : "en" }, 90000);
      const ctype = res.headers.get("content-type") || "";
      if (!ctype.includes("ndjson")) throw new Error("failed");
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let got: { matchScore: number; watermark?: boolean } | null = null;
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
          } catch { /* ignore */ }
        }
      }
      if (got && typeof got.matchScore === "number") {
        setScore({ value: got.matchScore, watermark: got.watermark !== false });
        setScorePhase("done");
      } else setScorePhase("failed");
    } catch {
      setScorePhase("failed");
    }
  }

  /* ── voice input (feature-detected) ── */
  function toggleMic() {
    if (micOn) { recRef.current?.stop(); return; }
    const w = window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike; SpeechRecognition?: new () => SpeechRecognitionLike };
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) return;
    interface SpeechRecognitionLike {
      lang: string; interimResults: boolean; continuous: boolean;
      onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
      onend: (() => void) | null; onerror: (() => void) | null;
      start: () => void; stop: () => void;
    }
    const rec = new Ctor();
    rec.lang = lang === "ar" ? "ar-SA" : "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = (e) => {
      let s = "";
      for (let i = 0; i < e.results.length; i++) s += e.results[i][0].transcript;
      setInput(s); // always editable text — voice never submits by itself
    };
    rec.onend = () => { setMicOn(false); setOrbState("idle"); };
    rec.onerror = () => { setMicOn(false); setOrbState("idle"); };
    recRef.current = rec;
    setMicOn(true);
    setOrbState("listening");
    rec.start();
  }

  /* ── live CV panel model ── */
  const filled = [data.targetRole, data.name, data.contact, data.jobs.length ? "x" : "", data.education, data.skills].filter(Boolean).length;
  const progress = Math.round((filled / 6) * 100);

  function applyEdit() {
    if (!editing) return;
    const [kind, a, b] = editing.path.split(":");
    const d: AdvisorData = { ...data, jobs: data.jobs.map((j) => ({ ...j, bullets: [...j.bullets] })), extras: [...data.extras] };
    const v = editing.value.trim();
    if (kind === "bullet") {
      const ji = Number(a), bi = Number(b);
      if (d.jobs[ji]) {
        if (v) d.jobs[ji].bullets[bi] = v;
        else d.jobs[ji].bullets.splice(bi, 1);
      }
    } else if (kind === "header") {
      const ji = Number(a);
      if (d.jobs[ji] && v) d.jobs[ji].header = v;
    } else if (kind === "education") d.education = v;
    else if (kind === "skills") d.skills = v;
    else if (kind === "extra") {
      const ei = Number(a);
      if (v) d.extras[ei] = v; else d.extras.splice(ei, 1);
    }
    setData(d);
    persist({ step, data: d, msgs });
    setEditing(null);
  }

  const editableLine = (path: string, value: string, cls = "") =>
    editing?.path === path ? (
      <span className="block">
        <textarea
          value={editing.value}
          onChange={(e) => setEditing({ path, value: e.target.value })}
          rows={2}
          autoFocus
          className="w-full rounded-lg p-2"
          style={{ background: "rgba(11,18,32,0.85)", color: "#f4f5f3", border: `1px solid ${GREEN}`, fontSize: 16 }}
        />
        <button onClick={applyEdit} className="mt-1 min-h-9 rounded-lg px-4 text-xs font-bold" style={{ background: GREEN, color: "#05130a" }}>{t.edit_save}</button>
      </span>
    ) : (
      <button
        onClick={() => setEditing({ path, value })}
        className={`block w-full rounded px-1 text-start transition-colors hover:bg-white/10 ${cls}`}
        style={{ minHeight: 28 }}
      >
        {value}
      </button>
    );

  const qNumber = Math.max(1, ORDER.indexOf(step));
  const showChips = step === "moreJobs" || (step === "gaps" && !gapAnswering);
  const showInput = step !== "build" && step !== "reveal" && !showChips && !resume;

  /* ══════════════════ render ══════════════════ */
  return (
    <div dir={rtl ? "rtl" : "ltr"} className="relative min-h-screen" style={{ background: "#0B1220", color: "#f4f5f3" }}>
      <div className="aurora-bg" aria-hidden />

      {/* nav: logo + language + escape hatch for people who already have a CV */}
      <nav className="relative z-20 mx-auto flex max-w-6xl items-center justify-between px-5 py-4">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg font-mono text-sm font-bold" style={{ background: GREEN, color: "#05130a" }}>R</div>
          <span className="text-[15px] font-bold tracking-tight">ResumeAI</span>
        </div>
        <div className="flex items-center gap-1">
          <Link href={t.optimize_href} className="hidden min-h-11 items-center px-3 text-sm font-semibold sm:flex" style={{ color: "rgba(244,245,243,0.7)" }}>{t.have_cv}</Link>
          <Link href={rtl ? "/" : "/ar"} className="flex min-h-11 items-center px-3 text-sm font-semibold" style={{ color: GREEN }}>{rtl ? "English" : "عربي"}</Link>
        </div>
      </nav>

      {/* SEO: static, server-rendered headline (the conversation needs JS — crawlers get this) */}
      <header className="relative z-10 mx-auto max-w-3xl px-5 pt-2 text-center">
        <h1 className="text-xl font-extrabold leading-relaxed sm:text-2xl" style={{ lineHeight: 1.6 }}>{t.seo_h1}</h1>
        <p className="mx-auto mt-2 max-w-xl text-sm" style={{ color: "rgba(244,245,243,0.55)", lineHeight: 1.8 }}>{t.seo_sub}</p>
      </header>

      <main className="relative z-10 mx-auto grid max-w-6xl gap-6 px-4 pb-28 pt-6 lg:grid-cols-[1fr_minmax(300px,420px)]">
        {/* ═══ the conversation ═══ */}
        <section className="glass-panel flex min-h-[60vh] flex-col p-4 sm:p-6">
          {/* Orb header */}
          <div className="mb-4 flex items-center gap-3">
            <AiOrb size={54} state={orbState} />
            <div>
              <div className="text-sm font-bold">{rtl ? "المستشار" : "The Advisor"}</div>
              <div className="font-mono text-[11px]" style={{ color: micOn ? GREEN : "rgba(244,245,243,0.45)" }}>
                {micOn ? t.listening : step === "build" ? t.building : t.progress_q.replace("{n}", String(Math.min(qNumber, 9))).replace("{t}", "9")}
              </div>
            </div>
          </div>

          {/* welcome-back resume prompt */}
          {resume && (
            <div className="glass-panel mb-4 p-5 text-center">
              <p className="font-bold">{t.welcome_back}</p>
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                <button onClick={restoreDraft} className="min-h-11 rounded-xl px-5 text-sm font-bold" style={{ background: GREEN, color: "#05130a" }}>{t.continue_btn}</button>
                <button
                  onClick={() => { try { localStorage.removeItem(DRAFT_KEY); } catch { /* noop */ } setResume(null); setData(EMPTY); setStep("welcome"); setMsgs([]); beginGreeting(); }}
                  className="min-h-11 rounded-xl px-5 text-sm font-semibold"
                  style={{ border: "1px solid rgba(255,255,255,0.2)", color: "rgba(244,245,243,0.7)" }}
                >
                  {t.restart_btn}
                </button>
              </div>
            </div>
          )}

          {/* typed greeting before the first message lands */}
          {!resume && msgs.length === 0 && (
            <p className="px-1 text-base font-semibold" style={{ lineHeight: 1.9 }}>{typed}<span className="animate-pulse" style={{ color: GREEN }}>▌</span></p>
          )}

          {/* chat log */}
          <div ref={chatRef} className="flex-1 space-y-3 overflow-y-auto px-1" style={{ maxHeight: "48vh" }}>
            {msgs.map((mm, i) => (
              <div key={i} className={`flex ${mm.who === "user" ? (rtl ? "justify-start" : "justify-end") : rtl ? "justify-end" : "justify-start"}`} style={mm.who === "user" ? {} : {}}>
                <div
                  className="max-w-[85%] rounded-2xl px-4 py-2.5 text-[15px]"
                  style={mm.who === "user"
                    ? { background: "rgba(34,197,94,0.16)", border: "1px solid rgba(34,197,94,0.3)", lineHeight: 1.8 }
                    : { background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", lineHeight: 1.8 }}
                >
                  {mm.text}
                  {mm.lines && (
                    <ul className="mt-2 space-y-1">
                      {mm.lines.map((l) => (
                        <li key={l} className="rounded-lg px-3 py-1.5 text-sm" style={{ background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.25)" }}>{l}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            ))}
            {busy && (
              <div className={`flex ${rtl ? "justify-end" : "justify-start"}`}>
                <div className="flex items-center gap-2 rounded-2xl px-4 py-2.5" style={{ background: "rgba(255,255,255,0.06)" }}>
                  <AiOrb size={20} thinking />
                  <span className="font-mono text-xs" style={{ color: "rgba(244,245,243,0.6)" }}>…</span>
                </div>
              </div>
            )}
          </div>

          {/* build failure → retry (never an infinite spinner) */}
          {buildPhase === "failed" && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl p-4" style={{ background: "rgba(229,72,77,0.1)", border: "1px solid rgba(229,72,77,0.35)" }}>
              <span className="text-sm" style={{ color: "#fca5a5" }}>{t.build_fail}</span>
              <button onClick={() => { setMsgs((m) => [...m, { who: "ai", text: t.building }]); runBuild(data, msgs); }} className="min-h-11 rounded-lg px-5 text-sm font-bold" style={{ background: GREEN, color: "#05130a" }}>{t.retry}</button>
            </div>
          )}

          {/* chips: yes/no + gap answers */}
          {step === "moreJobs" && (
            <div className="mt-4 flex gap-2">
              <button onClick={() => submit(t.yes)} className="min-h-11 flex-1 rounded-xl text-sm font-bold" style={{ background: GREEN, color: "#05130a" }}>{t.yes}</button>
              <button onClick={() => submit(t.no)} className="min-h-11 flex-1 rounded-xl text-sm font-semibold" style={{ border: "1px solid rgba(255,255,255,0.2)" }}>{t.no}</button>
            </div>
          )}
          {step === "gaps" && !gapAnswering && buildPhase === "idle" && (
            <div className="mt-4 flex gap-2">
              <button onClick={() => gapAnswer(true)} className="min-h-11 flex-1 rounded-xl text-sm font-bold" style={{ background: GREEN, color: "#05130a" }}>{t.gap_yes}</button>
              <button onClick={() => gapAnswer(false)} className="min-h-11 flex-1 rounded-xl text-sm font-semibold" style={{ border: "1px solid rgba(255,255,255,0.2)" }}>{t.gap_no}</button>
            </div>
          )}
          {step === "gaps" && gapAnswering && (
            <div className="mt-4 flex gap-2">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") gapSubmit(); }}
                placeholder={t.gap_answer_ph}
                autoFocus
                className="min-h-11 flex-1 rounded-xl px-4 outline-none"
                style={{ background: "rgba(11,18,32,0.7)", border: "1px solid rgba(255,255,255,0.15)", color: "#f4f5f3", fontSize: 16 }}
              />
              <button onClick={gapSubmit} className="min-h-11 rounded-xl px-5 text-sm font-bold" style={{ background: GREEN, color: "#05130a" }}>{t.send}</button>
            </div>
          )}

          {/* the input bar */}
          {showInput && (
            <div className="mt-4 flex gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
                placeholder={t.input_ph}
                rows={step === "jobAd" || step === "jobDuties" ? 3 : 1}
                className="min-h-11 flex-1 resize-none rounded-xl px-4 py-2.5 outline-none"
                style={{ background: "rgba(11,18,32,0.7)", border: "1px solid rgba(255,255,255,0.15)", color: "#f4f5f3", fontSize: 16, lineHeight: 1.7 }}
              />
              {micSupported && (
                <button onClick={toggleMic} title={t.mic_title} aria-label={t.mic_title}
                  className="min-h-11 w-11 rounded-xl text-lg"
                  style={micOn ? { background: GREEN, color: "#05130a" } : { border: "1px solid rgba(255,255,255,0.2)" }}>
                  🎙
                </button>
              )}
              <button onClick={() => submit()} disabled={busy || !input.trim()} className="min-h-11 rounded-xl px-5 text-sm font-bold disabled:opacity-40" style={{ background: GREEN, color: "#05130a" }}>
                {t.send}
              </button>
            </div>
          )}
        </section>

        {/* ═══ the growing CV / the reveal ═══ */}
        <aside className="space-y-4">
          {step !== "reveal" ? (
            <div className="glass-panel p-5">
              <div className="mb-1 flex items-center justify-between">
                <h2 className="text-sm font-bold">{t.panel_title}</h2>
                <span className="font-mono text-xs" style={{ color: GREEN }}>{progress}%</span>
              </div>
              <div className="mb-4 h-1.5 overflow-hidden rounded-full" style={{ background: "rgba(255,255,255,0.08)" }}>
                <div className="h-full rounded-full transition-all duration-700" style={{ width: `${progress}%`, background: GREEN }} />
              </div>
              <p className="mb-3 text-[11px]" style={{ color: "rgba(244,245,243,0.4)" }}>{t.panel_edit_hint}</p>

              <div className="space-y-3 text-sm" style={{ lineHeight: 1.8 }}>
                {data.name && <div className="text-lg font-extrabold">{data.name}</div>}
                {data.contact && <div dir="ltr" className="text-xs" style={{ color: "rgba(244,245,243,0.6)", textAlign: rtl ? "right" : "left", unicodeBidi: "plaintext" }}>{data.contact}</div>}
                {data.targetRole && <div className="text-xs font-bold" style={{ color: GREEN }}>{data.targetRole}</div>}
                {data.jobs.length > 0 && (
                  <div>
                    <div className="mb-1 font-mono text-[11px] font-bold uppercase tracking-wider" style={{ color: "rgba(244,245,243,0.5)" }}>{t.sections.exp}</div>
                    {data.jobs.map((j, ji) => (
                      <div key={ji} className="mb-2">
                        <div className="font-semibold">{editableLine(`header:${ji}`, j.header)}</div>
                        <ul className="mt-1 space-y-1">
                          {j.bullets.map((b1, bi) => (
                            <li key={bi} className="flex gap-1.5 text-[13px]" style={{ color: "rgba(244,245,243,0.75)" }}>
                              <span style={{ color: GREEN }}>•</span>
                              <span className="flex-1">{editableLine(`bullet:${ji}:${bi}`, b1)}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
                {data.education && (
                  <div>
                    <div className="mb-1 font-mono text-[11px] font-bold uppercase tracking-wider" style={{ color: "rgba(244,245,243,0.5)" }}>{t.sections.edu}</div>
                    {editableLine("education:", data.education, "text-[13px]")}
                  </div>
                )}
                {data.skills && (
                  <div>
                    <div className="mb-1 font-mono text-[11px] font-bold uppercase tracking-wider" style={{ color: "rgba(244,245,243,0.5)" }}>{t.sections.skills}</div>
                    {editableLine("skills:", data.skills, "text-[13px]")}
                  </div>
                )}
                {data.extras.length > 0 && (
                  <div>
                    <div className="mb-1 font-mono text-[11px] font-bold uppercase tracking-wider" style={{ color: "rgba(244,245,243,0.5)" }}>{t.sections.extras}</div>
                    {data.extras.map((x, ei) => <div key={ei}>{editableLine(`extra:${ei}`, x, "text-[13px]")}</div>)}
                  </div>
                )}
              </div>

              {step === "build" && buildPhase === "working" && (
                <div className="mt-5 flex items-center gap-3">
                  <AiOrb size={30} thinking />
                  <span className="font-mono text-xs" style={{ color: GREEN }}>{t.building}</span>
                </div>
              )}
            </div>
          ) : (
            <>
              {/* score */}
              <div className="glass-panel p-5 text-center">
                <h2 className="mb-3 text-sm font-bold">{t.reveal_score}</h2>
                {scorePhase === "done" && score ? (
                  <div className="mx-auto w-36"><ScoreRing value={score.value} color={score.value < 60 ? "#E5484D" : GREEN} /></div>
                ) : scorePhase === "working" ? (
                  <div className="flex items-center justify-center gap-3 py-6"><AiOrb size={34} thinking /><span className="font-mono text-xs" style={{ color: "rgba(244,245,243,0.6)" }}>…</span></div>
                ) : (
                  <button onClick={() => runScore(cv, data)} className="min-h-11 rounded-lg px-5 text-sm font-bold" style={{ background: GREEN, color: "#05130a" }}>{t.retry}</button>
                )}
              </div>
              {/* actions */}
              <div className="glass-panel p-5" onClickCapture={(e) => { const el = e.target as HTMLElement; if (el.closest("button")) track("download_clicked", { lang }); }}>
                <div className="flex flex-wrap gap-2">
                  <PdfExport text={cv} watermark={score?.watermark !== false} lang={lang} label={rtl ? "↓ PDF" : "↓ PDF"} />
                  <DocxExport text={cv} watermark={score?.watermark !== false} lang={lang} filename={lang === "ar" ? "resume-ar.docx" : "resume.docx"} label={rtl ? "↓ Word" : "↓ Word"} />
                </div>
                <PublishLink ar={rtl} text={cv} name={data.name} role={data.targetRole} />
                <Link href="/pricing" className="mt-3 block rounded-xl py-3 text-center text-sm font-bold" style={{ background: "rgba(251,191,36,0.12)", border: "1px solid rgba(251,191,36,0.35)", color: "#fbbf24" }}>
                  🔓 {t.unlock}
                </Link>
              </div>
              {/* template picker + preview */}
              <div className="glass-panel p-5">
                <div className="mb-2 text-xs font-bold">{t.tpl_pick}</div>
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {TEMPLATE_CATALOG.map((tp) => (
                    <button key={tp.slug} onClick={() => setTpl(tp)}
                      className="min-h-9 rounded-lg px-2.5 text-[11px] font-semibold"
                      style={tpl.slug === tp.slug ? { background: tp.accent, color: "#fff" } : { border: "1px solid rgba(255,255,255,0.15)", color: "rgba(244,245,243,0.7)" }}>
                      {rtl ? tp.nameAr : tp.name}
                    </button>
                  ))}
                </div>
                <ResumeTemplate text={cv} name={data.name || "resume"} variant={tpl.variant} accent={tpl.accent} fitWidth />
              </div>
            </>
          )}
        </aside>
      </main>
    </div>
  );
}
