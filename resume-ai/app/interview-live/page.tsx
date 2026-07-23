"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";

/**
 * AI video mock-interview: the candidate sits on camera, the AI asks real
 * interview questions (spoken + text), they record a video answer while the
 * browser live-transcribes it, and the AI scores + coaches each answer. A big
 * differentiator no competitor offers. Video stays on-device (privacy); only
 * the transcript is sent for coaching.
 */

interface Feedback { score: number; strengths: string; improve: string; model: string; }
type Phase = "setup" | "asking" | "recording" | "grading" | "review" | "done";

const inputStyle = { background: "var(--surface)", border: "1px solid var(--line)", color: "var(--fg)" };

export default function InterviewLivePage() {
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

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recogRef = useRef<any>(null);

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) setMicSupported(false);
    return () => { stopCamera(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function stopCamera() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    try { recogRef.current?.stop(); } catch { /* noop */ }
  }

  function speak(text: string) {
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "ar-SA";
      u.rate = 0.95;
      window.speechSynthesis?.cancel();
      window.speechSynthesis?.speak(u);
    } catch { /* speech optional */ }
  }

  async function start() {
    setError("");
    if (resume.trim().length < 30) { setError("أضِف نبذة أطول عن خبرتك أولاً."); return; }
    setBusy(true);
    try {
      // Camera + mic
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: true });
      streamRef.current = stream;
      if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play().catch(() => {}); }
      // Questions
      const res = await fetch("/api/interview-live", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "questions", resume, role, uiLang: "ar" }),
      });
      const d = await res.json();
      if (!res.ok || !Array.isArray(d.questions) || !d.questions.length) throw new Error(d.error || "تعذّر توليد الأسئلة");
      setQuestions(d.questions);
      setIdx(0);
      askQuestion(d.questions[0]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "خطأ";
      setError(/permission|denied|NotAllowed/i.test(msg) ? "نحتاج إذن الكاميرا والمايك للمقابلة. فعّلهما وحاول مرة أخرى." : msg);
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
    if (!micSupported) return; // typed fallback only
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    try {
      const r = new SR();
      r.lang = "ar-SA";
      r.continuous = true;
      r.interimResults = true;
      let finalText = "";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      r.onresult = (ev: any) => {
        let interim = "";
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const t = ev.results[i][0].transcript;
          if (ev.results[i].isFinal) finalText += t + " ";
          else interim += t;
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
    if (answer.length < 5) { setError("لم نلتقط إجابة واضحة — اكتبها بالأسفل أو أعد التسجيل."); setPhase("recording"); return; }
    setError("");
    setPhase("grading");
    setBusy(true);
    try {
      const res = await fetch("/api/interview-live", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "feedback", question: questions[idx], answer, role, uiLang: "ar" }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "تعذّر التقييم");
      setFeedback({ score: d.score, strengths: d.strengths, improve: d.improve, model: d.model });
      setScores((s) => [...s, d.score]);
      setPhase("review");
    } catch (e) {
      setError(e instanceof Error ? e.message : "خطأ");
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
    <main dir="rtl" lang="ar" className="min-h-screen" style={{ background: "var(--bg)", color: "var(--fg)" }}>
      <nav className="sticky top-0 z-50 backdrop-blur" style={{ background: "rgba(8,9,10,0.7)", borderBottom: "1px solid var(--line)" }}>
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <Link href="/ar" className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg font-mono text-sm font-bold" style={{ background: "var(--accent)", color: "#05130a" }}>R</div>
            <span className="text-[15px] font-bold tracking-tight">ResumeAI</span>
          </Link>
          <Link href="/ar/optimize" className="btn-accent px-4 py-2 text-sm">افحص سيرتي</Link>
        </div>
      </nav>

      <div className="mx-auto max-w-3xl px-6 py-10">
        {phase === "setup" && (
          <>
            <div className="mb-8 text-center">
              <div className="chip mb-4">● مقابلة فيديو بالذكاء الاصطناعي</div>
              <h1 className="text-4xl font-extrabold tracking-tight">تدرّب على المقابلة أمام الكاميرا</h1>
              <p className="mt-3" style={{ color: "var(--muted)" }}>
                الذكاء الاصطناعي يسألك أسئلة مقابلة حقيقية، تجاوب أمام الكاميرا، ويعطيك تقييماً ونصائح فورية لكل إجابة. فيديوك يبقى على جهازك فقط.
              </p>
            </div>
            <div className="card space-y-4 p-7">
              <div>
                <label className="mb-2 block font-mono text-xs uppercase tracking-wider" style={{ color: "var(--faint)" }}>نبذة عن خبرتك / سيرتك</label>
                <textarea value={resume} onChange={(e) => setResume(e.target.value)} rows={7} placeholder="الصق سيرتك أو اكتب نبذة عن خبرتك ومهاراتك…" className="w-full resize-none rounded-lg px-4 py-2.5 text-sm focus:outline-none" style={inputStyle} />
              </div>
              <div>
                <label className="mb-2 block font-mono text-xs uppercase tracking-wider" style={{ color: "var(--faint)" }}>الوظيفة المستهدفة</label>
                <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="مثال: أخصائي تسويق رقمي" className="w-full rounded-lg px-4 py-2.5 text-sm focus:outline-none" style={inputStyle} />
              </div>
              {error && <div className="rounded-lg px-3 py-2 text-xs" style={{ background: "rgba(248,113,113,0.1)", color: "#f87171" }}>{error}</div>}
              <button onClick={start} disabled={busy} className="btn-accent w-full py-3 disabled:opacity-50">
                {busy ? "جارٍ التحضير…" : "🎥 ابدأ المقابلة"}
              </button>
              {!micSupported && <p className="text-center text-xs" style={{ color: "var(--faint)" }}>التفريغ الصوتي غير مدعوم في متصفحك — تقدر تكتب إجابتك يدوياً.</p>}
            </div>
          </>
        )}

        {phase !== "setup" && phase !== "done" && (
          <div className="space-y-5">
            {/* Progress */}
            <div className="flex items-center justify-between text-sm" style={{ color: "var(--faint)" }}>
              <span>السؤال {idx + 1} من {questions.length}</span>
              {scores.length > 0 && <span>متوسط تقييمك: <b style={{ color: "var(--accent)" }}>{avg}/10</b></span>}
            </div>

            {/* Camera */}
            <div className="relative overflow-hidden rounded-2xl" style={{ border: "1px solid var(--line)", background: "#000", aspectRatio: "16/10" }}>
              <video ref={videoRef} muted playsInline className="h-full w-full object-cover" style={{ transform: "scaleX(-1)" }} />
              {phase === "recording" && (
                <div className="absolute right-3 top-3 flex items-center gap-2 rounded-full px-3 py-1 text-xs font-bold" style={{ background: "rgba(248,113,113,0.9)", color: "#fff" }}>
                  <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-white" /> تسجيل
                </div>
              )}
            </div>

            {/* Question */}
            <div className="card p-5">
              <div className="mb-1 font-mono text-xs" style={{ color: "var(--accent)" }}>🎤 المُقابِل يسأل</div>
              <div className="text-lg font-bold leading-relaxed">{questions[idx]}</div>
              <button onClick={() => speak(questions[idx])} className="mt-2 text-xs" style={{ color: "var(--faint)" }}>🔊 أعد سماع السؤال</button>
            </div>

            {error && <div className="rounded-lg px-3 py-2 text-xs" style={{ background: "rgba(248,113,113,0.1)", color: "#f87171" }}>{error}</div>}

            {/* Controls */}
            {(phase === "asking") && (
              <button onClick={startRecording} className="btn-accent w-full py-4 text-lg">🔴 ابدأ تسجيل إجابتك</button>
            )}
            {phase === "recording" && (
              <>
                <textarea value={transcript} onChange={(e) => setTranscript(e.target.value)} rows={4}
                  placeholder={micSupported ? "إجابتك تظهر هنا وأنت تتكلم… (تقدر تعدّلها)" : "اكتب إجابتك هنا…"}
                  className="w-full resize-none rounded-lg px-4 py-3 text-sm focus:outline-none" style={inputStyle} />
                <button onClick={stopAndGrade} disabled={busy} className="btn-accent w-full py-4 text-lg disabled:opacity-50">⏹ أنهيت — قيّم إجابتي</button>
              </>
            )}
            {phase === "grading" && (
              <div className="card p-5 text-center" style={{ color: "var(--muted)" }}>
                <span className="animate-pulse">🧠 المدرّب يحلّل إجابتك…</span>
              </div>
            )}
            {phase === "review" && feedback && (
              <div className="space-y-3">
                <div className="card p-5" style={{ borderColor: "rgba(74,222,128,0.4)" }}>
                  <div className="mb-2 flex items-center justify-between">
                    <span className="font-bold">تقييم إجابتك</span>
                    <span className="font-mono text-2xl font-bold" style={{ color: feedback.score >= 7 ? "#4ade80" : feedback.score >= 5 ? "#fbbf24" : "#f87171" }}>{feedback.score}/10</span>
                  </div>
                  {feedback.strengths && <p className="text-sm" style={{ color: "rgba(244,245,243,0.85)" }}><b style={{ color: "#4ade80" }}>✓ نقطة قوة:</b> {feedback.strengths}</p>}
                  {feedback.improve && <p className="mt-2 text-sm" style={{ color: "rgba(244,245,243,0.85)" }}><b style={{ color: "#fbbf24" }}>↑ للتحسين:</b> {feedback.improve}</p>}
                  {feedback.model && (
                    <div className="mt-3 rounded-lg p-3 text-sm leading-relaxed" style={{ background: "rgba(74,222,128,0.06)", color: "var(--muted)" }}>
                      <div className="mb-1 font-mono text-xs" style={{ color: "var(--accent)" }}>إجابة نموذجية أقوى</div>
                      {feedback.model}
                    </div>
                  )}
                </div>
                <button onClick={next} className="btn-accent w-full py-3">{idx + 1 >= questions.length ? "أنهِ المقابلة ←" : "السؤال التالي ←"}</button>
              </div>
            )}
          </div>
        )}

        {phase === "done" && (
          <div className="text-center">
            <div className="chip mb-4">● انتهت المقابلة</div>
            <h2 className="text-3xl font-extrabold">تدرّبت على {questions.length} أسئلة 🎉</h2>
            <div className="my-6 inline-flex items-baseline gap-2">
              <span className="font-mono text-6xl font-bold" style={{ color: "var(--accent)" }}>{avg}</span>
              <span className="text-2xl" style={{ color: "var(--faint)" }}>/10</span>
            </div>
            <p className="mx-auto max-w-md text-sm" style={{ color: "var(--muted)" }}>كل ما تتدرّب أكثر، ترتفع ثقتك وإجاباتك. تأكد إن سيرتك قوية لنفس الوظيفة قبل المقابلة الحقيقية.</p>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <Link href="/ar/optimize" className="btn-accent px-6 py-3">افحص سيرتك ضد الوظيفة ←</Link>
              <button onClick={() => { setPhase("setup"); setScores([]); setQuestions([]); setIdx(0); }} className="btn-ghost px-6 py-3 font-semibold" style={{ color: "var(--fg)" }}>مقابلة جديدة</button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
