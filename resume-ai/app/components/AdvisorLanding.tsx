"use client";
/**
 * Landing v3 — "المستشار" (The Advisor) as a full-screen THEATER driven by the
 * conversation BRAIN (/api/interview action="turn").
 *
 * The page is one stage; each moment shows ONE big thing (ChatGPT-voice model,
 * apple.com scene craft, linear.app cleanliness). Five states, choreographed:
 *   greeting → conversation → thinking → weaving → reveal
 * The Orb is the hero and the title — it flies between positions (framer-motion
 * layout), pulses aurora rings while the brain thinks, shrinks to a corner while
 * the CV weaves itself line by line, and retires to a green ✓ at the reveal.
 *
 * The brain owns the flow: it decides ASK/DEEPEN/REPHRASE/SUGGEST/FINISH,
 * returns `say` + `profile_patch` + `resume_lines` + `chips` + `progress`, and
 * NEVER invents facts. The client accumulates the profile and the woven lines.
 *
 * Preserved (must not break): draft autosave + welcome-back, tap-to-edit any
 * line, all 10 templates, watermark + SAR-35 unlock, language selector, voice
 * input, paste/upload an existing resume, 90s timeout + friendly retry, 16px
 * inputs, 44px targets, prefers-reduced-motion.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { track } from "@vercel/analytics";
import AiOrb from "./AiOrb";
import { useOrbScene } from "./orb/OrbProvider";
import ScoreOrb from "./orb/ScoreOrb";
import PdfExport from "./PdfExport";
import DocxExport from "./DocxExport";
import PublishLink from "./PublishLink";
import ResumeTemplate from "./ResumeTemplate";
import { TEMPLATE_CATALOG } from "../lib/templateCatalog";
import { saveResume } from "../lib/localdata";

type Lang = "ar" | "en";
type Stage = "greeting" | "conversation" | "thinking" | "weaving" | "reveal";
type OutLang = "en" | "ar" | "both";
interface Msg { who: "ai" | "user"; text: string }
interface Chip { label: string; patch?: Record<string, unknown> }

interface Profile {
  role: string; name: string; contact: string;
  education: string; skills: string; extras: string[];
  wovenLines: string[]; jobAd: string;
}
const EMPTY: Profile = { role: "", name: "", contact: "", education: "", skills: "", extras: [], wovenLines: [], jobAd: "" };

// THE AURORA identity accent (was green). Success semantics use their own band colors.
const ACCENT = "#8B5CF6";

const T = {
  ar: {
    seo_h1: "سيرتك الذاتية بمقابلة — الذكاء الاصطناعي يبنيها معك سطراً بسطر",
    seo_sub: "كلم المستشار دقيقتين ويطلع لك سيرة تخترق أنظمة التوظيف — مجاناً وبدون تسجيل.",
    greet: "هلا، وش تشتغل؟",
    greet_sub: "دقيقتين وتطلع بسيرة تخترق الروبوتات — بدون تسجيل",
    think: ["يفكّر…", "يصيغ…", "يرتّب أفكارك…"],
    input_ph: "اكتب جوابك…",
    send: "أرسل",
    mic_title: "جاوب بصوتك",
    have_cv: "عندي سيرة — أحدّثها",
    escape: "عندي سيرة جاهزة — افحصها ↗",
    net_fail: "شبكتي علقت لحظة — إجابتك محفوظة، نكمل 👇",
    retry: "أعد المحاولة",
    weaving_title: "أكتب سيرتك…",
    build_fail: "تأخرت عليك — نعيدها؟",
    welcome_back: "أهلاً بعودتك. نكمل من وين وقفنا؟",
    continue_btn: "كمّل",
    restart_btn: "من جديد",
    reveal_title: "سيرتك جاهزة 🎉",
    reveal_score: "نتيجتها أمام أنظمة التوظيف",
    tpl_pick: "غيّر القالب:",
    lang_pick: "لغة السيرة:",
    lang_opts: { en: "English", ar: "العربية", both: "الاثنين" },
    lang_err: "ما ضبطت — جرب ثانية.",
    unlock: "فك العلامة المائية — 35 ريال مرة وحدة",
    edit_save: "حفظ",
    paste_ph: "الصق سيرتك الحالية هنا، أو ارفع ملف…",
    upload: "📎 ارفع",
    uploading: "أقرأ الملف…",
    upload_fail: "ما قدرت أقرأ الملف — الصق النص.",
    cv_short: "النص قصير — الصق سيرتك كاملة.",
    goal_q: "وصلتني سيرتك 👌 وش نسوي فيها؟",
    goal_add: "➕ أضف خبرة",
    goal_tailor: "🎯 فصّلها على وظيفة",
    goal_improve: "✨ حسّنها",
    jobad_q: "الصق إعلان الوظيفة، أو اكتب «تخطَّ»",
    updating: "أدمج الجديد وأعيد صياغة سيرتك 🪄",
    sections: { exp: "الخبرة", edu: "التعليم", skills: "المهارات", extras: "إضافات" },
    optimize_href: "/ar/optimize",
    cv_toggle: "👁️ سيرتك",
    skip: "تخطَّ",
  },
  en: {
    seo_h1: "Your resume, by interview — AI builds it with you line by line",
    seo_sub: "Talk to the Advisor for two minutes and walk away with an ATS-beating resume — free, no signup.",
    greet: "Hi — what do you do?",
    greet_sub: "Two minutes to a robot-proof resume — no signup",
    think: ["Thinking…", "Writing…", "Organizing your thoughts…"],
    input_ph: "Type your answer…",
    send: "Send",
    mic_title: "Answer by voice",
    have_cv: "I have a resume — update it",
    escape: "I already have a resume — scan it ↗",
    net_fail: "My connection hiccuped — your answer is saved, let's continue 👇",
    retry: "Try again",
    weaving_title: "Writing your resume…",
    build_fail: "That took too long — try again?",
    welcome_back: "Welcome back. Continue where we left off?",
    continue_btn: "Continue",
    restart_btn: "Start over",
    reveal_title: "Your resume is ready 🎉",
    reveal_score: "Its score against ATS robots",
    tpl_pick: "Switch template:",
    lang_pick: "CV language:",
    lang_opts: { en: "English", ar: "العربية", both: "Both" },
    lang_err: "Didn't work — try again.",
    unlock: "Remove the watermark — SAR 35, one time",
    edit_save: "Save",
    paste_ph: "Paste your current resume here, or upload a file…",
    upload: "📎 Upload",
    uploading: "Reading…",
    upload_fail: "Couldn't read the file — paste the text.",
    cv_short: "That's short — paste your full resume.",
    goal_q: "Got your resume 👌 What shall we do with it?",
    goal_add: "➕ Add experience",
    goal_tailor: "🎯 Tailor to a job",
    goal_improve: "✨ Improve it",
    jobad_q: "Paste the job posting, or type \"skip\"",
    updating: "Merging the new material and rewriting your resume 🪄",
    sections: { exp: "Experience", edu: "Education", skills: "Skills", extras: "Extras" },
    optimize_href: "/optimize",
    cv_toggle: "👁️ Your CV",
    skip: "skip",
  },
} as const;

async function fetchT(url: string, body: object, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, signal: ctrl.signal, body: JSON.stringify(body) });
  } finally { clearTimeout(timer); }
}
async function readNdjson(res: Response, field: string): Promise<{ text: string; score?: number; watermark?: boolean }> {
  const ctype = res.headers.get("content-type") || "";
  if (!ctype.includes("ndjson")) throw new Error("failed");
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = ""; let text = ""; let score: number | undefined; let watermark: boolean | undefined;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n"); buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.t === "result") { if (msg.d?.[field]) text = msg.d[field]; if (typeof msg.d?.matchScore === "number") score = msg.d.matchScore; watermark = msg.d?.watermark; }
        else if (msg.t === "error") throw new Error(msg.d);
      } catch (e) { if (e instanceof Error && e.message !== line) throw e; }
    }
  }
  return { text, score, watermark };
}

export default function AdvisorLanding({ lang }: { lang: Lang }) {
  const t = T[lang];
  const rtl = lang === "ar";
  const DRAFT_KEY = `ra_advisor3_${lang}`;
  const reduce = useReducedMotion();

  const [stage, setStage] = useState<Stage>("greeting");
  const [profile, setProfile] = useState<Profile>(EMPTY);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [progress, setProgress] = useState(0);
  const [chips, setChips] = useState<Chip[]>([]);
  const [thinkIdx, setThinkIdx] = useState(0);
  const [typedGreet, setTypedGreet] = useState("");
  const [welcomeBack, setWelcomeBack] = useState(false);
  const [buildFail, setBuildFail] = useState(false);
  const [netFail, setNetFail] = useState(false);
  const [showCvMobile, setShowCvMobile] = useState(false);

  // update mode
  const [mode, setMode] = useState<"new" | "update">("new");
  const [pasteMode, setPasteMode] = useState(false);
  const [cvBase, setCvBase] = useState("");
  const [uploading, setUploading] = useState(false);
  const [goalMode, setGoalMode] = useState(false);
  const [jobAdMode, setJobAdMode] = useState<null | "add" | "tailor">(null);

  // reveal
  const [cv, setCv] = useState("");
  const [score, setScore] = useState<{ value: number; watermark: boolean } | null>(null);
  const [scorePhase, setScorePhase] = useState<"idle" | "working" | "done" | "failed">("idle");
  const [tpl, setTpl] = useState(TEMPLATE_CATALOG[0]);
  const [outChoice, setOutChoice] = useState<OutLang>(lang);
  const [langBusy, setLangBusy] = useState(false);
  const [langErr, setLangErr] = useState(false);
  const [editing, setEditing] = useState<{ path: string; value: string } | null>(null);

  // voice
  const [micOn, setMicOn] = useState(false);
  const [micSupported, setMicSupported] = useState(false);
  const recRef = useRef<{ stop: () => void } | null>(null);
  const startedRef = useRef(false);
  const chatRef = useRef<HTMLDivElement>(null);

  /* ── boot ── */
  useEffect(() => {
    // Arabic-first for the Saudi market.
    if (lang === "en") {
      try {
        if ((navigator.language || "").toLowerCase().startsWith("ar") && localStorage.getItem("ra_lang_choice") !== "en") { window.location.replace("/ar"); return; }
      } catch { /* ignore */ }
    }
    const w = window as unknown as Record<string, unknown>;
    setMicSupported(Boolean(w.webkitSpeechRecognition || w.SpeechRecognition));
    try {
      const saved = localStorage.getItem(DRAFT_KEY);
      if (saved) { const d = JSON.parse(saved); if (d?.stage && d.stage !== "greeting" && d.stage !== "reveal") { setWelcomeBack(true); return; } }
    } catch { /* ignore */ }
    beginGreeting();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function beginGreeting() {
    if (reduce) { setTypedGreet(t.greet); return; }
    let i = 0;
    const id = setInterval(() => { i += 1; setTypedGreet(t.greet.slice(0, i)); if (i >= t.greet.length) clearInterval(id); }, 45);
  }

  /* rotate thinking labels */
  useEffect(() => {
    if (stage !== "thinking") return;
    const id = setInterval(() => setThinkIdx((n) => (n + 1) % t.think.length), 1800);
    return () => clearInterval(id);
  }, [stage, t.think.length]);

  useEffect(() => { chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: reduce ? "auto" : "smooth" }); }, [msgs, reduce]);

  /* ── draft persistence ── */
  const persist = useCallback((next: Partial<{ stage: Stage; profile: Profile; msgs: Msg[]; mode: string; cvBase: string; progress: number }>) => {
    try {
      const cur = { stage, profile, msgs: msgs.slice(-30), mode, cvBase, progress };
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...cur, ...next, msgs: (next.msgs ?? msgs).slice(-30) }));
    } catch { /* noop */ }
  }, [stage, profile, msgs, mode, cvBase, progress, DRAFT_KEY]);

  function restoreDraft() {
    try {
      const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || "{}");
      if (d?.profile) setProfile({ ...EMPTY, ...d.profile });
      if (Array.isArray(d?.msgs)) setMsgs(d.msgs);
      if (typeof d?.progress === "number") setProgress(d.progress);
      if (d?.mode === "update") { setMode("update"); if (typeof d.cvBase === "string") setCvBase(d.cvBase); }
      setStage("conversation");
    } catch { beginGreeting(); }
    setWelcomeBack(false);
  }
  function hardRestart() {
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* noop */ }
    setWelcomeBack(false); setProfile(EMPTY); setMsgs([]); setProgress(0); setMode("new"); setCvBase(""); setStage("greeting"); beginGreeting();
  }

  /* ── merge a profile_patch from the brain into our profile ── */
  function mergePatch(p: Profile, patch: Record<string, unknown>): Profile {
    const n = { ...p, extras: [...p.extras], wovenLines: [...p.wovenLines] };
    if (typeof patch.name === "string" && patch.name) n.name = patch.name.slice(0, 100);
    if (typeof patch.contact === "string" && patch.contact) n.contact = patch.contact.slice(0, 200);
    if (typeof patch.role === "string" && patch.role) n.role = patch.role.slice(0, 120);
    if (typeof patch.targetRole === "string" && patch.targetRole) n.role = patch.targetRole.slice(0, 120);
    if (typeof patch.education === "string" && patch.education) n.education = patch.education.slice(0, 400);
    if (typeof patch.skills === "string" && patch.skills) n.skills = String(patch.skills).slice(0, 400);
    if (typeof patch.jobAd === "string" && patch.jobAd) n.jobAd = patch.jobAd.slice(0, 3000);
    if (Array.isArray(patch.extras)) n.extras.push(...patch.extras.map(String).slice(0, 6));
    // experiences[] → flatten bullets into woven lines
    if (Array.isArray(patch.experiences)) {
      for (const ex of patch.experiences as Array<Record<string, unknown>>) {
        if (typeof ex?.header === "string" && ex.header) n.wovenLines.push(ex.header);
        if (Array.isArray(ex?.bullets)) n.wovenLines.push(...(ex.bullets as unknown[]).map((b) => `- ${String(b)}`));
      }
    }
    return n;
  }

  /* ══════════ the BRAIN turn ══════════ */
  async function sendTurn(answer: string, seedProfile?: Profile) {
    const base = seedProfile ?? profile;
    const history = msgs.slice(-10);
    setStage("thinking");
    setNetFail(false);
    let data: { action?: string; say?: string; profile_patch?: Record<string, unknown>; resume_lines?: string[]; chips?: Chip[]; progress?: number } | null = null;
    for (let attempt = 0; attempt < 2 && !data; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 2500));
      try {
        const res = await fetchT("/api/interview", {
          action: "turn", lang: outChoice, answer,
          targetRole: base.role,
          profile: { role: base.role, name: base.name, contact: base.contact, education: base.education, skills: base.skills, outputLang: outChoice },
          history: history.map((m) => ({ who: m.who, text: m.text })),
        }, 90000);
        const j = await res.json();
        if (res.ok && (j.say || (Array.isArray(j.resume_lines) && j.resume_lines.length))) data = j;
      } catch { /* retry */ }
    }
    if (!data) {
      // Never a silent "kept as-is" — honest message, answer preserved, continue.
      setStage("conversation");
      setNetFail(true);
      return;
    }
    const merged = mergePatch(base, data.profile_patch || {});
    const newLines = Array.isArray(data.resume_lines) ? data.resume_lines.map(String).filter(Boolean) : [];
    if (newLines.length) merged.wovenLines.push(...newLines);
    setProfile(merged);
    if (typeof data.progress === "number") {
      // Models sometimes return a 0–1 fraction instead of 0–100 — normalize.
      const pv = data.progress > 0 && data.progress <= 1 ? data.progress * 100 : data.progress;
      setProgress((prev) => Math.max(prev, Math.min(100, Math.round(pv))));
    }
    setChips(Array.isArray(data.chips) ? data.chips.slice(0, 4) : []);
    const say = String(data.say || "").trim();
    const nextMsgs = say ? [...msgs, { who: "ai" as const, text: say }] : msgs;
    setMsgs(nextMsgs);
    persist({ profile: merged, msgs: nextMsgs, stage: "conversation" });

    if (newLines.length && !reduce) {
      // WEAVING: the CV overtakes the screen and the new lines type in.
      setStage("weaving");
      setTimeout(() => setStage(data!.action === "FINISH" ? "thinking" : "conversation"), 2200);
      if (data.action === "FINISH") setTimeout(() => finalize(merged), 2300);
    } else if (data.action === "FINISH") {
      finalize(merged);
    } else {
      setStage("conversation");
    }
  }

  /* ── send handler (greeting/conversation) ── */
  async function onSend(raw?: string) {
    const text = (raw ?? input).trim();
    if (!text) return;
    setInput("");
    if (!startedRef.current) { startedRef.current = true; track("interview_started", { lang }); }
    track("question_answered", {});

    // paste-existing-CV path
    if (pasteMode) {
      if (text.length < 100) { setMsgs((m) => [...m, { who: "ai", text: t.cv_short }]); return; }
      setCvBase(text.slice(0, 8000)); setPasteMode(false); setMode("update"); setGoalMode(true);
      setMsgs((m) => [...m, { who: "user", text: text.slice(0, 60) + "…" }, { who: "ai", text: t.goal_q }]);
      return;
    }
    // job-ad capture (update tailor/add-finish)
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
    const nextMsgs = [...msgs, { who: "user" as const, text }];
    setMsgs(nextMsgs);
    sendTurn(text);
  }

  function pickChip(c: Chip) {
    if (c.patch) setProfile((p) => mergePatch(p, c.patch!));
    onSend(c.label.replace(/^[➕🎯✨\s]+/, ""));
    setChips([]);
  }

  /* ── update-mode entry ── */
  function startUpdate() {
    if (!startedRef.current) { startedRef.current = true; track("interview_started", { lang, mode: "update" }); }
    setPasteMode(true); setStage("conversation");
    setMsgs((m) => [...m, { who: "ai", text: t.paste_ph }]);
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
    } catch { setMsgs((m) => [...m, { who: "ai", text: t.upload_fail }]); }
    finally { setUploading(false); }
  }
  function chooseGoal(goal: "add" | "tailor" | "improve") {
    setGoalMode(false);
    const label = goal === "add" ? t.goal_add : goal === "tailor" ? t.goal_tailor : t.goal_improve;
    setMsgs((m) => [...m, { who: "user", text: label }]);
    if (goal === "improve") { runUpdate(profile); return; }
    setJobAdMode(goal);
    setMsgs((m) => [...m, { who: "ai", text: t.jobad_q }]);
  }

  /* ── finalize (interview) → assemble → optimize → reveal ── */
  function assembleResume(p: Profile): string {
    const parts: string[] = [];
    if (p.name) parts.push(p.name);
    if (p.contact) parts.push(p.contact);
    if (p.role) parts.push(`\n${rtl ? "الهدف الوظيفي" : "PROFESSIONAL SUMMARY"}\n${p.role}`);
    if (p.wovenLines.length) parts.push(`\n${rtl ? "الخبرة العملية" : "EXPERIENCE"}\n${p.wovenLines.join("\n")}`);
    if (p.education) parts.push(`\n${rtl ? "التعليم" : "EDUCATION"}\n${p.education}`);
    if (p.skills) parts.push(`\n${rtl ? "المهارات" : "SKILLS"}\n${p.skills}`);
    if (p.extras.length) parts.push(`\n${rtl ? "إضافات" : "ADDITIONAL"}\n${p.extras.map((x) => `- ${x}`).join("\n")}`);
    return parts.join("\n");
  }
  async function finalize(p: Profile) {
    setStage("reveal"); setScorePhase("working"); setBuildFail(false);
    try {
      const resumeText = assembleResume(p).slice(0, 8000);
      const jd = p.jobAd.trim().length >= 30 ? p.jobAd : "";
      const res = await fetchT("/api/optimize", { resume: resumeText, jobDescription: jd, outLang: outChoice }, 90000);
      const { text: opt, score: sc, watermark } = await readNdjson(res, "optimizedResume");
      if (!opt) throw new Error("empty");
      setCv(opt);
      if (typeof sc === "number") { setScore({ value: sc, watermark: watermark !== false }); setScorePhase("done"); } else setScorePhase("failed");
      track("cv_completed", { lang, mode });
      try { saveResume({ title: `${p.name || "CV"} — ${p.role || "advisor"}`, source: "built", text: opt }); } catch { /* noop */ }
    } catch { setBuildFail(true); setScorePhase("failed"); }
  }

  /* ── update path: merge base CV + additions via optimize ── */
  async function runUpdate(p: Profile) {
    setStage("reveal"); setScorePhase("working"); setBuildFail(false);
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
      if (typeof sc === "number") { setScore({ value: sc, watermark: watermark !== false }); setScorePhase("done"); } else setScorePhase("failed");
      track("cv_completed", { lang, mode: "update" });
      try { saveResume({ title: `${p.name || "CV"} — ${rtl ? "محدثة" : "updated"}`, source: "optimized", text: opt }); } catch { /* noop */ }
    } catch { setBuildFail(true); setScorePhase("failed"); }
  }

  /* ── reveal: change output language ── */
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

  /* ── voice ── */
  function toggleMic() {
    if (micOn) { recRef.current?.stop(); return; }
    const w = window as unknown as { webkitSpeechRecognition?: new () => SR; SpeechRecognition?: new () => SR };
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) return;
    interface SR { lang: string; interimResults: boolean; continuous: boolean; onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onend: (() => void) | null; onerror: (() => void) | null; start: () => void; stop: () => void }
    const rec = new Ctor();
    rec.lang = lang === "ar" ? "ar-SA" : "en-US"; rec.interimResults = true; rec.continuous = false;
    rec.onresult = (e) => { let s = ""; for (let i = 0; i < e.results.length; i++) s += e.results[i][0].transcript; setInput(s); };
    rec.onend = () => setMicOn(false); rec.onerror = () => setMicOn(false);
    recRef.current = rec; setMicOn(true); rec.start();
  }

  /* ── edit any line ── */
  function applyEdit() {
    if (!editing) return;
    const [kind, a] = editing.path.split(":"); const v = editing.value.trim();
    setProfile((p) => {
      const n = { ...p, wovenLines: [...p.wovenLines], extras: [...p.extras] };
      if (kind === "line") { const i = Number(a); if (v) n.wovenLines[i] = v; else n.wovenLines.splice(i, 1); }
      else if (kind === "education") n.education = v;
      else if (kind === "skills") n.skills = v;
      else if (kind === "extra") { const i = Number(a); if (v) n.extras[i] = v; else n.extras.splice(i, 1); }
      persist({ profile: n });
      return n;
    });
    setEditing(null);
  }
  const editLine = (path: string, value: string, cls = "") =>
    editing?.path === path ? (
      <span className="block">
        <textarea value={editing.value} onChange={(e) => setEditing({ path, value: e.target.value })} rows={2} autoFocus
          className="w-full rounded-lg p-2" style={{ background: "rgba(11,18,32,0.85)", color: "#f4f5f3", border: `1px solid ${ACCENT}`, fontSize: 16 }} />
        <button onClick={applyEdit} className="mt-1 min-h-9 rounded-lg px-4 text-xs font-bold" style={{ background: ACCENT, color: "#ffffff" }}>{t.edit_save}</button>
      </span>
    ) : (
      <button onClick={() => setEditing({ path, value })} className={`block w-full rounded px-1 text-start transition-colors hover:bg-white/10 ${cls}`} style={{ minHeight: 26 }}>{value}</button>
    );

  const lastAi = msgs.length && msgs[msgs.length - 1].who === "ai" ? msgs[msgs.length - 1].text : "";
  const inputActive = stage === "greeting" || stage === "conversation";
  const showGoal = goalMode;
  const orbSize = stage === "greeting" ? (typeof window !== "undefined" && window.innerWidth < 640 ? 150 : 200) : stage === "thinking" ? 190 : stage === "weaving" ? 44 : 72;

  // Delegate to رابط, the one global orb: it flies to each stage and carries
  // the progress ring / pulse rings. Hidden at the reveal (retires to the
  // inline green ✓ in the reveal header).
  useOrbScene(
    stage === "reveal"
      ? { visible: false }
      : { visible: true, top: stage === "greeting" ? "15vh" : stage === "thinking" ? "32vh" : stage === "weaving" ? "84px" : "78px", size: orbSize, mood: stage === "thinking" ? "thinking" : micOn ? "listening" : "idle", progress: stage === "conversation" ? progress : 0, rings: stage === "thinking", badge: null, radio: false, z: 30 },
    [stage, orbSize, micOn, progress]
  );

  /* ══════════════════ render ══════════════════ */
  return (
    <div dir={rtl ? "rtl" : "ltr"} className="relative min-h-screen overflow-hidden" style={{ background: stage === "reveal" ? "var(--glass-bg)" : "var(--cosmos-bg)", color: stage === "reveal" ? "var(--glass-text)" : "var(--cosmos-text)", transition: "background 0.9s var(--smooth)" }}>
      {/* faint aurora behind the orb (greeting only, 30%) */}
      {stage === "greeting" && <div className="aurora-bg" aria-hidden style={{ opacity: 0.3 }} />}

      {/* SEO headline — visually hidden but crawlable */}
      <h1 className="sr-only">{t.seo_h1}. {t.seo_sub}</h1>

      {/* nav */}
      <nav className="relative z-40 mx-auto flex max-w-6xl items-center justify-between px-5 py-4">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg font-mono text-sm font-bold" style={{ background: ACCENT, color: "#ffffff" }}>R</div>
          <span className="text-[15px] font-bold tracking-tight" style={{ color: stage === "reveal" ? "var(--glass-text)" : "#f4f5f3" }}>ResumeAI</span>
        </div>
        <div className="flex items-center gap-1">
          <Link href={t.optimize_href} className="hidden min-h-11 items-center px-3 text-sm font-semibold sm:flex" style={{ color: stage === "reveal" ? "var(--glass-muted)" : "rgba(244,245,243,0.6)" }}>{t.escape}</Link>
          <Link href={rtl ? "/" : "/ar"} onClick={() => { try { localStorage.setItem("ra_lang_choice", rtl ? "en" : "ar"); } catch { /* noop */ } }} className="flex min-h-11 items-center px-3 text-sm font-semibold" style={{ color: ACCENT }}>{rtl ? "English" : "عربي"}</Link>
        </div>
      </nav>

      {/* ══ STATE 1: GREETING ══ */}
      <AnimatePresence>
        {stage === "greeting" && !welcomeBack && (
          <motion.div key="greet" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="pointer-events-none absolute inset-x-0 z-20 flex flex-col items-center px-6 text-center" style={{ top: "44vh" }}>
            <p className="font-extrabold" style={{ fontSize: "clamp(2rem, 7vw, 3.6rem)", lineHeight: 1.15 }}>{typedGreet}<span className="animate-pulse" style={{ color: ACCENT }}>▌</span></p>
            <p className="mt-4 max-w-md text-base" style={{ color: "var(--cosmos-muted)", lineHeight: 1.8 }}>{t.greet_sub}</p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* welcome-back */}
      {welcomeBack && (
        <div className="absolute inset-x-0 z-30 flex flex-col items-center px-6 text-center" style={{ top: "40vh" }}>
          <p className="text-2xl font-bold">{t.welcome_back}</p>
          <div className="mt-5 flex gap-2">
            <button onClick={restoreDraft} className="min-h-11 rounded-xl px-6 text-sm font-bold" style={{ background: ACCENT, color: "#ffffff" }}>{t.continue_btn}</button>
            <button onClick={hardRestart} className="min-h-11 rounded-xl px-6 text-sm font-semibold" style={{ border: "1px solid rgba(255,255,255,0.2)", color: "rgba(244,245,243,0.7)" }}>{t.restart_btn}</button>
          </div>
        </div>
      )}

      {/* ══ STATE 2: CONVERSATION ══ */}
      {stage === "conversation" && (
        <div className="relative z-20 mx-auto flex w-full max-w-2xl flex-col px-5" style={{ paddingTop: "150px", paddingBottom: "160px" }}>
          <div ref={chatRef} className="space-y-3 overflow-y-auto" style={{ maxHeight: "calc(100vh - 320px)" }}>
            {msgs.slice(0, -1).map((m, i) => (
              <div key={i} className={`flex ${m.who === "user" ? (rtl ? "justify-start" : "justify-end") : rtl ? "justify-end" : "justify-start"}`}>
                <div className="max-w-[85%] rounded-2xl px-4 py-2.5 text-[15px]" dir="auto" style={m.who === "user" ? { background: "rgba(34,197,94,0.16)", lineHeight: 1.8 } : { background: "rgba(255,255,255,0.06)", lineHeight: 1.8 }}>{m.text}</div>
              </div>
            ))}
          </div>
          {/* current question — larger, natural alignment */}
          {lastAi && <p key={msgs.length} dir="auto" className="advisor-prompt mt-4" style={{ textAlign: rtl ? "right" : "left", fontSize: "clamp(1.3rem,3.8vw,1.9rem)" }}>{lastAi}</p>}
          {netFail && <p className="mt-3 text-sm" style={{ color: "#fca5a5" }}>{t.net_fail}</p>}

          {/* goal chips (update mode) */}
          {showGoal && (
            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              <button onClick={() => chooseGoal("add")} className="min-h-11 flex-1 rounded-xl px-3 text-sm font-bold" style={{ background: ACCENT, color: "#ffffff" }}>{t.goal_add}</button>
              <button onClick={() => chooseGoal("tailor")} className="min-h-11 flex-1 rounded-xl px-3 text-sm font-semibold" style={{ border: "1px solid rgba(255,255,255,0.2)" }}>{t.goal_tailor}</button>
              <button onClick={() => chooseGoal("improve")} className="min-h-11 flex-1 rounded-xl px-3 text-sm font-semibold" style={{ border: "1px solid rgba(255,255,255,0.2)" }}>{t.goal_improve}</button>
            </div>
          )}
          {/* brain chips */}
          {!showGoal && chips.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {chips.map((c, i) => (
                <button key={i} onClick={() => pickChip(c)} className="min-h-11 rounded-full px-4 text-sm font-semibold" style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.15)", color: "rgba(244,245,243,0.9)" }}>{c.label}</button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ══ STATE 3: THINKING label ══ */}
      {stage === "thinking" && (
        <div className="absolute inset-x-0 z-20 flex justify-center" style={{ top: "56vh" }}>
          <span className="breathe font-mono text-sm tracking-wider" style={{ color: "var(--cosmos-muted)" }}>{t.think[thinkIdx]}</span>
        </div>
      )}

      {/* ══ STATE 4: WEAVING (CV takes the stage) ══ */}
      <AnimatePresence>
        {(stage === "weaving" || (stage === "conversation" && showCvMobile)) && (
          <motion.div key="weave" initial={{ opacity: 0, y: reduce ? 0 : 30 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reduce ? 0 : 20 }}
            transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            className="absolute inset-x-0 z-30 mx-auto px-5" style={{ top: "150px", bottom: "20px", maxWidth: 640 }}>
            <div className="glass-panel h-full overflow-y-auto p-5" style={{ background: "rgba(10,14,26,0.9)" }}>
              <div className="mb-3 flex items-center justify-between">
                <span className="font-mono text-[11px] font-bold uppercase tracking-wider" style={{ color: ACCENT }}>{t.weaving_title}</span>
                {showCvMobile && <button onClick={() => setShowCvMobile(false)} className="text-xs" style={{ color: "var(--cosmos-muted)" }}>✕</button>}
              </div>
              {cvPanelBody()}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* mobile CV toggle */}
      {stage === "conversation" && profile.wovenLines.length > 0 && !showCvMobile && (
        <button onClick={() => setShowCvMobile(true)} className="fixed z-40 rounded-full px-4 py-2 text-xs font-bold lg:hidden" style={{ bottom: 92, insetInlineEnd: 16, background: ACCENT, color: "#ffffff", boxShadow: "0 6px 20px rgba(139,92,246,0.45)" }}>{t.cv_toggle}</button>
      )}

      {/* ══ THE DOCK (floating glass input) ══ */}
      {inputActive && !welcomeBack && !showGoal && (
        <div className="dock">
          <div className="dock-inner">
            <textarea value={input} onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !pasteMode) { e.preventDefault(); onSend(); } }}
              placeholder={pasteMode ? t.paste_ph : t.input_ph} rows={pasteMode ? 4 : 1}
              className="max-h-40 flex-1 resize-none bg-transparent px-2 py-2 outline-none" style={{ color: "#f4f5f3", fontSize: 16, lineHeight: 1.6 }} />
            {pasteMode && (
              <label className="flex min-h-11 cursor-pointer items-center rounded-xl px-3 text-xs font-semibold" style={{ border: "1px solid rgba(255,255,255,0.2)", color: "rgba(244,245,243,0.85)" }}>
                {uploading ? t.uploading : t.upload}
                <input type="file" accept=".pdf,.docx,.txt,.md" className="hidden" disabled={uploading} onChange={(e) => { onFile(e.target.files?.[0] ?? null); e.target.value = ""; }} />
              </label>
            )}
            {micSupported && !pasteMode && (
              <button onClick={toggleMic} title={t.mic_title} aria-label={t.mic_title} className="grid h-11 w-11 place-items-center rounded-xl text-lg" style={micOn ? { background: ACCENT, color: "#ffffff" } : { border: "1px solid rgba(255,255,255,0.2)" }}>🎙</button>
            )}
            <button onClick={() => onSend()} disabled={!input.trim()} className="grid h-11 w-11 place-items-center rounded-xl text-lg font-bold disabled:opacity-30" style={{ background: ACCENT, color: "#ffffff" }}>↑</button>
          </div>
          {stage === "greeting" && (
            <div className="mt-2 flex justify-center gap-4 text-xs">
              <button onClick={startUpdate} className="font-semibold" style={{ color: "rgba(244,245,243,0.7)" }}>{t.have_cv}</button>
            </div>
          )}
        </div>
      )}

      {/* ══ STATE 5: REVEAL (glass world) ══ */}
      {stage === "reveal" && (
        <div className="relative z-20 mx-auto max-w-5xl px-5 pb-24 pt-4">
          <div className="mb-6 flex items-center gap-3">
            <AiOrb size={40} state="done" />
            <h2 className="text-2xl font-extrabold">{t.reveal_title}</h2>
          </div>
          {buildFail ? (
            <div className="glass-surface p-6 text-center">
              <p className="mb-3 text-sm" style={{ color: "var(--glass-muted)" }}>{t.build_fail}</p>
              <button onClick={() => (mode === "update" ? runUpdate(profile) : finalize(profile))} className="min-h-11 rounded-xl px-6 text-sm font-bold text-white" style={{ background: "#16a34a" }}>{t.retry}</button>
            </div>
          ) : (
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
              {/* template preview */}
              <div className="glass-surface p-5" style={{ background: "rgba(255,255,255,0.9)" }}>
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {TEMPLATE_CATALOG.map((tp) => (
                    <button key={tp.slug} onClick={() => setTpl(tp)} className="min-h-9 rounded-lg px-2.5 text-[11px] font-semibold" style={tpl.slug === tp.slug ? { background: tp.accent, color: "#fff" } : { border: "1px solid #e5e7eb", color: "#4b5563" }}>{rtl ? tp.nameAr : tp.name}</button>
                  ))}
                </div>
                {cv && <ResumeTemplate text={cv} name={profile.name || "resume"} variant={tpl.variant} accent={tpl.accent} fitWidth />}
              </div>
              {/* score + actions */}
              <div className="space-y-4">
                <div className="glass-surface p-5 text-center">
                  <h3 className="mb-3 text-sm font-bold">{t.reveal_score}</h3>
                  {scorePhase === "done" && score ? <div className="mx-auto"><ScoreOrb value={score.value} size={150} /></div>
                    : scorePhase === "working" ? <div className="flex items-center justify-center gap-3 py-6"><AiOrb size={34} thinking /><span className="font-mono text-xs" style={{ color: "var(--glass-muted)" }}>…</span></div>
                    : <button onClick={() => finalize(profile)} className="min-h-11 rounded-lg px-5 text-sm font-bold text-white" style={{ background: "#16a34a" }}>{t.retry}</button>}
                </div>
                <div className="glass-surface p-5" onClickCapture={(e) => { if ((e.target as HTMLElement).closest("button")) track("download_clicked", { lang }); }}>
                  <div className="mb-3">
                    <div className="mb-1.5 text-xs font-bold">{t.lang_pick}</div>
                    <div className="flex gap-1.5">
                      {(["en", "ar", "both"] as const).map((c) => (
                        <button key={c} onClick={() => switchLang(c)} disabled={langBusy} className="min-h-9 flex-1 rounded-lg px-2 text-xs font-semibold disabled:opacity-60" style={outChoice === c ? { background: "#16a34a", color: "#fff" } : { border: "1px solid #e5e7eb", color: "#4b5563" }}>{t.lang_opts[c]}</button>
                      ))}
                    </div>
                    {langBusy && <div className="mt-2 flex items-center gap-2"><AiOrb size={18} thinking /><span className="font-mono text-[11px]" style={{ color: "var(--glass-muted)" }}>…</span></div>}
                    {langErr && <button onClick={() => { setLangErr(false); switchLang(outChoice, true); }} className="mt-2 text-xs font-semibold" style={{ color: "#dc2626" }}>{t.lang_err}</button>}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <PdfExport text={cv} watermark={score?.watermark !== false} lang={lang} label="↓ PDF" />
                    <DocxExport text={cv} watermark={score?.watermark !== false} lang={lang} filename={lang === "ar" ? "resume-ar.docx" : "resume.docx"} label="↓ Word" />
                  </div>
                  <PublishLink ar={rtl} text={cv} name={profile.name} role={profile.role} />
                  <Link href="/pricing" className="mt-3 block rounded-xl py-3 text-center text-sm font-bold" style={{ background: "rgba(245,184,64,0.14)", border: "1px solid rgba(245,184,64,0.4)", color: "#b45309" }}>🔓 {t.unlock}</Link>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );

  /* the growing-CV body (shared by weaving overlay + mobile toggle) */
  function cvPanelBody() {
    return (
      <div className="space-y-3 text-sm" style={{ lineHeight: 1.8 }}>
        {profile.name && <div className="text-lg font-extrabold">{profile.name}</div>}
        {profile.contact && <div dir="ltr" className="text-xs" style={{ color: "rgba(244,245,243,0.6)", textAlign: rtl ? "right" : "left", unicodeBidi: "plaintext" }}>{profile.contact}</div>}
        {profile.role && <div className="text-xs font-bold" style={{ color: ACCENT }}>{profile.role}</div>}
        {profile.wovenLines.length > 0 && (
          <div>
            <div className="mb-1 font-mono text-[11px] font-bold uppercase tracking-wider" style={{ color: "rgba(244,245,243,0.5)" }}>{t.sections.exp}</div>
            <ul className="space-y-1">
              {profile.wovenLines.map((l, i) => (
                <li key={i} className="cv-line-in flex gap-1.5 text-[13px]" style={{ color: "rgba(244,245,243,0.8)" }}>
                  <span style={{ color: ACCENT }}>•</span><span className="flex-1">{editLine(`line:${i}`, l.replace(/^[-•*]\s*/, ""))}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {profile.education && (<div><div className="mb-1 font-mono text-[11px] font-bold uppercase tracking-wider" style={{ color: "rgba(244,245,243,0.5)" }}>{t.sections.edu}</div>{editLine("education:", profile.education, "text-[13px]")}</div>)}
        {profile.skills && (<div><div className="mb-1 font-mono text-[11px] font-bold uppercase tracking-wider" style={{ color: "rgba(244,245,243,0.5)" }}>{t.sections.skills}</div>{editLine("skills:", profile.skills, "text-[13px]")}</div>)}
        {profile.extras.length > 0 && (<div><div className="mb-1 font-mono text-[11px] font-bold uppercase tracking-wider" style={{ color: "rgba(244,245,243,0.5)" }}>{t.sections.extras}</div>{profile.extras.map((x, i) => <div key={i}>{editLine(`extra:${i}`, x, "text-[13px]")}</div>)}</div>)}
      </div>
    );
  }
}
