/**
 * Thin Resend wrapper shared by sign-in, payment receipts, and "email my
 * results". Returns false (never throws) when email isn't configured so callers
 * can treat email as best-effort and never break the main flow.
 */
export async function sendEmail(opts: { to: string; subject: string; html: string }): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!key || !from) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [opts.to], subject: opts.subject, html: opts.html }),
    });
    if (!res.ok) {
      console.error("sendEmail Resend", res.status, (await res.text()).slice(0, 200));
      return false;
    }
    return true;
  } catch (e) {
    console.error("sendEmail error", e);
    return false;
  }
}

/** Branded wrapper so every email looks consistent. */
export function emailShell(bodyHtml: string): string {
  return `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:520px;margin:auto;color:#111">
    <div style="font-size:20px;font-weight:800;color:#7c3aed;margin-bottom:16px">Sira · cv.rabit.sa</div>
    ${bodyHtml}
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0" />
    <p style="color:#999;font-size:12px">Sira — honest AI resume optimization. No subscription.</p>
  </div>`;
}
