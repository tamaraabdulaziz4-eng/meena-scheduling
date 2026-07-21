import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST(req: NextRequest) {
  try {
    const { resume, jobDescription } = await req.json();

    if (!resume || !jobDescription) {
      return NextResponse.json({ error: "Resume and job description are required." }, { status: 400 });
    }

    if (resume.length > 8000 || jobDescription.length > 4000) {
      return NextResponse.json({ error: "Input too long. Please trim your resume or job description." }, { status: 400 });
    }

    const message = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: `You are an expert ATS resume optimizer and career coach. Analyze the resume and job description below, then provide a complete optimization.

RESUME:
${resume}

JOB DESCRIPTION:
${jobDescription}

Return a JSON object with exactly this structure:
{
  "matchScore": <number 0-100>,
  "matchSummary": "<2-sentence summary of how well the resume matches>",
  "missingKeywords": ["keyword1", "keyword2", ...],
  "presentKeywords": ["keyword1", "keyword2", ...],
  "skillsGap": ["skill1", "skill2", ...],
  "improvements": [
    {"area": "area name", "issue": "what's wrong", "fix": "how to fix it"},
    ...
  ],
  "optimizedResume": "<complete rewritten resume with all improvements applied, ATS keywords injected naturally, bullets strengthened with metrics and strong verbs>"
}

Requirements for optimizedResume:
- Keep the candidate's real experience and facts — never invent
- Inject relevant keywords from the job description naturally
- Rewrite bullet points to start with strong action verbs and include metrics where plausible
- Ensure every section is ATS-friendly (clear headings, no tables/graphics)
- Make it professional and compelling

Return only the JSON, no other text.`
        }
      ]
    });

    const content = message.content[0];
    if (content.type !== "text") {
      throw new Error("Unexpected response type");
    }

    const jsonText = content.text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const result = JSON.parse(jsonText);

    return NextResponse.json(result);
  } catch (err) {
    console.error("Optimize error:", err);
    return NextResponse.json({ error: "Failed to optimize resume. Please try again." }, { status: 500 });
  }
}
