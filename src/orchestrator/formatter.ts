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

// Human-readable agent labels
const AGENT_LABEL: Record<string, string> = {
  SecurityAgent:    'Security',
  QualityAgent:     'Quality',
  LLMAgent:         'AI',
  BlastRadiusAgent: 'Blast Radius',
}

function agentLabel(agent: string): string {
  return AGENT_LABEL[agent] ?? agent
}

function formatInlineBody(f: Finding): string {
  const agentTag = f.code ? `\`${f.code}\` · ` : ''  // code field reused as agent tag if set
  const lines = [`${SEVERITY_EMOJI[f.severity]} **${f.severity}** ${agentTag}${f.message}`]
  if (f.remediation) lines.push(`\n> 💡 ${f.remediation}`)
  return lines.join('\n')
}

function formatTrace(trace: JobTrace): string {
  const agentRows = trace.agents
    .map((a) => {
      const status = a.timed_out ? '⏱ timed out' : a.error ? `❌ ${a.error}` : '✓'
      return `| ${agentLabel(a.agent)} | ${a.duration_ms}ms | ${a.finding_count} | ${status} |`
    })
    .join('\n')

  const tokenLine = trace.llm_tokens_used !== undefined
    ? `\n_AI tokens used: ${trace.llm_tokens_used}_`
    : ''

  return `<details>
<summary>⚙️ Analysis details — ${trace.duration_ms}ms · ${trace.total_findings} finding(s)</summary>

| Agent | Duration | Findings | Status |
|---|---|---|---|
${agentRows}
${tokenLine}
</details>`
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function format(result: AggregatedResult): FormattedReview {
  const { findings, trace } = result

  // Separate LLM summary/questions from everything else
  const llmSummaryFinding = findings.find((f) => f.severity === 'PASS' && f.message.startsWith('**Summary:**'))
  const questions = findings.filter((f) => f.severity === 'QUESTION')
  const staticFindings = findings.filter(
    (f) => f !== llmSummaryFinding && f.severity !== 'QUESTION'
  )

  // Split static: inline (has file+line) vs top-level
  const inlineFindings = staticFindings.filter((f) => f.file && f.line !== undefined)
  const topFindings = staticFindings.filter((f) => !f.file || f.line === undefined)

  // Build inline comments
  const inline: InlineComment[] = inlineFindings.map((f) => ({
    path: f.file!,
    line: f.line!,
    body: formatInlineBody(f),
  }))

  const holdCount = findings.filter((f) => f.severity === 'HOLD').length
  const warnCount = findings.filter((f) => f.severity === 'WARN').length
  const statusLine = holdCount > 0
    ? `🚫 **${holdCount} blocking issue(s) found** — must resolve before merging`
    : warnCount > 0
      ? `⚠️ **${warnCount} warning(s)** — review recommended`
      : `✅ **No blocking issues found**`

  const sections: string[] = []

  // ── Header ──────────────────────────────────────────────────────────────
  sections.push(`## PR Scrutiny\n\n${statusLine}`)

  // ── AI Summary (top, prose block) ───────────────────────────────────────
  if (llmSummaryFinding) {
    // Strip the "**Summary:**" prefix and reformat as a named section
    const text = llmSummaryFinding.message
      .replace(/^\*\*Summary:\*\*\s*/, '')
      .replace(/\*\*Why:\*\*/, '**Why:**')
    sections.push(`### 🤖 AI Summary\n\n${text}`)
  }

  // ── Static findings by severity ──────────────────────────────────────────
  const holds    = topFindings.filter((f) => f.severity === 'HOLD')
  const warns    = topFindings.filter((f) => f.severity === 'WARN')
  const suggests = topFindings.filter((f) => f.severity === 'SUGGEST')
  const passes   = topFindings.filter((f) => f.severity === 'PASS' && f !== llmSummaryFinding)

  function renderGroup(severity: string, emoji: string, items: Finding[]) {
    if (items.length === 0) return
    const bullets = items.map((f) => {
      const loc = f.file ? ` \`${f.file}${f.line !== undefined ? `:${f.line}` : ''}\`` : ''
      const rem = f.remediation ? `\n  > 💡 ${f.remediation}` : ''
      return `- ${emoji} **${severity}**:${loc} ${f.message}${rem}`
    }).join('\n')
    sections.push(`### ${emoji} ${severity}\n\n${bullets}`)
  }

  renderGroup('HOLD', '🚫', holds)
  renderGroup('WARN', '⚠️', warns)
  renderGroup('SUGGEST', '💡', suggests)

  if (passes.length > 0) {
    const ps = passes.map((f) => `- ${f.message}`).join('\n')
    sections.push(`### ✅ Passed\n\n${ps}`)
  }

  // ── AI Questions ─────────────────────────────────────────────────────────
  if (questions.length > 0) {
    const qs = questions.map((f) => `- ${f.message}`).join('\n')
    sections.push(`### ❓ Questions for the author\n_Raised by AI — answer in PR description or reply here._\n\n${qs}`)
  }

  // ── Inline note ──────────────────────────────────────────────────────────
  if (inlineFindings.length > 0) {
    sections.push(`_${inlineFindings.length} inline comment(s) left on the diff above._`)
  }

  // ── Trace ────────────────────────────────────────────────────────────────
  sections.push(formatTrace(trace))

  return { inline, summary: sections.join('\n\n') }
}
