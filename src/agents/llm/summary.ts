import { generateText } from 'ai'
import type { LanguageModel } from 'ai'
import type { ReviewJob, Finding } from '../../types/index.js'

// Build a concise prompt for PR summarization
function buildSummaryPrompt(job: ReviewJob): string {
  const files = job.diff.map((d) => `  ${d.path} (+${d.additions}/-${d.deletions})`).join('\n')

  const patches = job.diff
    .slice(0, 8)  // cap to avoid token blow-out
    .map((d) => `### ${d.path}\n\`\`\`\n${d.patch.slice(0, 800)}\n\`\`\``)
    .join('\n\n')

  return `You are a senior engineer reviewing a pull request. Write a concise, factual summary.

## PR: ${job.pr.title}
Repository: ${job.pr.repo}
Base branch: ${job.pr.base_branch}

## Description
${job.pr.description || '(no description provided)'}

## Changed files
${files}

## Diff (truncated)
${patches}

## Instructions
Respond with a JSON object matching this exact shape:
{
  "what": "1-2 sentence plain-English description of WHAT this PR does",
  "why": "1 sentence on WHY based on description/commit messages (or 'Not stated' if unclear)",
  "risk": "low | medium | high",
  "risk_reason": "1 sentence explaining the risk rating"
}

No markdown, no code fences — raw JSON only.`
}

export interface SummaryOutput {
  what: string
  why: string
  risk: 'low' | 'medium' | 'high'
  risk_reason: string
}

export async function runSummaryPass(
  job: ReviewJob,
  model: LanguageModel
): Promise<{ finding: Finding; tokens: number; summary: SummaryOutput }> {
  const prompt = buildSummaryPrompt(job)

  const { text, usage } = await generateText({ model, prompt, maxOutputTokens: 512 })

  // Parse JSON — graceful fallback on malformed output
  let summary: SummaryOutput
  try {
    summary = JSON.parse(text.trim()) as SummaryOutput
  } catch {
    summary = {
      what: text.slice(0, 300),
      why: 'Could not parse structured summary.',
      risk: 'medium',
      risk_reason: 'Parse error — defaulting to medium risk.',
    }
  }

  const severityMap = { low: 'PASS', medium: 'SUGGEST', high: 'WARN' } as const
  const severity = severityMap[summary.risk] ?? 'SUGGEST'

  const finding: Finding = {
    severity,
    message: `**Summary:** ${summary.what} **Why:** ${summary.why}`,
    remediation: summary.risk_reason,
  }

  return { finding, tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0), summary }
}
