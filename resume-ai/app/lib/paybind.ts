import crypto from "crypto";

// Binds a checkout to the browser that started it. /api/pay sets a signed
// cookie with the transactionNo; /api/pay/verify only auto-signs-in and writes
// the account entitlement when that cookie matches — so a leaked or guessed
// transactionNo can't be replayed to sign in as the buyer.

const SECRET = process.env.ACCESS_SECRET || "dev-insecure-secret-change-me";
export const PAY_BIND_COOKIE = "ra_pay";

export function signTx(tx: string): string {
  return crypto.createHmac("sha256", SECRET).update("pay:" + tx).digest("base64url");
}
