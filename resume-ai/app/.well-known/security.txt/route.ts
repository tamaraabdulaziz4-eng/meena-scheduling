// RFC 9116 security.txt — a contact channel for security researchers.
export const dynamic = "force-static";

export function GET() {
  const body = [
    "Contact: mailto:alanziabdulaziz4@gmail.com",
    "Preferred-Languages: ar, en",
    "Canonical: https://cv.rabit.sa/.well-known/security.txt",
    "Expires: 2027-01-01T00:00:00.000Z",
  ].join("\n") + "\n";
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
