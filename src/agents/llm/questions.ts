import { generateText } from 'ai'
import type { LanguageModel } from 'ai'
import type { ReviewJob, Finding } from '../../types/index.js'

function buildQuestionsPrompt(job: ReviewJob): string {
  const files = job.diff.map((d) => d.path).join(', ')

  const patches = job.diff
    .slice(0, 6)
    .map((d) => `### ${d.path}\n\`\`\`\n${d.patch.slice(0, 600)}\n\`\`\``)
    .join('\n\n')

  return `You are a senior engineer reviewing a pull request. Identify the most important unanswered questions about this change.

## PR: ${job.pr.title}
Files changed: ${files}

## Diff (truncated)
${patches}

## Instructions
Return a JSON array of 2-4 clarifying questions the reviewer should ask the author.
Each question must be specific to this diff — no generic questions.

Format: ["question 1", "question 2", ...]

No markdown, no code fences — raw JSON array only.`
}

export async function runQuestionsPass(
  job: ReviewJob,
  model: LanguageModel
): Promise<{ findings: Finding[]; tokens: number }> {
  const prompt = buildQuestionsPrompt(job)

  const { text, usage } = await generateText({ model, prompt, maxTokens: 400 })

  let questions: string[] = []
  try {
    questions = JSON.parse(text.trim()) as string[]
    if (!Array.isArray(questions)) questions = []
  } catch {
    // fallback: extract anything that looks like a question
    questions = text
      .split('\n')
      .map((l) => l.replace(/^[\d.\-*]+\s*/, '').trim())
      .filter((l) => l.length > 10 && l.includes('?'))
      .slice(0, 4)
  }

  const findings: Finding[] = questions.map((q) => ({
    severity: 'QUESTION' as const,
    message: q,
  }))

  return { findings, tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) }
}
