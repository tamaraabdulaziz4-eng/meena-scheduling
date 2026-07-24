import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Next 16 renamed `middleware` -> `proxy` (runtime is nodejs, not edge).
//
// Two jobs:
// 1) Surface the request pathname to the root layout so it can serve
//    <html lang="ar" dir="rtl"> on Arabic (/ar) routes instead of "en".
// 2) ONE i18n system: locale lives in the PATH (/ar/*). Legacy ?lang=ar/en
//    parameters 308-redirect to the matching path — but only when a twin
//    actually exists, so English-only tools are never sent to a 404.
const AR_TWINS: RegExp[] = [
  /^\/$/,
  /^\/optimize$/,
  /^\/interview$/,
  /^\/account$/,
  /^\/build$/,
  /^\/builder$/,
  /^\/linkedin$/,
  /^\/login$/,
  /^\/pricing$/,
  /^\/templates$/,
  /^\/v1$/,
  /^\/score(\/|$)/,
  /^\/resume-examples(\/|$)/,
  /^\/cover-letter-examples(\/|$)/,
  /^\/resume-skills(\/|$)/,
];

export function proxy(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;
  const lang = searchParams.get("lang");

  if (lang) {
    if (pathname.startsWith("/ar")) {
      if (lang === "en") {
        const url = request.nextUrl.clone();
        url.pathname = pathname.replace(/^\/ar/, "") || "/";
        url.searchParams.delete("lang");
        return NextResponse.redirect(url, 308);
      }
    } else if (lang === "ar" && AR_TWINS.some((r) => r.test(pathname))) {
      const url = request.nextUrl.clone();
      url.pathname = `/ar${pathname === "/" ? "" : pathname}`;
      url.searchParams.delete("lang");
      return NextResponse.redirect(url, 308);
    }
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-pathname", pathname);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  // Skip assets + metadata routes; only page routes need the pathname header.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)"],
};
