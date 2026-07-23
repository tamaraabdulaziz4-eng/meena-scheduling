import { NextRequest, NextResponse } from "next/server";
import { allow, clientIp } from "@/app/lib/ratelimit";

export const maxDuration = 30;

/**
 * Natural Arabic text-to-speech via Azure Speech (neural voices) — returns an
 * MP3 so the same real, human-like voice plays on every device, replacing the
 * robotic browser speechSynthesis. Key/region live only in env vars.
 */

const VOICES: Record<string, string> = {
  hamed: "ar-SA-HamedNeural",   // male (default interviewer)
  zariyah: "ar-SA-ZariyahNeural", // female
};

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export async function POST(req: NextRequest) {
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;
  if (!key || !region) return NextResponse.json({ error: "TTS not configured" }, { status: 501 });

  if (!allow(`tts:${clientIp(req)}`, 60, 10 * 60 * 1000)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: { text?: string; voice?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const text = String(body.text || "").slice(0, 800).trim();
  if (!text) return NextResponse.json({ error: "text required" }, { status: 400 });
  const voice = VOICES[String(body.voice || "hamed")] || VOICES.hamed;

  // `chat` style + gentle prosody make the neural voice sound conversational
  // rather than a news reader; unsupported styles are ignored by Azure.
  const ssml = `<speak version="1.0" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="ar-SA"><voice name="${voice}"><mstts:express-as style="chat"><prosody rate="-2%" pitch="-2%">${escapeXml(text)}</prosody></mstts:express-as></voice></speak>`;

  try {
    const res = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "audio-48khz-192kbitrate-mono-mp3",
        "User-Agent": "resumeai",
      },
      body: ssml,
    });
    if (!res.ok) {
      const t = await res.text();
      console.error("Azure TTS", res.status, t.slice(0, 200));
      return NextResponse.json({ error: "TTS failed" }, { status: 502 });
    }
    const audio = await res.arrayBuffer();
    return new NextResponse(audio, {
      headers: { "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=86400" },
    });
  } catch (e) {
    console.error("TTS error", e);
    return NextResponse.json({ error: "TTS error" }, { status: 500 });
  }
}
