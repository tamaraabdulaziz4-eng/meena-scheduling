import { NextRequest, NextResponse } from "next/server";

/**
 * Provider-agnostic optimizer.
 * Defaults to NVIDIA's free OpenAI-compatible endpoint; set AI_PROVIDER=anthropic
 * to switch to Claude without touching this file's logic.
 *
 *   AI_PROVIDER   "nvidia" (default) | "anthropic"
 *   AI_MODEL      override the model (defaults per provider)
 *   NVIDIA_API_KEY / ANTHROPIC_API_KEY   the credential for the chosen provider
 */

const PROVIDER = (process.env.AI_PROVIDER || "nvidia").toLowerCase();

const PROMPT = (resume: string, jobDescription: string) =>
  `You are an expert ATS resume optimizer and career coach. Analyze the resume and job description below, then provide a complete optimization.

RESUME:
${resume}

JOB DESCRIPTION:
${jobDescription}

Return a JSON object with exactly this structure:
{
  "matchScore": <number 0-100>,
  "matchSummary": "<2-sentence summary of how well the resume matches>",
  "missingKeywords": ["keyword1", "keyword2"],
  "presentKeywords": ["keyword1", "keyword2"],
  "skillsGap": ["skill1", "skill2"],
  "improvements": [
    {"area": "area name", "issue": "what's wrong", "fix": "how to fix it"}
  ],
  "optimizedResume": "<complete rewritten resume with all improvements applied, ATS keywords injected naturally, bullets strengthened with metrics and strong verbs>"
}

Requirements for optimizedResume:
- Keep the candidate's real experience and facts — never invent
- Inject relevant keywords from the job description naturally
- Rewrite bullet points to start with strong action verbs and include metrics where plausible
- Ensure every section is ATS-friendly (clear headings, no tables/graphics)
- Make it professional and compelling

Return only the JSON, no other text.`;

/** Robustly pull the first complete JSON object out of a model response. */
function extractJson(text: string): string {
  const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    return cleaned.slice(start, end + 1);
  }
  return cleaned;
}

async function callNvidia(resume: string, jobDescription: string): Promise<string> {
  const key = process.env.NVIDIA_API_KEY;
  if (!key) throw new Error("NVIDIA_API_KEY is not set");
  const model = process.env.AI_MODEL || "meta/llama-3.3-70b-instruct";

  const res = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.4,
      top_p: 0.9,
      max_tokens: 4096,
      messages: [
        { role: "system", content: "You are an expert ATS resume optimizer. You always respond with a single valid JSON object and nothing else." },
        { role: "user", content: PROMPT(resume, jobDescription) },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`NVIDIA API ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? "";
}

async function callAnthropic(resume: string, jobDescription: string): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
  const model = process.env.AI_MODEL || "claude-sonnet-5";

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [{ role: "user", content: PROMPT(resume, jobDescription) }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return data?.content?.[0]?.text ?? "";
}

export async function POST(req: NextRequest) {
  try {
    const { resume, jobDescription } = await req.json();

    if (!resume || !jobDescription) {
      return NextResponse.json({ error: "Resume and job description are required." }, { status: 400 });
    }
    if (resume.length > 8000 || jobDescription.length > 4000) {
      return NextResponse.json({ error: "Input too long. Please trim your resume or job description." }, { status: 400 });
    }

    const raw =
      PROVIDER === "anthropic"
        ? await callAnthropic(resume, jobDescription)
        : await callNvidia(resume, jobDescription);

    if (!raw.trim()) throw new Error("Empty response from AI provider");

    const result = JSON.parse(extractJson(raw));
    return NextResponse.json(result);
  } catch (err) {
    console.error("Optimize error:", err);
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: "Failed to optimize resume. Please try again.", detail: msg },
      { status: 500 }
    );
  }
}
