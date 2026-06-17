import { generateText } from 'ai'
import type { LanguageModel } from 'ai'
import type { ReviewJob, Finding } from '../../types/index.js'

function buildAskPrompt(job: ReviewJob, question: string): string {
  const patches = job.diff
    .slice(0, 8)
    .map((d) => `### ${d.path}\n\`\`\`\n${d.patch.slice(0, 600)}\n\`\`\``)
    .join('\n\n')

  const existingContext = job.existing_comments?.length
    ? `\n## Existing review comments\n${job.existing_comments.slice(0, 5).join('\n---\n')}\n`
    : ''

  return `You are a senior engineer who has read this pull request in full. Answer the question concisely and accurately based only on the diff and context provided.

## PR: ${job.pr.title}
Repository: ${job.pr.repo}
${existingContext}
## Diff (truncated)
${patches}

## Question from reviewer
${question}

## Instructions
Answer in 2-5 sentences. Be direct. If the answer is not determinable from the diff, say so. No hedging, no bullet lists unless the answer is inherently list-like.`
}

export async function runAskPass(
  job: ReviewJob,
  model: LanguageModel
): Promise<{ finding: Finding; tokens: number }> {
  const question = job.question ?? 'Summarize this PR.'
  const prompt = buildAskPrompt(job, question)

  const { text, usage } = await generateText({ model, prompt, maxOutputTokens: 600 })

  const finding: Finding = {
    severity: 'PASS',
    message: `**Q:** ${question}\n\n**A:** ${text.trim()}`,
  }

  return { finding, tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) }
}
