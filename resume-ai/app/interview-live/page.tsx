"use client";
import { useEffect, useRef, useState } from "react";
import OrbBrand from "../components/OrbBrand";
import OrbSceneSetter from "../components/orb/OrbSceneSetter";
import Link from "next/link";
import useLang from "../components/useLang";
import InterviewerAvatar from "../components/InterviewerAvatar";
import CheckoutButton from "../components/CheckoutButton";

/**
 * AI video mock-interview: the candidate sits on camera, the AI asks real
 * interview questions (spoken + text), they record a video answer while the
 * browser live-transcribes it, and the AI scores + coaches each answer. A big
 * differentiator no competitor offers. Video stays on-device (privacy); only
 * the transcript is sent for coaching. Fully bilingual (EN LTR / AR RTL).
 */

interface Feedback { score: number; strengths: string; improve: string; model: string; }
type Phase = "setup" | "paywall" | "asking" | "recording" | "grading" | "review" | "done";

const inputStyle = { background: "var(--surface)", border: "1px solid var(--line)", color: "var(--fg)" };

// Every visible string, both languages. Interpolated bits are functions.
const STR = {
  ar: {
    navCta: "افحص سيرتي", home: "/ar", optimize: "/ar/optimize",
    interviewerLabel: "مُقابِلك الذكي", chipSetup: "مقابلة فيديو بالذكاء الاصطناعي",
    h1: "تدرّب على المقابلة أمام الكاميرا",
    intro: "الذكاء الاصطناعي يسألك أسئلة مقابلة حقيقية، تجاوب أمام الكاميرا، ويعطيك تقييماً ونصائح فورية لكل إجابة. فيديوك يبقى على جهازك فقط.",
    resumeLabel: "نبذة عن خبرتك / سيرتك", resumePlaceholder: "الصق سيرتك أو اكتب نبذة عن خبرتك ومهاراتك…",
    roleLabel: "الوظيفة المستهدفة", rolePlaceholder: "مثال: أخصائي تسويق رقمي",
    preparing: "جارٍ التحضير…", startBtn: "🎥 ابدأ المقابلة",
    micUnsupported: "التفريغ الصوتي غير مدعوم في متصفحك — تقدر تكتب إجابتك يدوياً.",
    resumeTooShort: "أضِف نبذة أطول عن خبرتك أولاً.",
    paywallDefault: "المقابلة التفاعلية ميزة في الحزمة الكاملة — افتحها لنبدأ.",
    paywallSpoken: "المقابلة التفاعلية ميزة في الحزمة الكاملة. افتح الحزمة الكاملة لنبدأ.",
    genFailed: "تعذّر توليد الأسئلة", camDenied: "نحتاج إذن الكاميرا والمايك للمقابلة. فعّلهما وحاول مرة أخرى.",
    err: "خطأ", noAnswer: "لم نلتقط إجابة واضحة — اكتبها بالأسفل أو أعد التسجيل.",
    gradeFailed: "تعذّر التقييم",
    interviewerShort: "المُقابِل", lockChip: "🔒 ميزة الحزمة الكاملة",
    paywallDesc: "المقابلة التفاعلية بالفيديو: مُقابِل ذكي يسألك، تجاوب على الكاميرا، وتقييم فوري لكل إجابة — ضمن الحزمة الكاملة (السيرة + خطاب التعريف + لينكدإن + المقابلة).",
    unlockComplete: "افتح الحزمة الكاملة — ٩٩ ريالاً", unlockSingle: "أو تحسين سيرة واحدة — ٣٥ ريالاً",
    guarantee: "ضمان استرجاع خلال ٧ أيام", replayInterviewer: "🔊 أعد سماع المُقابِل",
    qOf: (i: number, n: number) => `السؤال ${i} من ${n}`, avgLabel: "متوسط تقييمك:",
    you: "أنت", recording: "تسجيل", askLabel: "🎤 المُقابِل يسأل",
    listenQ: "🔊 استمع للسؤال بصوت المُقابِل",
    voiceOff: "جهازك ما فيه صوت عربي مثبّت — تقدر تقرأ السؤال، أو ثبّت صوتاً عربياً من إعدادات الجهاز (النطق/Text-to-Speech).",
    startRec: "🔴 ابدأ تسجيل إجابتك",
    transcriptPlaceholder: (mic: boolean) => mic ? "إجابتك تظهر هنا وأنت تتكلم… (تقدر تعدّلها)" : "اكتب إجابتك هنا…",
    finishAnswer: "⏹ أنهيت — قيّم إجابتي", analyzing: "🧠 المدرّب يحلّل إجابتك…",
    yourScore: "تقييم إجابتك", strength: "نقطة قوة:", toImprove: "↑ للتحسين:",
    modelAnswer: "إجابة نموذجية أقوى",
    nextOrEnd: (last: boolean) => last ? "أنهِ المقابلة ←" : "السؤال التالي ←",
    doneChip: "انتهت المقابلة", practicedN: (n: number) => `تدرّبت على ${n} أسئلة`,
    doneMsg: "كل ما تتدرّب أكثر، ترتفع ثقتك وإجاباتك. تأكد إن سيرتك قوية لنفس الوظيفة قبل المقابلة الحقيقية.",
    scanCta: "افحص سيرتك ضد الوظيفة ←", newInterview: "مقابلة جديدة",
    srLang: "ar-SA",
  },
  en: {
    navCta: "Scan my resume", home: "/", optimize: "/optimize",
    interviewerLabel: "Your AI interviewer", chipSetup: "AI video interview",
    h1: "Practice the interview on camera",
    intro: "The AI asks you real interview questions, you answer on camera, and it gives an instant score and coaching for every answer. Your video never leaves your device.",
    resumeLabel: "About your experience / resume", resumePlaceholder: "Paste your resume or write a short summary of your experience and skills…",
    roleLabel: "Target role", rolePlaceholder: "e.g. Digital Marketing Specialist",
    preparing: "Preparing…", startBtn: "🎥 Start the interview",
    micUnsupported: "Live transcription isn't supported in your browser — you can type your answer instead.",
    resumeTooShort: "Add a longer summary of your experience first.",
    paywallDefault: "The interactive interview is a Complete Pack feature — unlock it to begin.",
    paywallSpoken: "The interactive interview is a Complete Pack feature. Unlock the Complete Pack to begin.",
    genFailed: "Couldn't generate questions", camDenied: "We need camera and mic access for the interview. Enable them and try again.",
    err: "Error", noAnswer: "We didn't catch a clear answer — type it below or re-record.",
    gradeFailed: "Couldn't score the answer",
    interviewerShort: "The interviewer", lockChip: "🔒 Complete Pack feature",
    paywallDesc: "The interactive video interview: an AI interviewer asks, you answer on camera, and get instant feedback on every answer — part of the Complete Pack (resume + cover letter + LinkedIn + interview).",
    unlockComplete: "Unlock the Complete Pack — SAR 99", unlockSingle: "Or improve one resume — SAR 35",
    guarantee: "7-day money-back guarantee", replayInterviewer: "🔊 Hear the interviewer again",
    qOf: (i: number, n: number) => `Question ${i} of ${n}`, avgLabel: "Your average:",
    you: "You", recording: "REC", askLabel: "🎤 The interviewer asks",
    listenQ: "🔊 Hear the question in the interviewer's voice",
    voiceOff: "Your device has no English voice installed — you can read the question, or install a voice in your device settings (Text-to-Speech).",
    startRec: "🔴 Start recording your answer",
    transcriptPlaceholder: (mic: boolean) => mic ? "Your answer appears here as you speak… (you can edit it)" : "Type your answer here…",
    finishAnswer: "⏹ Done — score my answer", analyzing: "🧠 The coach is analyzing your answer…",
    yourScore: "Your answer score", strength: "Strength:", toImprove: "↑ To improve:",
    modelAnswer: "A stronger model answer",
    nextOrEnd: (last: boolean) => last ? "Finish the interview →" : "Next question →",
    doneChip: "Interview complete", practicedN: (n: number) => `You practiced ${n} questions`,
    doneMsg: "The more you practice, the more your confidence and answers grow. Make sure your resume is strong for the same role before the real interview.",
    scanCta: "Scan your resume against the job →", newInterview: "New interview",
    srLang: "en-US",
  },
} as const;

export default function InterviewLivePage() {
  const ar = useLang();
  const t = ar ? STR.ar : STR.en;
  const [resume, setResume] = useState("");
  const [role, setRole] = useState("");
  const [phase, setPhase] = useState<Phase>("setup");
  const [questions, setQuestions] = useState<string[]>([]);
  const [idx, setIdx] = useState(0);
  const [transcript, setTranscript] = useState("");
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [scores, setScores] = useState<number[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [micSupported, setMicSupported] = useState(true);
  const [aiSpeaking, setAiSpeaking] = useState(false);
  const [paywallMsg, setPaywallMsg] = useState("");
  const [voiceOff, setVoiceOff] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recogRef = useRef<any>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  function getAudio() {
    if (!audioRef.current) { audioRef.current = new Audio(); audioRef.current.preload = "auto"; }
    return audioRef.current;
  }

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) setMicSupported(false);
    // Preload TTS voices (getVoices is async on first access on many browsers).
    try {
      window.speechSynthesis?.getVoices();
      window.speechSynthesis?.addEventListener?.("voiceschanged", () => { window.speechSynthesis.getVoices(); });
    } catch { /* noop */ }
    return () => { stopCamera(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function stopCamera() {
    streamRef.current?.getTracks().forEach((tk) => tk.stop());
    streamRef.current = null;
    try { recogRef.current?.stop(); } catch { /* noop */ }
    try { audioRef.current?.pause(); window.speechSynthesis?.cancel(); } catch { /* noop */ }
  }

  // Mobile browsers require a user gesture to unlock speech + the voice must be
  // selected explicitly (lang alone is often silent). Call once synchronously
  // inside a click (start / replay) to unlock, then speaks work.
  function unlockTts() {
    try {
      const a = getAudio();
      a.muted = true;
      a.play().then(() => { a.pause(); a.currentTime = 0; a.muted = false; }).catch(() => { a.muted = false; });
    } catch { /* noop */ }
    try {
      const synth = window.speechSynthesis;
      if (synth) { synth.getVoices(); const u = new SpeechSynthesisUtterance(" "); u.volume = 0; synth.speak(u); }
    } catch { /* noop */ }
  }

  // Pick the best voice for the active UI language.
  function pickVoice(): SpeechSynthesisVoice | null {
    const pref = ar ? /^ar/i : /^en/i;
    const nameHint = ar ? /arab|majed|maged/i : /english|us|uk|gb/i;
    const vs = (window.speechSynthesis?.getVoices?.() || []).filter((v) => pref.test(v.lang) || nameHint.test(v.name));
    if (!vs.length) return null;
    return (
      vs.find((v) => /enhanced|neural|premium|natural|wavenet|siri/i.test(v.name)) ||
      vs.find((v) => !v.localService) ||
      vs[0]
    );
  }

  // Play the natural Azure voice; fall back to the browser voice on any failure.
  async function speak(text: string) {
    try {
      const res = await fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, lang: ar ? "ar" : "en" }) });
      if (!res.ok) throw new Error("tts");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = getAudio();
      try { window.speechSynthesis?.cancel(); } catch { /* noop */ }
      a.src = url;
      a.onplay = () => setAiSpeaking(true);
      a.onended = () => { setAiSpeaking(false); URL.revokeObjectURL(url); };
      a.onerror = () => { setAiSpeaking(false); browserSpeak(text); };
      await a.play();
    } catch {
      browserSpeak(text);
    }
  }

  function browserSpeak(text: string) {
    const synth = window.speechSynthesis;
    if (!synth) { setVoiceOff(true); return; }
    try {
      synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const v = pickVoice();
      if (v) u.voice = v;
      u.lang = v?.lang || t.srLang;
      u.rate = 0.95;
      u.onstart = () => setAiSpeaking(true);
      u.onend = () => setAiSpeaking(false);
      u.onerror = () => { setAiSpeaking(false); };
      // If the device has NO voice for this language at all, flag it.
      const pref = ar ? /^ar/i : /^en/i;
      if (!v && !(synth.getVoices() || []).some((x) => pref.test(x.lang))) setVoiceOff(true);
      synth.speak(u);
    } catch { setAiSpeaking(false); }
  }

  async function start() {
    setError("");
    unlockTts(); // synchronous, inside the click gesture — unlocks mobile TTS
    if (resume.trim().length < 30) { setError(t.resumeTooShort); return; }
    setBusy(true);
    try {
      // Check access + generate questions BEFORE asking for the camera — a free
      // user should hit the AI-spoken paywall, not a camera prompt.
      const res = await fetch("/api/interview-live", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "questions", resume, role, uiLang: ar ? "ar" : "en" }),
      });
      const d = await res.json();
      // Paid feature: the interviewer SPEAKS the paywall line, then offers checkout.
      if (res.status === 402 || d.paywall) {
        setPaywallMsg(d.spoken || t.paywallDefault);
        setPhase("paywall");
        setTimeout(() => speak(d.spoken || t.paywallSpoken), 400);
        setBusy(false);
        return;
      }
      if (!res.ok || !Array.isArray(d.questions) || !d.questions.length) throw new Error(d.error || t.genFailed);
      // Paid → now request the camera and begin.
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: true });
      streamRef.current = stream;
      if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play().catch(() => {}); }
      setQuestions(d.questions);
      setIdx(0);
      askQuestion(d.questions[0]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : t.err;
      setError(/permission|denied|NotAllowed/i.test(msg) ? t.camDenied : msg);
      stopCamera();
    } finally {
      setBusy(false);
    }
  }

  function askQuestion(q: string) {
    setPhase("asking");
    setTranscript("");
    setFeedback(null);
    setTimeout(() => speak(q), 350);
  }

  function startRecording() {
    setTranscript("");
    setPhase("recording");
    window.speechSynthesis?.cancel();
    try { audioRef.current?.pause(); } catch { /* noop */ }
    setAiSpeaking(false);
    if (!micSupported) return; // typed fallback only
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    try {
      const r = new SR();
      r.lang = t.srLang;
      r.continuous = true;
      r.interimResults = true;
      let finalText = "";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      r.onresult = (ev: any) => {
        let interim = "";
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const txt = ev.results[i][0].transcript;
          if (ev.results[i].isFinal) finalText += txt + " ";
          else interim += txt;
        }
        setTranscript((finalText + interim).trim());
      };
      r.onerror = () => {};
      recogRef.current = r;
      r.start();
    } catch { setMicSupported(false); }
  }

  async function stopAndGrade() {
    try { recogRef.current?.stop(); } catch { /* noop */ }
    const answer = transcript.trim();
    if (answer.length < 5) { setError(t.noAnswer); setPhase("recording"); return; }
    setError("");
    setPhase("grading");
    setBusy(true);
    try {
      const res = await fetch("/api/interview-live", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "feedback", question: questions[idx], answer, role, uiLang: ar ? "ar" : "en" }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || t.gradeFailed);
      setFeedback({ score: d.score, strengths: d.strengths, improve: d.improve, model: d.model });
      setScores((s) => [...s, d.score]);
      setPhase("review");
    } catch (e) {
      setError(e instanceof Error ? e.message : t.err);
      setPhase("recording");
    } finally {
      setBusy(false);
    }
  }

  function next() {
    const n = idx + 1;
    if (n >= questions.length) { stopCamera(); setPhase("done"); return; }
    setIdx(n);
    askQuestion(questions[n]);
  }

  const avg = scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : 0;

  return (
    <main dir={ar ? "rtl" : "ltr"} lang={ar ? "ar" : "en"} className="min-h-screen" style={{ background: "var(--bg)", color: "var(--fg)" }}>
      <OrbSceneSetter visible mood="idle" top="14vh" left={ar ? "14%" : "86%"} size={100} />
      <nav className="sticky top-0 z-50" style={{ background: "linear-gradient(180deg, rgba(5,7,13,0.85), transparent)" }}>
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <Link href={t.home} className="flex items-center gap-2.5">
            <OrbBrand size={26} />
            <span className="text-[15px] font-bold tracking-tight">Sira</span>
          </Link>
          <Link href={t.optimize} className="btn-accent px-4 py-2 text-sm">{t.navCta}</Link>
        </div>
      </nav>

      <div className="mx-auto max-w-3xl px-6 py-10">
        {phase === "setup" && (
          <>
            <div className="mb-8 text-center">
              <div className="mx-auto mb-5 h-40 w-40"><InterviewerAvatar speaking={false} label={t.interviewerLabel} lang={ar ? "ar" : "en"} /></div>
              <div className="chip mb-4">{t.chipSetup}</div>
              <h1 className="text-4xl font-extrabold tracking-tight">{t.h1}</h1>
              <p className="mt-3" style={{ color: "var(--muted)" }}>{t.intro}</p>
            </div>
            <div className="card space-y-4 p-7">
              <div>
                <label className="mb-2 block font-mono text-xs uppercase tracking-wider" style={{ color: "var(--faint)" }}>{t.resumeLabel}</label>
                <textarea value={resume} onChange={(e) => setResume(e.target.value)} rows={7} placeholder={t.resumePlaceholder} className="w-full resize-none rounded-lg px-4 py-2.5 text-sm focus:outline-none" style={inputStyle} />
              </div>
              <div>
                <label className="mb-2 block font-mono text-xs uppercase tracking-wider" style={{ color: "var(--faint)" }}>{t.roleLabel}</label>
                <input value={role} onChange={(e) => setRole(e.target.value)} placeholder={t.rolePlaceholder} className="w-full rounded-lg px-4 py-2.5 text-sm focus:outline-none" style={inputStyle} />
              </div>
              {error && <div className="rounded-lg px-3 py-2 text-xs" style={{ background: "rgba(248,113,113,0.1)", color: "#f87171" }}>{error}</div>}
              <button onClick={start} disabled={busy} className="btn-accent w-full py-3 disabled:opacity-50">
                {busy ? t.preparing : t.startBtn}
              </button>
              {!micSupported && <p className="text-center text-xs" style={{ color: "var(--faint)" }}>{t.micUnsupported}</p>}
            </div>
          </>
        )}

        {phase === "paywall" && (
          <div className="text-center">
            <div className="mx-auto mb-4 h-44 w-44"><InterviewerAvatar speaking={aiSpeaking} label={t.interviewerShort} lang={ar ? "ar" : "en"} /></div>
            <div className="card mx-auto max-w-lg p-7" style={{ borderColor: "rgba(139,92,246,0.4)", background: "rgba(139,92,246,0.05)" }}>
              <div className="chip mb-3">{t.lockChip}</div>
              <p className="text-lg font-bold leading-relaxed">{paywallMsg}</p>
              <p className="mx-auto mt-2 max-w-md text-sm" style={{ color: "var(--muted)" }}>{t.paywallDesc}</p>
              <div className="mx-auto mt-5 max-w-xs space-y-3">
                <CheckoutButton ar={ar} plan="complete" label={t.unlockComplete} variant="accent" />
                <CheckoutButton ar={ar} plan="single" label={t.unlockSingle} variant="ghost" />
              </div>
              <p className="mt-4 text-xs" style={{ color: "var(--faint)" }}>
                <a href="/terms" className="underline underline-offset-2">{t.guarantee}</a>
              </p>
              <button onClick={() => speak(paywallMsg)} className="mt-3 block w-full text-xs" style={{ color: "var(--faint)" }}>{t.replayInterviewer}</button>
            </div>
          </div>
        )}

        {phase !== "setup" && phase !== "done" && phase !== "paywall" && (
          <div className="space-y-5">
            {/* Progress bar */}
            <div>
              <div className="mb-2 flex items-center justify-between text-sm" style={{ color: "var(--faint)" }}>
                <span>{t.qOf(idx + 1, questions.length)}</span>
                {scores.length > 0 && <span>{t.avgLabel} <b style={{ color: "var(--accent)" }}>{avg}/10</b></span>}
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: "rgba(255,255,255,0.08)" }}>
                <div className="h-full rounded-full" style={{ width: `${(idx / Math.max(1, questions.length)) * 100}%`, background: "linear-gradient(90deg,var(--accent-deep),var(--accent))", transition: "width .5s ease" }} />
              </div>
            </div>

            {/* Two-panel video call: AI interviewer + you */}
            <div className="grid gap-3 sm:grid-cols-2">
              {/* AI interviewer */}
              <div className="relative overflow-hidden rounded-2xl p-4" style={{ border: "1px solid var(--line)", background: "radial-gradient(ellipse at 50% 0%, rgba(139,92,246,0.08), var(--surface) 70%)", aspectRatio: "1/1" }}>
                <div className="absolute end-3 top-3 rounded-full px-2.5 py-1 font-mono text-[10px] font-bold" style={{ background: "rgba(139,92,246,0.14)", color: "var(--accent)" }}>AI</div>
                <InterviewerAvatar speaking={aiSpeaking} />
              </div>
              {/* You */}
              <div className="relative overflow-hidden rounded-2xl" style={{ border: "1px solid var(--line)", background: "#000", aspectRatio: "1/1" }}>
                <video ref={videoRef} muted playsInline className="h-full w-full object-cover" style={{ transform: "scaleX(-1)" }} />
                <div className="absolute bottom-3 end-3 rounded-full px-2.5 py-1 font-mono text-[10px] font-bold" style={{ background: "rgba(0,0,0,0.55)", color: "#fff" }}>{t.you}</div>
                {phase === "recording" && (
                  <div className="absolute end-3 top-3 flex items-center gap-2 rounded-full px-3 py-1 text-xs font-bold" style={{ background: "rgba(248,113,113,0.9)", color: "#fff" }}>
                    <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-white" /> {t.recording}
                  </div>
                )}
              </div>
            </div>

            {/* Question */}
            <div className="card p-5" style={{ borderColor: aiSpeaking ? "rgba(139,92,246,0.4)" : "var(--line)" }}>
              <div className="mb-1 font-mono text-xs" style={{ color: "var(--accent)" }}>{t.askLabel}</div>
              <div className="text-lg font-bold leading-relaxed">{questions[idx]}</div>
              <button onClick={() => speak(questions[idx])} className="mt-3 rounded-lg px-4 py-2 text-sm font-semibold" style={{ background: "rgba(139,92,246,0.12)", color: "var(--accent)", border: "1px solid rgba(139,92,246,0.3)" }}>{t.listenQ}</button>
              {voiceOff && <p className="mt-2 text-xs" style={{ color: "#fbbf24" }}>{t.voiceOff}</p>}
            </div>

            {error && <div className="rounded-lg px-3 py-2 text-xs" style={{ background: "rgba(248,113,113,0.1)", color: "#f87171" }}>{error}</div>}

            {/* Controls */}
            {(phase === "asking") && (
              <button onClick={startRecording} className="btn-accent w-full py-4 text-lg">{t.startRec}</button>
            )}
            {phase === "recording" && (
              <>
                <textarea value={transcript} onChange={(e) => setTranscript(e.target.value)} rows={4}
                  placeholder={t.transcriptPlaceholder(micSupported)}
                  className="w-full resize-none rounded-lg px-4 py-3 text-sm focus:outline-none" style={inputStyle} />
                <button onClick={stopAndGrade} disabled={busy} className="btn-accent w-full py-4 text-lg disabled:opacity-50">{t.finishAnswer}</button>
              </>
            )}
            {phase === "grading" && (
              <div className="card p-5 text-center" style={{ color: "var(--muted)" }}>
                <span className="animate-pulse">{t.analyzing}</span>
              </div>
            )}
            {phase === "review" && feedback && (
              <div className="space-y-3">
                <div className="card p-5" style={{ borderColor: "rgba(139,92,246,0.4)" }}>
                  <div className="mb-2 flex items-center justify-between">
                    <span className="font-bold">{t.yourScore}</span>
                    <span className="font-mono text-2xl font-bold" style={{ color: feedback.score >= 7 ? "#a78bfa" : feedback.score >= 5 ? "#fbbf24" : "#f87171" }}>{feedback.score}/10</span>
                  </div>
                  {feedback.strengths && <p className="text-sm" style={{ color: "rgba(244,245,243,0.85)" }}><b style={{ color: "#a78bfa" }}>{t.strength}</b> {feedback.strengths}</p>}
                  {feedback.improve && <p className="mt-2 text-sm" style={{ color: "rgba(244,245,243,0.85)" }}><b style={{ color: "#fbbf24" }}>{t.toImprove}</b> {feedback.improve}</p>}
                  {feedback.model && (
                    <div className="mt-3 rounded-lg p-3 text-sm leading-relaxed" style={{ background: "rgba(139,92,246,0.06)", color: "var(--muted)" }}>
                      <div className="mb-1 font-mono text-xs" style={{ color: "var(--accent)" }}>{t.modelAnswer}</div>
                      {feedback.model}
                    </div>
                  )}
                </div>
                <button onClick={next} className="btn-accent w-full py-3">{t.nextOrEnd(idx + 1 >= questions.length)}</button>
              </div>
            )}
          </div>
        )}

        {phase === "done" && (
          <div className="text-center">
            <div className="chip mb-4">{t.doneChip}</div>
            <h2 className="text-3xl font-extrabold">{t.practicedN(questions.length)}</h2>
            <div className="my-6 inline-flex items-baseline gap-2">
              <span className="font-mono text-6xl font-bold" style={{ color: "var(--accent)" }}>{avg}</span>
              <span className="text-2xl" style={{ color: "var(--faint)" }}>/10</span>
            </div>
            <p className="mx-auto max-w-md text-sm" style={{ color: "var(--muted)" }}>{t.doneMsg}</p>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <Link href={t.optimize} className="btn-accent px-6 py-3">{t.scanCta}</Link>
              <button onClick={() => { setPhase("setup"); setScores([]); setQuestions([]); setIdx(0); }} className="btn-ghost px-6 py-3 font-semibold" style={{ color: "var(--fg)" }}>{t.newInterview}</button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
