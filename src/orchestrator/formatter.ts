import type { Finding, JobTrace, Severity } from '../types/index.js'
import type { AggregatedResult } from './aggregator.js'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface InlineComment {
  path: string
  line: number
  body: string
}

export interface FormattedReview {
  inline: InlineComment[]
  summary: string  // top-level markdown comment
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const SEVERITY_EMOJI: Record<Severity, string> = {
  HOLD:     '🚫',
  WARN:     '⚠️',
  SUGGEST:  '💡',
  PASS:     '✅',
  QUESTION: '❓',
}

const SEVERITY_LABEL: Record<Severity, string> = {
  HOLD:     'HOLD',
  WARN:     'WARN',
  SUGGEST:  'SUGGEST',
  PASS:     'PASS',
  QUESTION: 'QUESTION',
}

function formatInlineBody(f: Finding): string {
  const header = `${SEVERITY_EMOJI[f.severity]} **${SEVERITY_LABEL[f.severity]}**`
  const lines = [`${header}: ${f.message}`]
  if (f.remediation) lines.push(`> ${f.remediation}`)
  return lines.join('\n')
}

function formatTrace(trace: JobTrace): string {
  const agentRows = trace.agents
    .map((a) => {
      const status = a.timed_out ? '⏱ timed out' : a.error ? `❌ ${a.error}` : '✓'
      return `| ${a.agent} | ${a.duration_ms}ms | ${a.finding_count} | ${status} |`
    })
    .join('\n')

  const tokenLine = trace.llm_tokens_used !== undefined
    ? `\nLLM tokens used: **${trace.llm_tokens_used}**`
    : ''

  return `<details>
<summary>Agent trace — ${trace.duration_ms}ms total, ${trace.total_findings} findings</summary>

| Agent | Duration | Findings | Status |
|---|---|---|---|
${agentRows}
${tokenLine}
</details>`
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function format(result: AggregatedResult): FormattedReview {
  const { findings, trace } = result

  // Split: inline (file+line) vs top-level
  const inlineFindings = findings.filter((f) => f.file && f.line !== undefined)
  const topFindings = findings.filter((f) => !f.file || f.line === undefined)

  // Build inline comments
  const inline: InlineComment[] = inlineFindings.map((f) => ({
    path: f.file!,
    line: f.line!,
    body: formatInlineBody(f),
  }))

  // Group top-level findings by severity
  const holds    = topFindings.filter((f) => f.severity === 'HOLD')
  const warns    = topFindings.filter((f) => f.severity === 'WARN')
  const suggests = topFindings.filter((f) => f.severity === 'SUGGEST')
  const passes   = topFindings.filter((f) => f.severity === 'PASS')
  const questions = topFindings.filter((f) => f.severity === 'QUESTION')

  const sections: string[] = []

  // Header
  const holdCount = findings.filter((f) => f.severity === 'HOLD').length
  const warnCount = findings.filter((f) => f.severity === 'WARN').length
  const statusLine = holdCount > 0
    ? `🚫 **${holdCount} blocking issue(s)** — review required before merge`
    : warnCount > 0
      ? `⚠️ **${warnCount} warning(s)** — review recommended`
      : `✅ **No blocking issues found**`

  sections.push(`## PR Scrutiny Review\n\n${statusLine}`)

  function renderGroup(label: string, emoji: string, items: Finding[]) {
    if (items.length === 0) return
    const bullets = items.map((f) => {
      const loc = f.file ? ` \`${f.file}${f.line !== undefined ? `:${f.line}` : ''}\`` : ''
      const rem = f.remediation ? `\n  > ${f.remediation}` : ''
      return `- ${emoji} **${label}**:${loc} ${f.message}${rem}`
    }).join('\n')
    sections.push(`### ${emoji} ${label}\n\n${bullets}`)
  }

  renderGroup('HOLD', '🚫', holds)
  renderGroup('WARN', '⚠️', warns)
  renderGroup('SUGGEST', '💡', suggests)

  if (questions.length > 0) {
    const qs = questions.map((f) => `- ${f.message}`).join('\n')
    sections.push(`### ❓ Questions for the author\n\n${qs}`)
  }

  if (passes.length > 0) {
    const ps = passes.map((f) => `- ${f.message}`).join('\n')
    sections.push(`### ✅ Passed\n\n${ps}`)
  }

  if (inlineFindings.length > 0) {
    sections.push(`*${inlineFindings.length} inline comment(s) posted on the diff.*`)
  }

  sections.push(formatTrace(trace))

  return { inline, summary: sections.join('\n\n') }
}
