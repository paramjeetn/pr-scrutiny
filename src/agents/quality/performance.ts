import type { ReviewJob, Finding } from '../../types/index.js'

// ─── DB call patterns ──────────────────────────────────────────────────────────

// Recognise common DB/ORM call patterns
const DB_CALL_PATTERN = /\b(?:await\s+)?(?:(?:db|pool|prisma|knex|sequelize|mongoose|client|orm|conn|repository|repo)\b.*?\.)?(query|findOne|findById|findAll|findMany|findByPk|save|update|delete|insert|execute|rawQuery|getOne|getMany)\s*\(/i

// Loop start patterns
const LOOP_START = /^\s*(?:for\s*\(|for\s+(?:const|let|var)\s+|while\s*\(|\.forEach\s*\(|\.map\s*\(|\.filter\s*\(|\.reduce\s*\()/

// Blocking I/O in async context
const BLOCKING_IO_PATTERNS = [
  { regex: /\breadFileSync\s*\(/, msg: '`readFileSync` in what appears to be an async context — use `readFile` with await instead' },
  { regex: /\bwriteFileSync\s*\(/, msg: '`writeFileSync` in async context — use `writeFile` with await' },
  { regex: /\bexecSync\s*\(/, msg: '`execSync` blocks the event loop — use `exec` with await or `spawn`' },
  { regex: /\btime\.sleep\s*\(/, msg: '`time.sleep` in async context — use async sleep instead' },
  { regex: /\bsleepSync\s*\(/, msg: '`sleepSync` blocks the event loop' },
]

// Infinite loop without visible exit
// JS/TS: while(true), while (true), for(;;)
// Python: while True:, while true: (lowercase tolerated), while 1:
const WHILE_TRUE = /\bwhile\s*\(\s*true\s*\)|\bfor\s*\(\s*;\s*;\s*\)|\bwhile\s+[Tt]rue\s*:|\bwhile\s+1\s*:/

// Stream / full materialization anti-patterns
const FULL_COLLECT_PATTERNS = [
  { regex: /\.collect\s*\(\s*\)/, msg: '`.collect()` materializes the full stream into memory — consider processing in chunks' },
  { regex: /Array\.from\s*\(\s*\w+\s*\)/, msg: '`Array.from()` on a large iterable/stream materializes everything into memory' },
  { regex: /\[\s*\.\.\.\w+\s*\]/, msg: 'Spread of potentially large iterable into array — verify this is intentional' },
]

// ─── Detect N+1: DB call inside a loop ─────────────────────────────────────────

function scanNPlusOne(path: string, lines: string[]): Finding[] {
  const findings: Finding[] = []
  let loopDepth = 0
  let loopStartLine = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const lineNum = i + 1

    if (LOOP_START.test(line)) {
      loopDepth++
      if (loopDepth === 1) loopStartLine = lineNum
    }

    // Track brace depth only inside loops
    if (loopDepth > 0) {
      if (DB_CALL_PATTERN.test(line)) {
        findings.push({
          severity: 'WARN',
          file: path,
          line: lineNum,
          code: line.trim().slice(0, 120),
          message: `N+1 query risk: database call inside a loop (loop starts at line ${loopStartLine})`,
          remediation: 'Batch the query outside the loop using IN (...) or bulk fetch, then index results by key.',
        })
      }

      // crude brace tracking to detect loop end
      for (const ch of line) {
        if (ch === '{') loopDepth++
        if (ch === '}') {
          loopDepth--
          if (loopDepth < 0) loopDepth = 0
        }
      }
    }
  }

  return findings
}

// ─── Public API ────────────────────────────────────────────────────────────────

export function scanPerformance(job: ReviewJob): Finding[] {
  const findings: Finding[] = []

  for (const file of job.changed_files) {
    const lines = file.content.split('\n')
    const isAsync = file.content.includes('async ')

    // N+1 detection
    findings.push(...scanNPlusOne(file.path, lines))

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      const lineNum = i + 1

      // Blocking I/O in async files
      if (isAsync) {
        for (const { regex, msg } of BLOCKING_IO_PATTERNS) {
          if (regex.test(line)) {
            findings.push({
              severity: 'WARN',
              file: file.path,
              line: lineNum,
              code: line.trim().slice(0, 120),
              message: `Blocking I/O in async context: ${msg}`,
              remediation: 'Use the async equivalent with await to avoid blocking the event loop.',
            })
            break
          }
        }
      }

      // while(true) without nearby break/return
      if (WHILE_TRUE.test(line)) {
        const window = lines.slice(i, Math.min(i + 20, lines.length)).join('\n')
        const hasExit = /\b(break|return|throw)\b/.test(window)
        if (!hasExit) {
          findings.push({
            severity: 'WARN',
            file: file.path,
            line: lineNum,
            code: line.trim().slice(0, 120),
            message: 'Potential infinite loop: `while(true)` with no visible break/return in the next 20 lines',
            remediation: 'Add a clear exit condition or use a bounded loop instead.',
          })
        }
      }

      // Full stream materialization
      for (const { regex, msg } of FULL_COLLECT_PATTERNS) {
        if (regex.test(line)) {
          findings.push({
            severity: 'SUGGEST',
            file: file.path,
            line: lineNum,
            code: line.trim().slice(0, 120),
            message: `Performance: ${msg}`,
            remediation: 'Process data in a streaming or paginated fashion if the dataset could be large.',
          })
          break
        }
      }
    }
  }

  return findings
}
