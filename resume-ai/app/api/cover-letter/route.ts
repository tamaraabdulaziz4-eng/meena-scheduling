import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

const PROVIDER = (process.env.AI_PROVIDER || "nvidia").toLowerCase();

const PROMPT = (resume: string, jobDescription: string) =>
  `Write a concise, compelling cover letter for the candidate below, tailored to the job description.

RESUME:
${resume}

JOB DESCRIPTION:
${jobDescription}

Rules:
- 3–4 short paragraphs, under 300 words
- Open with genuine enthusiasm for the specific role
- Highlight 2–3 concrete achievements from the resume that match the job's needs
- Mirror the job's language/keywords naturally
- Close with a confident call to action
- Never invent facts not supported by the resume
- Use a professional, human tone — no clichés like "I am writing to apply"

Return ONLY the cover letter text, no preamble, no JSON.`;

async function callNvidia(resume: string, jobDescription: string): Promise<string> {
  const key = process.env.NVIDIA_API_KEY;
  if (!key) throw new Error("NVIDIA_API_KEY is not set");
  const model = process.env.AI_MODEL || "meta/llama-3.1-8b-instruct";

  const res = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0.6,
      top_p: 0.9,
      max_tokens: 900,
      messages: [
        { role: "system", content: "You are an expert career writer who produces tailored, human-sounding cover letters." },
        { role: "user", content: PROMPT(resume, jobDescription) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`NVIDIA API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? "";
}

async function callAnthropic(resume: string, jobDescription: string): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
  const model = process.env.AI_MODEL || "claude-sonnet-5";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 900, messages: [{ role: "user", content: PROMPT(resume, jobDescription) }] }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data?.content?.[0]?.text ?? "";
}

export async function POST(req: NextRequest) {
  try {
    const { resume, jobDescription } = await req.json();
    if (!resume || !jobDescription) {
      return NextResponse.json({ error: "Resume and job description are required." }, { status: 400 });
    }
    if (resume.trim().length < 50 || jobDescription.trim().length < 30) {
      return NextResponse.json({ error: "Please provide a fuller resume and job description." }, { status: 400 });
    }

    const coverLetter =
      PROVIDER === "anthropic"
        ? await callAnthropic(resume, jobDescription)
        : await callNvidia(resume, jobDescription);

    if (!coverLetter.trim()) throw new Error("Empty response");
    return NextResponse.json({ coverLetter: coverLetter.trim() });
  } catch (err) {
    console.error("Cover letter error:", err);
    return NextResponse.json({ error: "Failed to generate cover letter. Please try again." }, { status: 500 });
  }
}
