"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";

/**
 * Cinematic, scroll-driven homepage experience: acts reveal on scroll, an
 * interactive live CV builder lets the visitor type and watch a resume assemble,
 * a score ring fills, and the finale shows the full assembled CV — every CTA
 * goes to the real product routes.
 */
export default function LandingExperience() {
  const [name, setName] = useState("سارة العتيبي");
  const [role, setRole] = useState("أخصائية تسويق رقمي");
  const [exp, setExp] = useState("رفعت التفاعل ٤٠٪ عبر إدارة ٤ قنوات تواصل");
  const ringRef = useRef<SVGCircleElement | null>(null);
  const [ringVal, setRingVal] = useState(0);

  // Scroll reveals
  useEffect(() => {
    const io = new IntersectionObserver((es) => {
      es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } });
    }, { threshold: 0.18 });
    document.querySelectorAll(".lx-reveal").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  // Score ring fills once, when scrolled into view
  useEffect(() => {
    const el = ringRef.current;
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const C = 703.7, pct = 82;
    let done = false;
    const io = new IntersectionObserver((es) => {
      es.forEach((e) => {
        if (e.isIntersecting && !done) {
          done = true;
          el.style.strokeDashoffset = String(C - (C * pct) / 100);
          if (reduce) { setRingVal(pct); return; }
          const t0 = performance.now();
          const tick = (now: number) => {
            const p = Math.min(1, (now - t0) / 1600);
            setRingVal(Math.round((1 - Math.pow(1 - p, 3)) * pct));
            if (p < 1) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }
      });
    }, { threshold: 0.5 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const summary = `${role || "محترف"} بخبرة في التواصل والمحتوى.`;
  const steps = [name, role, exp].map((v) => v.trim().length > 0);

  const CV = ({ full = false }: { full?: boolean }) => (
    <div className="lx-cv">
      <div className="lx-cv-h"><div className="nm">{name || "اسمك"}</div><div className="ct">الرياض · sara@email.com · +966 5X XXX</div></div>
      <div className="lx-cv-body">
        <div className="lx-cv-side">
          <div className="lx-cv-sec">المهارات</div>
          <div className="lx-cv-li">• استراتيجية المحتوى</div>
          <div className="lx-cv-li">• تحليلات جوجل</div>
          <div className="lx-cv-li">• الإعلانات المدفوعة</div>
          {full && <div className="lx-cv-li">• قيادة الفريق</div>}
          <div className="lx-cv-sec" style={{ marginTop: 14 }}>اللغات</div>
          <div className="lx-cv-li">• العربية (الأم)</div>
          <div className="lx-cv-li">• الإنجليزية{full ? " (احترافية)" : ""}</div>
        </div>
        <div className="lx-cv-main">
          <div className="lx-cv-sec g">الملخص المهني</div>
          <div className="lx-cv-li">{summary}</div>
          <div className="lx-cv-sec g" style={{ marginTop: 12 }}>الخبرة</div>
          <div className="lx-cv-sub">{role || "المسمى"}</div>
          <div className="lx-cv-li">{exp || "أبرز إنجاز لك"}</div>
          {full && <div className="lx-cv-li" style={{ marginTop: 6 }}>— شركة تجزئة، الرياض (٢٠٢١–الآن)</div>}
          <div className="lx-cv-sec g" style={{ marginTop: 12 }}>التعليم</div>
          <div className="lx-cv-li">بكالوريوس تسويق — جامعة الملك سعود{full ? "، ٢٠٢٠" : ""}</div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="mx-auto max-w-6xl px-6" dir="rtl">
      {/* ACT 0 — HERO */}
      <section className="lx-act" style={{ alignItems: "flex-start", minHeight: "88vh" }}>
        <div className="chip lx-reveal">● صادق · بدون اختلاق · cv.rabit.sa</div>
        <h1 className="lx-reveal lx-d1" style={{ marginTop: 22, fontSize: "clamp(44px,7vw,84px)", fontWeight: 900, lineHeight: 1.03, letterSpacing: "-0.02em" }}>
          سيرتك <span className="text-accent">تعبُر</span><br />أنظمة التوظيف
        </h1>
        <p className="lx-reveal lx-d2" style={{ marginTop: 22, fontSize: "clamp(17px,2.2vw,22px)", color: "var(--muted)", maxWidth: "60ch" }}>
          افحص سيرتك مجاناً، أعِد كتابتها بذكاء اصطناعي لا يختلق شيئاً، وابنِها أمامك خطوة بخطوة — حتى تطلع سيرة كاملة جاهزة.
        </p>
        <div className="lx-reveal lx-d3" style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 30 }}>
          <Link href="/optimize" className="btn-accent px-6 py-3">افحص سيرتي مجاناً ←</Link>
          <a href="#lx-build" className="btn-ghost px-6 py-3 font-semibold" style={{ color: "var(--fg)" }}>ابنِ سيرتي الآن</a>
        </div>
        <div className="lx-reveal lx-d4" style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 26 }}>
          <span className="lx-pill">🔒 لا تُخزَّن على خوادمنا</span>
          <span className="lx-pill">🇸🇦 عربي + إنجليزي</span>
          <span className="lx-pill">💳 دفعة واحدة — بدون اشتراك</span>
        </div>
      </section>

      {/* ACT 1 — INTERACTIVE BUILDER */}
      <section className="lx-act" id="lx-build">
        <div className="lx-grid2">
          <div>
            <div className="chip lx-reveal">● الخطوة ١ — لنبنِ سيرتك سوا</div>
            <h2 className="lx-reveal lx-d1" style={{ marginTop: 18, fontSize: "clamp(30px,5vw,52px)", fontWeight: 900, lineHeight: 1.06 }}>اكتب، وشاهدها <span className="text-accent">تُبنى</span> لحظياً</h2>
            <p className="lx-reveal lx-d2" style={{ marginTop: 12, color: "var(--muted)", fontSize: 18 }}>املأ الحقول وسترى سيرتك تتشكّل. هذا ذوق سريع — الأداة الكاملة على الموقع.</p>
            <div className="lx-steps lx-reveal lx-d2">{steps.map((on, i) => <i key={i} className={on ? "on" : ""} />)}</div>
            <div className="lx-reveal lx-d3">
              <label className="lx-field"><span>الاسم الكامل</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="مثال: سارة العتيبي" /></label>
              <label className="lx-field"><span>المسمى المستهدف</span><input value={role} onChange={(e) => setRole(e.target.value)} placeholder="مثال: أخصائية تسويق رقمي" /></label>
              <label className="lx-field"><span>أبرز إنجاز (بجملة + رقم حقيقي)</span><textarea value={exp} onChange={(e) => setExp(e.target.value)} placeholder="مثال: رفعت التفاعل ٤٠٪ عبر ٤ قنوات" /></label>
              <Link href="/build" className="btn-accent px-5 py-2.5 text-sm">أكمِلها في الباني الكامل ←</Link>
            </div>
          </div>
          <div className="lx-reveal lx-d2" style={{ position: "sticky", top: 100 }}><CV /></div>
        </div>
      </section>

      {/* ACT 2 — FREE SCAN + RING */}
      <section className="lx-act">
        <div className="lx-grid2">
          <div>
            <div className="chip lx-reveal">● الخطوة ٢ — الفحص المجاني</div>
            <h2 className="lx-reveal lx-d1" style={{ marginTop: 18, fontSize: "clamp(30px,5vw,52px)", fontWeight: 900 }}>درجة ملاءمة <span className="text-accent">فورية</span></h2>
            <p className="lx-reveal lx-d2" style={{ marginTop: 12, color: "var(--muted)", fontSize: 18 }}>نقارن سيرتك بالوظيفة، نعطيك درجة من ١٠٠، الكلمات الناقصة، وفجوة المهارات — مجاناً قبل ما تدفع ريال.</p>
            <div className="lx-reveal lx-d3" style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 20 }}>
              <span className="lx-pill">✓ الكلمات الناقصة</span><span className="lx-pill">✓ فجوة المهارات</span><span className="lx-pill">✓ الجمل الضعيفة</span>
            </div>
          </div>
          <div className="lx-reveal lx-d2" style={{ display: "grid", placeItems: "center" }}>
            <div style={{ position: "relative", width: 260, height: 260 }}>
              <svg width="260" height="260" viewBox="0 0 260 260">
                <circle cx="130" cy="130" r="112" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="18" />
                <circle ref={ringRef} cx="130" cy="130" r="112" fill="none" stroke="var(--accent)" strokeWidth="18" strokeLinecap="round"
                  transform="rotate(-90 130 130)" strokeDasharray="703.7" strokeDashoffset="703.7" style={{ transition: "stroke-dashoffset 1.6s cubic-bezier(.22,1,.36,1)" }} />
              </svg>
              <div style={{ position: "absolute", inset: 0, display: "grid", placeContent: "center", textAlign: "center" }}>
                <div className="lx-ring-num">{ringVal}</div>
                <div className="font-mono" style={{ color: "var(--faint)", fontSize: 13 }}>/ 100 · درجة الملاءمة</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ACT 3 — NO FABRICATION */}
      <section className="lx-act" style={{ alignItems: "center", textAlign: "center" }}>
        <div className="chip lx-reveal" style={{ margin: "0 auto" }}>● تميّزنا الأساسي</div>
        <div className="lx-reveal lx-d1" style={{ fontSize: "clamp(60px,12vw,130px)", marginTop: 8 }}>🛡️</div>
        <h2 className="lx-reveal lx-d1" style={{ marginTop: 4, fontSize: "clamp(30px,5vw,52px)", fontWeight: 900 }}>صفر <span className="text-accent">اختلاق</span></h2>
        <p className="lx-reveal lx-d2" style={{ margin: "16px auto 0", color: "var(--muted)", fontSize: 18, maxWidth: "62ch" }}>
          محرّكنا لا يضيف رقماً أو مهارة لا تملكها. يحسّن صياغة حقائقك فقط — وإذا نقصك شيء، يسألك ويعلّمك وش تضيف. المنافسون ينفخون الأرقام، ونحن نبني ثقتك.
        </p>
        <div className="lx-reveal lx-d3" style={{ display: "flex", gap: 12, flexWrap: "wrap", justifyContent: "center", marginTop: 26 }}>
          <span className="lx-pill" style={{ color: "#93c5fd" }}>أُعيدت صياغته</span>
          <span className="lx-pill" style={{ color: "var(--accent)" }}>من بياناتك</span>
          <span className="lx-pill" style={{ color: "#fbbf24" }}>⚠ أكّد صحته</span>
          <span className="lx-pill" style={{ color: "#f87171" }}>ناقص — أضِفه</span>
        </div>
      </section>

      {/* ACT 4 — BEFORE / AFTER */}
      <section className="lx-act">
        <div className="chip lx-reveal">● إثبات حقيقي</div>
        <h2 className="lx-reveal lx-d1" style={{ marginTop: 18, fontSize: "clamp(30px,5vw,52px)", fontWeight: 900 }}>قبل ← بعد — <span className="text-accent">بصدق</span></h2>
        <div className="lx-ba lx-reveal lx-d2" style={{ marginTop: 30 }}>
          <div className="n" style={{ color: "#f87171" }}>32</div>
          <div style={{ fontSize: 56, color: "var(--accent)" }}>→</div>
          <div className="n text-accent">82</div>
          <p style={{ marginInlineStart: 20, color: "var(--muted)", fontSize: 18, maxWidth: "40ch" }}>ارتفاع حقيقي تتحقّق منه بنفسك — انسخ السيرة المحسّنة وأعد الفحص تشوف نفس الرقم. مو مبالغة تنكشف بالمقابلة.</p>
        </div>
      </section>

      {/* ACT 5 — FEATURES + TEMPLATES + INTERVIEW */}
      <section className="lx-act">
        <div className="chip lx-reveal">● كل ما تحتاجه</div>
        <h2 className="lx-reveal lx-d1" style={{ marginTop: 18, fontSize: "clamp(30px,5vw,52px)", fontWeight: 900 }}>منصة <span className="text-accent">كاملة</span>، مو أداة واحدة</h2>
        <div className="lx-feat lx-reveal lx-d2" style={{ marginTop: 30 }}>
          <Link href="/templates" className="card card-hover p-6" style={{ display: "block" }}>
            <div style={{ fontSize: 30 }}>📄</div><h3 style={{ fontSize: 19, fontWeight: 800, margin: "12px 0 6px" }}>١٠ قوالب أنيقة</h3>
            <p style={{ fontSize: 14.5, color: "var(--muted)" }}>عربي RTL + إنجليزي، آمنة لأنظمة ATS، تختار وتغيّر أي وقت.</p>
          </Link>
          <Link href="/optimize" className="card card-hover p-6" style={{ display: "block" }}>
            <div style={{ fontSize: 30 }}>✍️</div><h3 style={{ fontSize: 19, fontWeight: 800, margin: "12px 0 6px" }}>خطاب تعريف + لينكدإن</h3>
            <p style={{ fontSize: 14.5, color: "var(--muted)" }}>من نفس بياناتك، بضغطة، مخصّص للوظيفة.</p>
          </Link>
          <Link href="/interview-live" className="card card-hover p-6" style={{ display: "block" }}>
            <div style={{ fontSize: 30 }}>🎤</div><h3 style={{ fontSize: 19, fontWeight: 800, margin: "12px 0 6px" }}>مقابلة فيديو بالـ AI</h3>
            <p style={{ fontSize: 14.5, color: "var(--muted)" }}>مُقابِل بصوت حقيقي يسألك على الكاميرا ويقيّمك — مباشر.</p>
          </Link>
        </div>
        <div className="lx-reveal lx-d3" style={{ marginTop: 30 }}>
          <div style={{ color: "var(--muted)", marginBottom: 12 }}>القوالب:</div>
          <div className="lx-tpls">
            {["#0f766e", "#b45309", "#1d4ed8", "#6d28d9", "#b91c1c", "#047857", "#334155"].map((c) => (
              <div key={c} className="lx-tpl" style={{ backgroundImage: `linear-gradient(${c} 0 30px, transparent 30px)` }} />
            ))}
          </div>
        </div>
      </section>

      {/* ACT 6 — FINALE: FULL CV */}
      <section className="lx-act">
        <div style={{ textAlign: "center" }}>
          <div className="chip lx-reveal" style={{ margin: "0 auto" }}>● وبالآخر…</div>
          <h2 className="lx-reveal lx-d1" style={{ marginTop: 14, fontSize: "clamp(30px,5vw,52px)", fontWeight: 900 }}>سيرتك <span className="text-accent">جاهزة</span> ✨</h2>
          <p className="lx-reveal lx-d2" style={{ margin: "14px auto 0", color: "var(--muted)", fontSize: 18, maxWidth: "58ch" }}>هذي اللي بنيناها سوا — نظيفة، صادقة، ومهيّأة للوظيفة. حمّلها PDF/Word، أرسلها لبريدك، أو درّب على المقابلة.</p>
        </div>
        <div className="lx-reveal lx-d2" style={{ maxWidth: 560, margin: "34px auto 0" }}><CV full /></div>
        <div className="lx-reveal lx-d3" style={{ textAlign: "center", marginTop: 44 }}>
          <div style={{ color: "var(--muted)", fontSize: 18 }}>ابدأها الآن مجاناً على</div>
          <div className="text-accent" style={{ fontSize: "clamp(40px,8vw,88px)", fontWeight: 900, letterSpacing: "-0.02em" }}>cv.rabit.sa</div>
          <Link href="/optimize" className="btn-accent" style={{ marginTop: 20, fontSize: 18, padding: "16px 40px", display: "inline-block" }}>افحص سيرتي مجاناً ←</Link>
          <div style={{ color: "var(--faint)", marginTop: 16, fontSize: 13 }}>فحص مجاني · بدون تسجيل · دفعة واحدة ٣٥ ريال (بدون اشتراك)</div>
        </div>
      </section>
    </div>
  );
}
