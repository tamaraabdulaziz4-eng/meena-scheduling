import Link from "next/link";
import AiOrb from "./components/AiOrb";
import AuroraBlobs from "./components/orb/AuroraBlobs";

export default function NotFound() {
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden px-6" style={{ background: "var(--cosmos-bg)", color: "var(--cosmos-text)" }}>
      <AuroraBlobs />
      <div className="relative w-full max-w-md rounded-3xl p-10 text-center" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.1)", backdropFilter: "blur(10px)" }}>
        {/* a lost orb drifting through space */}
        <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center">
          <AiOrb size={72} state="lost" />
        </div>
        <div className="mb-2 font-mono text-sm tracking-[0.3em]" style={{ color: "var(--cosmos-muted)" }}>404</div>
        <h1 className="text-2xl font-bold">Lost in space</h1>
        <p className="mx-auto mt-2 max-w-sm text-sm" style={{ color: "var(--cosmos-muted)" }}>
          The page you&apos;re looking for drifted off — it doesn&apos;t exist or may have moved.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link href="/" className="btn-accent px-6 py-3">Back home</Link>
          <Link href="/optimize" className="rounded-xl px-6 py-3 font-semibold" style={{ border: "1px solid rgba(255,255,255,0.18)", color: "var(--cosmos-text)" }}>Scan a resume</Link>
        </div>
      </div>
    </main>
  );
}
