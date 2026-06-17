import type { ReviewJob, Finding } from '../../types/index.js'

// Branching keywords that add to cyclomatic complexity
const BRANCH_PATTERN = /\b(if|else\s+if|else|switch|case|for|while|do|catch|&&|\|\||\?[^:])\b/g

// Detect start of a function block
const FUNCTION_START = /(?:function\s+\w+|(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?(?:function|\([^)]*\)\s*=>|\w+\s*=>)|(?:async\s+)?(?:\w+\s*\([^)]*\))\s*\{)/

// ─── Extract function blocks from source ───────────────────────────────────────

interface FunctionBlock {
  name: string
  startLine: number
  lines: string[]
}

function extractFunctionBlocks(content: string): FunctionBlock[] {
  const lines = content.split('\n')
  const blocks: FunctionBlock[] = []

  let depth = 0
  let inBlock = false
  let blockStart = 0
  let blockName = 'anonymous'
  let blockLines: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!

    if (!inBlock && FUNCTION_START.test(line)) {
      // Extract function name
      const nameMatch =
        line.match(/function\s+(\w+)/) ??
        line.match(/(?:const|let|var)\s+(\w+)\s*=/) ??
        line.match(/^\s*(?:async\s+)?(\w+)\s*\(/)
      blockName = nameMatch?.[1] ?? 'anonymous'
      blockStart = i + 1
      inBlock = true
      blockLines = []
      depth = 0
    }

    if (inBlock) {
      blockLines.push(line)
      for (const ch of line) {
        if (ch === '{') depth++
        if (ch === '}') depth--
      }
      // Block ends when we return to depth 0 after having entered it
      if (depth <= 0 && blockLines.length > 1) {
        blocks.push({ name: blockName, startLine: blockStart, lines: blockLines })
        inBlock = false
        blockLines = []
      }
    }
  }

  return blocks
}

// ─── Score a block ─────────────────────────────────────────────────────────────

function scoreBlock(lines: string[]): number {
  let score = 1 // base complexity
  const text = lines.join('\n')
  const matches = text.match(BRANCH_PATTERN)
  score += matches?.length ?? 0
  return score
}

// ─── Public API ────────────────────────────────────────────────────────────────

export function scanComplexity(job: ReviewJob): Finding[] {
  const findings: Finding[] = []

  // Only look at files that appear in the diff (changed files)
  const changedPaths = new Set(job.diff.map((d) => d.path))

  for (const file of job.changed_files) {
    if (!changedPaths.has(file.path)) continue

    const blocks = extractFunctionBlocks(file.content)

    for (const block of blocks) {
      const score = scoreBlock(block.lines)

      if (score > 20) {
        findings.push({
          severity: 'WARN',
          file: file.path,
          line: block.startLine,
          message: `High complexity in \`${block.name}\` (score: ${score}). Consider decomposing into smaller functions.`,
          remediation: 'Break this function into smaller, single-purpose functions. Aim for cyclomatic complexity ≤ 10.',
        })
      } else if (score > 10) {
        findings.push({
          severity: 'SUGGEST',
          file: file.path,
          line: block.startLine,
          message: `Moderate complexity in \`${block.name}\` (score: ${score}). Consider simplifying.`,
          remediation: 'Look for opportunities to extract helper functions or simplify branching logic.',
        })
      }
    }
  }

  return findings
}
