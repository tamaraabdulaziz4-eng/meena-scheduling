import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center px-6" style={{ background: "var(--bg)", color: "var(--fg)" }}>
      <div className="card w-full max-w-md p-10 text-center">
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full font-mono text-2xl font-bold"
          style={{ background: "rgba(74,222,128,0.12)", color: "var(--accent)", border: "1px solid rgba(74,222,128,0.3)" }}>
          404
        </div>
        <h1 className="text-2xl font-bold">Page not found</h1>
        <p className="mx-auto mt-2 max-w-sm text-sm" style={{ color: "var(--muted)" }}>
          The page you&apos;re looking for doesn&apos;t exist or may have moved.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link href="/" className="btn-accent px-6 py-3">Back home</Link>
          <Link href="/optimize" className="btn-ghost px-6 py-3 font-semibold" style={{ color: "var(--fg)" }}>Optimize a resume</Link>
        </div>
      </div>
    </main>
  );
}
