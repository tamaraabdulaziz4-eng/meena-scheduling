import { NextRequest, NextResponse } from "next/server";
import { allow, clientIp } from "@/app/lib/ratelimit";

export const maxDuration = 30;

/**
 * Natural Arabic text-to-speech. Tries providers in quality order and returns
 * an MP3/WAV so the same human-like voice plays on every device (replacing the
 * robotic browser speechSynthesis). All keys live only in env vars.
 *
 *   1. Gemini TTS   (GEMINI_TTS_KEY)  — most human-like, free tier via AI Studio
 *   2. ElevenLabs   (ELEVENLABS_KEY)  — reference-grade Arabic, small free tier
 *   3. Azure Speech (AZURE_SPEECH_KEY + AZURE_SPEECH_REGION) — solid fallback
 */

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// ── 1. Gemini TTS (generateContent, AUDIO modality → base64 PCM 24kHz) ──
async function geminiTts(text: string, female: boolean): Promise<Response | null> {
  const key = process.env.GEMINI_TTS_KEY;
  if (!key) return null;
  const model = process.env.GEMINI_TTS_MODEL || "gemini-2.5-flash-preview-tts";
  // Warm, natural male/female prebuilt voices; a short style instruction makes
  // it speak like a real interviewer rather than a narrator.
  const voice = female ? "Kore" : "Charon";
  // Language-neutral style cue — Gemini auto-detects and matches the text's
  // language (Arabic فصحى or English), so the same voice handles both.
  const prompt = `Speak in a warm, confident, natural human voice, like a real job interviewer talking to a candidate:\n${text}`;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
          },
        }),
      }
    );
    if (!res.ok) {
      console.error("Gemini TTS", res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const data = await res.json();
    const b64 = data?.candidates?.[0]?.content?.parts?.find((p: { inlineData?: unknown }) => p.inlineData)?.inlineData?.data;
    if (!b64) return null;
    // Gemini returns raw PCM (s16le, 24kHz, mono) — wrap it in a WAV header.
    const pcm = Buffer.from(b64, "base64");
    const wav = pcmToWav(pcm, 24000);
    return new NextResponse(new Uint8Array(wav), {
      headers: { "Content-Type": "audio/wav", "Cache-Control": "public, max-age=86400" },
    });
  } catch (e) {
    console.error("Gemini TTS error", e);
    return null;
  }
}

function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const numChannels = 1, bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// ── 2. ElevenLabs (multilingual v2 → MP3) ──
async function elevenTts(text: string, female: boolean): Promise<Response | null> {
  const key = process.env.ELEVENLABS_KEY;
  if (!key) return null;
  // Default multilingual voices; override per-gender via env if desired.
  const voiceId = female
    ? process.env.ELEVENLABS_VOICE_F || "EXAVITQu4vr4xnSDxMaL"
    : process.env.ELEVENLABS_VOICE_M || "onwK4e9ZLuTAKqWW03F9";
  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.15 },
      }),
    });
    if (!res.ok) {
      console.error("ElevenLabs", res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const audio = await res.arrayBuffer();
    return new NextResponse(audio, {
      headers: { "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=86400" },
    });
  } catch (e) {
    console.error("ElevenLabs error", e);
    return null;
  }
}

// ── 3. Azure Speech (neural → high-bitrate MP3) ──
const AZURE_VOICES: Record<string, string> = { hamed: "ar-SA-HamedNeural", zariyah: "ar-SA-ZariyahNeural" };
async function azureTts(text: string, female: boolean): Promise<Response | null> {
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;
  if (!key || !region) return null;
  const voice = female ? AZURE_VOICES.zariyah : AZURE_VOICES.hamed;
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
      console.error("Azure TTS", res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const audio = await res.arrayBuffer();
    return new NextResponse(audio, {
      headers: { "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=86400" },
    });
  } catch (e) {
    console.error("Azure TTS error", e);
    return null;
  }
}

export async function POST(req: NextRequest) {
  if (!allow(`tts:${clientIp(req)}`, 60, 10 * 60 * 1000)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: { text?: string; voice?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const text = String(body.text || "").slice(0, 800).trim();
  if (!text) return NextResponse.json({ error: "text required" }, { status: 400 });
  // Default voice is Kore (female) for both Arabic and English; pass a male
  // hint (hamed/charon/male) to switch.
  const v = String(body.voice || "").toLowerCase();
  const female = !(v.includes("hamed") || v.includes("charon") || v.includes("male"));

  // Quality order — first configured provider that returns audio wins.
  for (const provider of [geminiTts, elevenTts, azureTts]) {
    const out = await provider(text, female);
    if (out) return out;
  }
  return NextResponse.json({ error: "TTS not configured" }, { status: 501 });
}
