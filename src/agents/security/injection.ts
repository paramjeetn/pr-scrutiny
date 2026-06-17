import type { ReviewJob, Finding } from '../../types/index.js'

// ─── Dangerous sinks ───────────────────────────────────────────────────────────

interface Sink {
  name: string
  // matches the sink usage on a line
  regex: RegExp
  // if matched, extract the argument portion to check if it's a literal
  argPattern?: RegExp
}

const SINKS: Sink[] = [
  {
    name: 'eval()',
    regex: /\beval\s*\(/,
    // capture everything after eval( to end of line — we'll check the whole trailing content
    argPattern: /\beval\s*\((.+)/,
  },
  {
    name: 'exec() / execSync()',
    regex: /\bexec(?:Sync)?\s*\(/,
    argPattern: /\bexec(?:Sync)?\s*\((.+)/,
  },
  {
    name: 'child_process.spawn()',
    regex: /\bspawn\s*\(/,
    argPattern: /\bspawn\s*\((.+)/,
  },
  {
    name: 'Raw SQL string concatenation',
    // SQL keyword followed by string concat (+ variable or template literal)
    regex: /['"`]SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE.{0,80}[+`]/i,
  },
  {
    name: 'innerHTML assignment',
    regex: /\.innerHTML\s*=/,
    argPattern: /\.innerHTML\s*=\s*(.+)/,
  },
  {
    name: 'dangerouslySetInnerHTML',
    regex: /dangerouslySetInnerHTML\s*=\s*\{/,
  },
  {
    name: 'document.write()',
    regex: /document\.write\s*\(/,
    argPattern: /document\.write\s*\(([^)]*)\)/,
  },
  {
    name: 'Function() constructor',
    regex: /new\s+Function\s*\(/,
  },
]

// ─── Heuristic: is the argument a string literal? ─────────────────────────────
// Returns true if argument looks like a plain string literal (safe).
// Returns false if it references a variable, template literal, or concatenation (risky).

function isLiteralArg(arg: string): boolean {
  // strip trailing ) and whitespace (artifact of end-of-line capture)
  const trimmed = arg.trim().replace(/\)+\s*$/, '').trim()
  // pure string literal: 'foo', "foo", `foo` (no ${...})
  if (/^['"][^'"]*['"]$/.test(trimmed)) return true
  if (/^`[^`$]*`$/.test(trimmed)) return true
  return false
}

// ─── Cross-file: check if variable originates from request params ─────────────

function looksLikeRequestParam(varName: string, relatedContent: string[]): boolean {
  const patterns = [
    new RegExp(`${varName}\\s*=\\s*req\\.(?:params|query|body|headers)`, 'i'),
    new RegExp(`${varName}\\s*=\\s*request\\.(?:params|query|body)`, 'i'),
    new RegExp(`const\\s*\\{[^}]*${varName}[^}]*\\}\\s*=\\s*req\\.body`, 'i'),
    new RegExp(`const\\s*\\{[^}]*${varName}[^}]*\\}\\s*=\\s*req\\.query`, 'i'),
  ]
  const allContent = relatedContent.join('\n')
  return patterns.some((p) => p.test(allContent))
}

// ─── Scan a single file ────────────────────────────────────────────────────────

function scanFile(
  path: string,
  content: string,
  relatedContents: string[]
): Finding[] {
  const findings: Finding[] = []
  const lines = content.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const lineNum = i + 1

    for (const sink of SINKS) {
      if (!sink.regex.test(line)) continue

      // Extract argument if we have a pattern
      let severity: Finding['severity'] = 'WARN'
      let detail = ''

      if (sink.argPattern) {
        const argMatch = line.match(sink.argPattern)
        const arg = argMatch?.[1] ?? ''

        if (isLiteralArg(arg)) continue // safe — literal string

        // Extract variable name from the arg (first identifier)
        const varMatch = arg.match(/\b([a-zA-Z_$][a-zA-Z0-9_$]*)\b/)
        const varName = varMatch?.[1] ?? ''

        if (varName && looksLikeRequestParam(varName, [content, ...relatedContents])) {
          severity = 'HOLD'
          detail = ` — argument '${varName}' appears to originate from user input`
        } else if (arg.includes('+') || arg.includes('${')) {
          // string concatenation in the argument — always HOLD (tainted by definition)
          severity = 'HOLD'
          detail = ' — argument contains string concatenation (possible injection vector)'
        } else if (/\breq\b|\brequest\b/.test(arg)) {
          severity = 'HOLD'
          detail = ' — argument references request object directly'
        } else {
          severity = 'WARN'
          detail = ' — argument is non-literal; verify it cannot be user-controlled'
        }
      } else {
        // No arg pattern — always HOLD (e.g. dangerouslySetInnerHTML, SQL concat)
        severity = 'HOLD'
        detail = ''
      }

      findings.push({
        severity,
        file: path,
        line: lineNum,
        code: line.trim().slice(0, 120),
        message: `Injection sink: ${sink.name}${detail}`,
        remediation: getRemediation(sink.name),
      })
      break // one finding per line
    }
  }

  return findings
}

function getRemediation(sinkName: string): string {
  if (sinkName.includes('SQL')) return 'Use parameterized queries / prepared statements. Never concatenate user input into SQL.'
  if (sinkName.includes('eval') || sinkName.includes('Function')) return 'Avoid eval(). If dynamic execution is required, use a sandboxed environment.'
  if (sinkName.includes('exec') || sinkName.includes('spawn')) return 'Avoid passing user input to shell commands. Use allowlists and argument arrays instead of strings.'
  if (sinkName.includes('innerHTML') || sinkName.includes('dangerously') || sinkName.includes('document.write')) return 'Avoid setting HTML from user input. Use textContent or a sanitization library (DOMPurify).'
  return 'Validate and sanitize all user-controlled input before passing to this sink.'
}

// ─── Public API ────────────────────────────────────────────────────────────────

export function scanInjection(job: ReviewJob): Finding[] {
  const findings: Finding[] = []
  const relatedContents = job.related_files.map((f) => f.content)

  for (const file of job.changed_files) {
    findings.push(...scanFile(file.path, file.content, relatedContents))
  }

  return findings
}
