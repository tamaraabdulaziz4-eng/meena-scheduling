import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 300;

/**
 * Shared endpoint for the smaller AI tools:
 *  - mode "linkedin":  resume/profile text + target role -> optimized headline, about, skills
 *  - mode "interview": resume + job description -> likely questions with strong answers
 * Outputs are small, so these run non-streaming and fit well inside the time cap.
 */

const PROMPTS: Record<string, (a: string, b: string) => string> = {
  linkedin: (profile, targetRole) => `You are a LinkedIn optimization expert. Rewrite this person's LinkedIn presence for the target role.

CURRENT PROFILE / RESUME TEXT:
${profile}

TARGET ROLE: ${targetRole}

Return ONLY a JSON object:
{
  "headline": "<a 120-220 char keyword-rich LinkedIn headline: role | value proposition | key skills>",
  "about": "<a first-person About section, 3 short paragraphs: hook, proof with achievements from their background, call to action. Recruiter-search keywords woven in naturally.>",
  "skills": ["<the 10-15 skills they should list, ordered by relevance to the target role — only skills their background supports>"],
  "tips": ["<3-4 specific profile tips, e.g. banner, featured section, activity>"]
}
Never invent employers or achievements. No text outside the JSON.`,

  interview: (resume, jobDescription) => `You are an interview coach. Based on this resume and job description, prepare the candidate.

RESUME:
${resume}

JOB DESCRIPTION:
${jobDescription}

Return ONLY a JSON object:
{
  "questions": [
    {"q": "<likely interview question>", "why": "<why they'll ask it, one line>", "answer": "<a strong 3-5 sentence answer using THIS candidate's real background (STAR style where relevant). Where they lack the skill, give an honest bridging answer.>"}
  ],
  "redFlags": ["<2-3 weaknesses in their profile the interviewer may probe, with one-line advice each>"]
}
Provide 8 questions: 2 intro/behavioral, 4 role-specific technical/skills, 2 about gaps in their background. No text outside the JSON.`,
};

function extractJson(text: string): string {
  const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  return start !== -1 && end > start ? cleaned.slice(start, end + 1) : cleaned;
}

function repairJson(s: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  for (const ch of s) {
    if (inStr) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === "\\") { out += ch; esc = true; continue; }
      if (ch === '"') { inStr = false; out += ch; continue; }
      if (ch === "\n") { out += "\\n"; continue; }
      if (ch === "\r") continue;
      if (ch === "\t") { out += "\\t"; continue; }
      out += ch;
    } else {
      if (ch === '"') inStr = true;
      out += ch;
    }
  }
  return out;
}

export async function POST(req: NextRequest) {
  try {
    const { mode, inputA, inputB } = await req.json();
    const promptFn = PROMPTS[mode];
    if (!promptFn) return NextResponse.json({ error: "Unknown tool." }, { status: 400 });
    if (!inputA?.trim() || inputA.length < 50) {
      return NextResponse.json({ error: "Please provide more detail (paste your resume or profile)." }, { status: 400 });
    }
    if (!inputB?.trim() || inputB.length < 3) {
      return NextResponse.json({ error: mode === "linkedin" ? "Please enter your target role." : "Please paste the job description." }, { status: 400 });
    }
    if (inputA.length > 8000 || inputB.length > 4000) {
      return NextResponse.json({ error: "Input too long." }, { status: 400 });
    }

    const key = process.env.NVIDIA_API_KEY;
    if (!key) throw new Error("NVIDIA_API_KEY is not set");
    const model = process.env.AI_MODEL || "nvidia/llama-3.3-nemotron-super-49b-v1";

    const res = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0.5,
        top_p: 0.9,
        max_tokens: 2200,
        messages: [
          { role: "system", content: "You respond with a single valid JSON object and nothing else. Never include unescaped quotes inside JSON string values." },
          { role: "user", content: promptFn(String(inputA).slice(0, 8000), String(inputB).slice(0, 4000)) },
        ],
      }),
    });
    if (!res.ok) throw new Error(`NVIDIA API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content ?? "";
    if (!raw.trim()) throw new Error("Empty response");

    let parsed;
    try {
      parsed = JSON.parse(extractJson(raw));
    } catch {
      parsed = JSON.parse(repairJson(extractJson(raw)));
    }
    return NextResponse.json(parsed);
  } catch (err) {
    console.error("Tools error:", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
