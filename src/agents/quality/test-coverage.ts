import type { ReviewJob, Finding } from '../../types/index.js'

// ─── Extract new function names from diff added lines ──────────────────────────

// Matches function declarations and arrow function assignments
const FUNCTION_DEF_PATTERNS = [
  /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/,
  /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(?[^)]*\)?\s*=>/,
  /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function/,
  // class methods
  /^\s+(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/,
]

function extractNewFunctions(patch: string): string[] {
  const names: string[] = []
  for (const line of patch.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue
    const code = line.slice(1).trim()
    for (const pattern of FUNCTION_DEF_PATTERNS) {
      const m = code.match(pattern)
      if (m?.[1] && m[1] !== 'if' && m[1] !== 'for' && m[1] !== 'while') {
        names.push(m[1])
        break
      }
    }
  }
  // deduplicate
  return [...new Set(names)]
}

// ─── Check if a test file exists for this source file ─────────────────────────

function hasTestFile(sourcePath: string, repoTree: string[]): boolean {
  const base = sourcePath
    .replace(/\.[^.]+$/, '')            // remove extension
    .replace(/^src\//, '')              // strip src/ prefix

  const testPatterns = [
    `${sourcePath.replace(/\.[^.]+$/, '')}.test.`,
    `${sourcePath.replace(/\.[^.]+$/, '')}.spec.`,
    `__tests__/${base}`,
    `tests/${base}`,
    `test/${base}`,
  ]

  return repoTree.some((path) =>
    testPatterns.some((pattern) => path.includes(pattern))
  )
}

// ─── Public API ────────────────────────────────────────────────────────────────

export function scanTestCoverage(job: ReviewJob): Finding[] {
  const findings: Finding[] = []

  for (const diff of job.diff) {
    // Skip test files themselves
    if (/\.(test|spec)\.[jt]sx?$/.test(diff.path) || diff.path.includes('__tests__')) {
      continue
    }

    const newFunctions = extractNewFunctions(diff.patch)
    if (newFunctions.length === 0) continue

    const covered = hasTestFile(diff.path, job.repo_tree)

    if (!covered) {
      findings.push({
        severity: 'SUGGEST',
        file: diff.path,
        message: `New function(s) added without a corresponding test file: ${newFunctions.slice(0, 5).map((n) => `\`${n}\``).join(', ')}${newFunctions.length > 5 ? ` (+${newFunctions.length - 5} more)` : ''}`,
        remediation: `Add tests for the new code. Expected test file: \`${diff.path.replace(/\.[^.]+$/, '.test$&')}\``,
      })
    }
  }

  return findings
}
