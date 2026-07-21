import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-screen" style={{ background: "#0a0a0f", color: "#f0f0f5" }}>
      {/* Nav */}
      <nav className="flex items-center justify-between px-6 py-5 max-w-6xl mx-auto">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white font-bold text-sm"
            style={{ background: "linear-gradient(135deg, #6366f1, #8b5cf6)" }}>R</div>
          <span className="font-bold text-lg text-white">ResumeAI</span>
        </div>
        <div className="flex items-center gap-6">
          <Link href="#pricing" className="text-sm hover:opacity-100 transition-opacity" style={{ opacity: 0.7 }}>Pricing</Link>
          <Link href="/optimize"
            className="text-white text-sm font-semibold px-5 py-2 rounded-lg"
            style={{ background: "linear-gradient(135deg, #6366f1, #8b5cf6)" }}>
            Try Free
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="text-center px-6 py-24 max-w-4xl mx-auto">
        <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium mb-8"
          style={{ background: "rgba(99,102,241,0.15)", border: "1px solid rgba(99,102,241,0.3)", color: "#a5b4fc" }}>
          ✨ AI-Powered • Get 3x More Interviews
        </div>
        <h1 className="text-5xl md:text-7xl font-extrabold text-white mb-6 leading-tight">
          Your Resume,{" "}
          <span style={{ background: "linear-gradient(135deg, #6366f1, #8b5cf6, #06b6d4)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
            Perfected by AI
          </span>
        </h1>
        <p className="text-xl mb-10 max-w-2xl mx-auto leading-relaxed" style={{ opacity: 0.6 }}>
          Paste your resume and the job description. Our AI rewrites, scores, and optimizes it to beat ATS filters and land more interviews — in under 60 seconds.
        </p>
        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <Link href="/optimize"
            className="text-white font-bold px-8 py-4 rounded-xl text-lg"
            style={{ background: "linear-gradient(135deg, #6366f1, #8b5cf6)" }}>
            Optimize My Resume →
          </Link>
          <a href="#how-it-works"
            className="text-white font-semibold px-8 py-4 rounded-xl text-lg hover:bg-white/5 transition-colors"
            style={{ border: "1px solid rgba(255,255,255,0.2)" }}>
            See How It Works
          </a>
        </div>
        <p className="mt-6 text-sm" style={{ opacity: 0.4 }}>No account needed • Results in 60 seconds • Used by 10,000+ job seekers</p>
      </section>

      {/* Stats */}
      <section className="py-12" style={{ borderTop: "1px solid rgba(255,255,255,0.08)", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
        <div className="max-w-5xl mx-auto px-6 grid grid-cols-2 md:grid-cols-4 gap-8 text-center">
          {[
            { num: "10,000+", label: "Resumes Optimized" },
            { num: "3x", label: "More Interview Calls" },
            { num: "94%", label: "ATS Pass Rate" },
            { num: "60s", label: "Average Turnaround" },
          ].map((s) => (
            <div key={s.label}>
              <div className="text-3xl font-extrabold" style={{ background: "linear-gradient(135deg, #6366f1, #8b5cf6)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>{s.num}</div>
              <div className="text-sm mt-1" style={{ opacity: 0.5 }}>{s.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section id="how-it-works" className="py-24 px-6 max-w-5xl mx-auto">
        <h2 className="text-4xl font-bold text-center text-white mb-4">How It Works</h2>
        <p className="text-center mb-16" style={{ opacity: 0.5 }}>Three steps. Sixty seconds. More interviews.</p>
        <div className="grid md:grid-cols-3 gap-8">
          {[
            { step: "01", title: "Paste Your Resume", desc: "Paste your current resume text. No formatting needed — just the raw content.", icon: "📄" },
            { step: "02", title: "Add the Job Description", desc: "Copy the job posting you're applying for. Our AI reads it and finds the exact keywords.", icon: "🎯" },
            { step: "03", title: "Get Your Optimized Resume", desc: "Receive a rewritten resume with ATS keywords, a match score, and missing skills.", icon: "🚀" },
          ].map((s) => (
            <div key={s.step} className="rounded-2xl p-8" style={{ background: "rgba(99,102,241,0.05)", border: "1px solid rgba(99,102,241,0.2)" }}>
              <div className="text-4xl mb-4">{s.icon}</div>
              <div className="text-xs font-bold tracking-widest mb-3" style={{ color: "#6366f1" }}>STEP {s.step}</div>
              <h3 className="text-xl font-bold text-white mb-3">{s.title}</h3>
              <p className="text-sm leading-relaxed" style={{ opacity: 0.5 }}>{s.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Features */}
      <section className="py-24 px-6" style={{ background: "rgba(99,102,241,0.04)" }}>
        <div className="max-w-5xl mx-auto">
          <h2 className="text-4xl font-bold text-center text-white mb-4">Everything You Need</h2>
          <p className="text-center mb-16" style={{ opacity: 0.5 }}>One tool that replaces hours of manual editing.</p>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[
              { icon: "🤖", title: "AI Rewrite", desc: "Full resume rewritten to match job requirements automatically." },
              { icon: "📊", title: "Match Score", desc: "See exactly how well your resume matches the job — 0 to 100." },
              { icon: "🔑", title: "Keyword Injection", desc: "Missing ATS keywords are added naturally throughout your resume." },
              { icon: "⚡", title: "60-Second Results", desc: "No waiting. Optimized resume delivered in under a minute." },
              { icon: "📝", title: "Bullet Point Boost", desc: "Weak bullets rewritten with quantified achievements and strong verbs." },
              { icon: "🎯", title: "Skills Gap Analysis", desc: "Know exactly which skills to add or highlight for the role." },
            ].map((f) => (
              <div key={f.title} className="rounded-xl p-6" style={{ background: "rgba(99,102,241,0.05)", border: "1px solid rgba(99,102,241,0.2)" }}>
                <div className="text-3xl mb-3">{f.icon}</div>
                <h3 className="font-bold text-white mb-2">{f.title}</h3>
                <p className="text-sm" style={{ opacity: 0.5 }}>{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Testimonials */}
      <section className="py-24 px-6 max-w-5xl mx-auto">
        <h2 className="text-4xl font-bold text-center text-white mb-16">Real Results</h2>
        <div className="grid md:grid-cols-3 gap-6">
          {[
            { quote: "I applied to 40 jobs with my old resume and got 2 callbacks. Used ResumeAI, applied to 15 and got 7 interviews. Insane difference.", name: "Sarah K.", role: "Software Engineer" },
            { quote: "Got rejected by ATS filters for months. After optimizing with this tool, I landed 3 offers in 3 weeks. Worth every penny.", name: "Marcus T.", role: "Product Manager" },
            { quote: "The match score feature alone is gold. I can see exactly why I wasn't getting callbacks and fix it instantly.", name: "Priya M.", role: "Data Analyst" },
          ].map((t) => (
            <div key={t.name} className="rounded-2xl p-8" style={{ background: "rgba(99,102,241,0.05)", border: "1px solid rgba(99,102,241,0.2)" }}>
              <div className="text-lg mb-4" style={{ color: "#fbbf24" }}>★★★★★</div>
              <p className="text-sm leading-relaxed mb-6" style={{ opacity: 0.7 }}>"{t.quote}"</p>
              <div>
                <div className="font-bold text-white text-sm">{t.name}</div>
                <div className="text-xs" style={{ opacity: 0.4 }}>{t.role}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="py-24 px-6" style={{ background: "rgba(99,102,241,0.04)" }}>
        <div className="max-w-4xl mx-auto text-center">
          <h2 className="text-4xl font-bold text-white mb-4">Simple Pricing</h2>
          <p className="mb-16" style={{ opacity: 0.5 }}>Less than a cup of coffee. Way more valuable.</p>
          <div className="grid md:grid-cols-2 gap-8 max-w-2xl mx-auto">
            <div className="rounded-2xl p-8" style={{ background: "rgba(99,102,241,0.05)", border: "1px solid rgba(99,102,241,0.2)" }}>
              <div className="text-sm font-bold tracking-widest mb-4" style={{ opacity: 0.5 }}>ONE-TIME</div>
              <div className="text-5xl font-extrabold text-white mb-2">$9</div>
              <div className="text-sm mb-8" style={{ opacity: 0.5 }}>per optimization</div>
              <ul className="text-sm space-y-3 mb-8 text-left">
                {["1 full resume optimization", "ATS match score", "Keyword analysis", "Bullet point rewrite", "Skills gap report"].map((f) => (
                  <li key={f} className="flex items-center gap-3" style={{ opacity: 0.7 }}>
                    <span style={{ color: "#6366f1" }}>✓</span> {f}
                  </li>
                ))}
              </ul>
              <a href={process.env.NEXT_PUBLIC_PAYLINK_SINGLE || "/optimize"}
                className="block w-full text-white font-bold py-3 rounded-xl text-center"
                style={{ background: "linear-gradient(135deg, #6366f1, #8b5cf6)" }}>
                Get Started →
              </a>
            </div>

            <div className="rounded-2xl p-8 relative overflow-hidden"
              style={{ background: "linear-gradient(135deg, rgba(99,102,241,0.2), rgba(139,92,246,0.2))", border: "1px solid rgba(99,102,241,0.5)" }}>
              <div className="absolute top-4 right-4 text-xs font-bold px-3 py-1 rounded-full"
                style={{ background: "#6366f1", color: "white" }}>BEST VALUE</div>
              <div className="text-sm font-bold tracking-widest mb-4" style={{ opacity: 0.5 }}>MONTHLY</div>
              <div className="text-5xl font-extrabold text-white mb-2">$19</div>
              <div className="text-sm mb-8" style={{ opacity: 0.5 }}>per month</div>
              <ul className="text-sm space-y-3 mb-8 text-left">
                {["Unlimited optimizations", "ATS match score", "Keyword analysis", "Bullet point rewrite", "Skills gap report", "Cover letter generator", "Priority support"].map((f) => (
                  <li key={f} className="flex items-center gap-3" style={{ opacity: 0.7 }}>
                    <span style={{ color: "#a5b4fc" }}>✓</span> {f}
                  </li>
                ))}
              </ul>
              <a href={process.env.NEXT_PUBLIC_PAYLINK_MONTHLY || "/optimize"}
                className="block w-full text-white font-bold py-3 rounded-xl text-center transition-all hover:opacity-90"
                style={{ background: "linear-gradient(135deg, #6366f1, #8b5cf6)" }}>
                Start Free Trial →
              </a>
            </div>
          </div>
          <p className="mt-8 text-sm" style={{ opacity: 0.3 }}>Secure payment • Instant access • Cancel anytime</p>
        </div>
      </section>

      {/* CTA */}
      <section className="py-24 px-6 text-center">
        <div className="max-w-2xl mx-auto">
          <h2 className="text-5xl font-extrabold text-white mb-6">
            Land Your Next Job{" "}
            <span style={{ background: "linear-gradient(135deg, #6366f1, #8b5cf6)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>Faster</span>
          </h2>
          <p className="mb-10 text-lg" style={{ opacity: 0.5 }}>
            Stop getting rejected by ATS filters. One optimization could change everything.
          </p>
          <Link href="/optimize"
            className="text-white font-bold px-10 py-5 rounded-xl text-xl inline-block"
            style={{ background: "linear-gradient(135deg, #6366f1, #8b5cf6)" }}>
            Optimize My Resume for Free →
          </Link>
          <p className="mt-4 text-sm" style={{ opacity: 0.3 }}>No credit card required for free preview</p>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-8 px-6" style={{ borderTop: "1px solid rgba(255,255,255,0.08)" }}>
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded flex items-center justify-center text-white font-bold text-xs"
              style={{ background: "linear-gradient(135deg, #6366f1, #8b5cf6)" }}>R</div>
            <span className="font-bold text-sm text-white">ResumeAI</span>
          </div>
          <p className="text-xs" style={{ opacity: 0.3 }}>© 2026 ResumeAI. All rights reserved.</p>
        </div>
      </footer>
    </main>
  );
}
