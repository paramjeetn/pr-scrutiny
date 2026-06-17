import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import type { LanguageModel } from 'ai'
import type { ReviewJob, AgentResult, AgentTrace, Finding } from '../../types/index.js'
import { runSummaryPass } from './summary.js'
import { runQuestionsPass } from './questions.js'
import { runAskPass } from './ask.js'

function buildModel(job: ReviewJob): LanguageModel {
  const { llm_provider, llm_model, llm_api_key } = job

  switch (llm_provider) {
    case 'anthropic': {
      const anthropic = createAnthropic({ apiKey: llm_api_key })
      return anthropic(llm_model)
    }
    case 'openai': {
      const openai = createOpenAI({ apiKey: llm_api_key })
      return openai(llm_model)
    }
    case 'google': {
      const google = createGoogleGenerativeAI({ apiKey: llm_api_key })
      return google(llm_model)
    }
    default:
      throw new Error(`Unknown LLM provider: ${llm_provider}`)
  }
}

export async function runLLMAgent(
  job: ReviewJob,
  _modelOverride?: LanguageModel  // for testing only
): Promise<AgentResult> {
  const started_at = new Date().toISOString()
  const startMs = Date.now()

  const findings: Finding[] = []
  let totalTokens = 0
  let timedOut = false
  let error: string | undefined

  try {
    const model = _modelOverride ?? buildModel(job)
    const { command } = job

    if (command === 'ask') {
      // /ask — conversational answer only
      const { finding, tokens } = await runAskPass(job, model)
      findings.push(finding)
      totalTokens += tokens
    } else if (command === 'summarize') {
      // /summarize — summary + questions
      const [summaryResult, questionsResult] = await Promise.all([
        runSummaryPass(job, model),
        runQuestionsPass(job, model),
      ])
      findings.push(summaryResult.finding)
      findings.push(...questionsResult.findings)
      totalTokens += summaryResult.tokens + questionsResult.tokens
    } else {
      // /review, /re-review — summary + questions as part of full review
      const [summaryResult, questionsResult] = await Promise.all([
        runSummaryPass(job, model),
        runQuestionsPass(job, model),
      ])
      findings.push(summaryResult.finding)
      findings.push(...questionsResult.findings)
      totalTokens += summaryResult.tokens + questionsResult.tokens
    }
  } catch (err) {
    timedOut = false
    error = err instanceof Error ? err.message : String(err)
    // Don't throw — return partial result so other agents' output still gets posted
  }

  const trace: AgentTrace = {
    agent: 'LLMAgent',
    started_at,
    duration_ms: Date.now() - startMs,
    finding_count: findings.length,
    timed_out: timedOut,
    ...(error ? { error } : {}),
  }

  return {
    agent: 'LLMAgent',
    findings,
    trace,
    metadata: { tokens_used: totalTokens },
  }
}
