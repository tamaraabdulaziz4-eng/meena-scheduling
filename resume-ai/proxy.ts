import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Next 16 renamed `middleware` -> `proxy` (runtime is nodejs, not edge).
// We only need it to surface the request pathname to the root layout so it can
// serve <html lang="ar" dir="rtl"> on Arabic (/ar) routes instead of "en".
export function proxy(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-pathname", request.nextUrl.pathname);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  // Skip assets + metadata routes; only page routes need the pathname header.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)"],
};
