import type { ReviewJob, Finding } from '../../types/index.js'

// ─── Patterns ──────────────────────────────────────────────────────────────────

// Off-by-one: loop using < vs <= on length, or slice with length +/- 1
const OFF_BY_ONE_PATTERNS = [
  { regex: /for\s*\(.+;\s*\w+\s*<=\s*\w+\.length\s*;/,  msg: 'Loop bound uses `<= length` — likely off-by-one (should be `< length`)' },
  { regex: /\.slice\s*\(\s*0\s*,\s*\w+\.length\s*\+\s*1\s*\)/, msg: 'slice(0, length + 1) — off-by-one, reads past end of array' },
  { regex: /\.slice\s*\(\s*\d+\s*,\s*\w+\.length\s*-\s*1\s*\)/, msg: 'slice(n, length - 1) — likely misses the last element' },
]

// Unreachable code: statement after return/throw on the same or next non-blank line
// We detect this at the function-block level by scanning for code after return/throw
const UNREACHABLE_PATTERN = /^\s*(return|throw)\b.+$/

// Always-true/false: comparisons that are vacuously true or false
const ALWAYS_TRUE_FALSE = [
  { regex: /if\s*\(\s*true\s*\)/,  msg: 'Condition is always true: `if (true)`' },
  { regex: /if\s*\(\s*false\s*\)/, msg: 'Condition is always false: `if (false)` — dead code' },
  { regex: /while\s*\(\s*true\s*\)\s*\{[\s\S]{0,200}\}(?!\s*\/\/\s*intentional)/,
    msg: 'while(true) with no visible break/return — check for infinite loop' },
  { regex: /===\s*undefined\s*===/, msg: 'Double undefined comparison — likely a typo' },
  { regex: /(\w+)\s*===\s*null\s*&&\s*\1\s*!==\s*null/, msg: 'Contradictory null checks on same variable' },
]

// Null deref on nullable: optional chain missing where value could be null
const NULL_DEREF_PATTERNS = [
  // foo.bar when foo might be null from a find/match/querySelector
  { regex: /=\s*\w+\.(?:find|match|querySelector)\([^)]*\)\s*\n[^?]*\.\w+/,
    msg: 'Possible null dereference: .find()/.match() can return undefined; check before accessing properties' },
  // response.data without optional chain after await fetch
  { regex: /await\s+fetch\([^)]+\)\s*\n\s*\w+\.\w+(?!\?)/,
    msg: 'Possible null dereference on fetch response — check response.ok before accessing body' },
]

// ─── Scan logic ────────────────────────────────────────────────────────────────

export function scanLogic(job: ReviewJob): Finding[] {
  const findings: Finding[] = []

  for (const file of job.changed_files) {
    const lines = file.content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      const lineNum = i + 1

      // Off-by-one
      for (const { regex, msg } of OFF_BY_ONE_PATTERNS) {
        if (regex.test(line)) {
          findings.push({
            severity: 'WARN',
            file: file.path,
            line: lineNum,
            code: line.trim().slice(0, 120),
            message: `Logic issue: ${msg}`,
            remediation: 'Review loop/slice bounds carefully.',
          })
        }
      }

      // Always-true/false (single-line patterns)
      for (const { regex, msg } of ALWAYS_TRUE_FALSE) {
        if (regex.test(line)) {
          findings.push({
            severity: 'WARN',
            file: file.path,
            line: lineNum,
            code: line.trim().slice(0, 120),
            message: `Logic issue: ${msg}`,
            remediation: 'Remove or correct the condition.',
          })
          break
        }
      }

      // Unreachable code: line after return/throw that is non-empty, non-comment, non-closing-brace
      if (UNREACHABLE_PATTERN.test(line)) {
        const nextLine = lines[i + 1]
        if (
          nextLine !== undefined &&
          nextLine.trim() !== '' &&
          !nextLine.trim().startsWith('//') &&
          !nextLine.trim().startsWith('*') &&
          !nextLine.trim().startsWith('}') &&
          !nextLine.trim().startsWith(')')  &&
          !nextLine.trim().startsWith('else')
        ) {
          findings.push({
            severity: 'WARN',
            file: file.path,
            line: i + 2, // point at the unreachable line
            code: nextLine.trim().slice(0, 120),
            message: 'Unreachable code: statement after return/throw',
            remediation: 'Remove the unreachable code or restructure the control flow.',
          })
        }
      }
    }

    // Multi-line null deref patterns (scan whole file content)
    for (const { regex, msg } of NULL_DEREF_PATTERNS) {
      if (regex.test(file.content)) {
        findings.push({
          severity: 'SUGGEST',
          file: file.path,
          message: `Possible null dereference: ${msg}`,
          remediation: 'Add a null/undefined check or use optional chaining (?.) before accessing properties.',
        })
      }
    }
  }

  return findings
}
