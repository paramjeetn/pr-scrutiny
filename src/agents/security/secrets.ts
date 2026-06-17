import type { ReviewJob, Finding } from '../../types/index.js'

// ─── Skip conditions ───────────────────────────────────────────────────────────

const SKIP_PATH_PATTERNS = [
  /\btest[s]?\b/i,
  /\bspec\b/i,
  /\b__mocks__\b/i,
  /\bmocks?\b/i,
  /\.example$/,
  /\.sample$/,
  /fixture/i,
]

function shouldSkip(path: string): boolean {
  return SKIP_PATH_PATTERNS.some((p) => p.test(path))
}

// ─── Shannon entropy ───────────────────────────────────────────────────────────

function shannonEntropy(str: string): number {
  const freq: Record<string, number> = {}
  for (const ch of str) freq[ch] = (freq[ch] ?? 0) + 1
  let entropy = 0
  for (const count of Object.values(freq)) {
    const p = count / str.length
    entropy -= p * Math.log2(p)
  }
  return entropy
}

function isHighEntropy(value: string): boolean {
  return value.length > 20 && shannonEntropy(value) > 4.5
}

// ─── Secret patterns (HOLD severity) ──────────────────────────────────────────

interface SecretPattern {
  name: string
  regex: RegExp
}

const SECRET_PATTERNS: SecretPattern[] = [
  { name: 'AWS Access Key ID',        regex: /\bAKIA[0-9A-Z]{14,20}\b/ },
  { name: 'AWS Secret Access Key',    regex: /(?:aws.{0,20}secret|secretAccessKey).{0,20}['"][0-9a-zA-Z/+]{30,}['"]/i },
  { name: 'GCP API Key',              regex: /AIza[0-9A-Za-z_-]{35}/ },
  { name: 'GitHub Token',             regex: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: 'Stripe Live Secret Key',   regex: /sk_live_[0-9a-zA-Z]{24,}/ },
  { name: 'Stripe Webhook Secret',    regex: /whsec_[0-9a-zA-Z]{32,}/ },
  { name: 'Twilio Account SID',       regex: /AC[a-z0-9]{32}\b/ },
  { name: 'Twilio Auth Token',        regex: /twilio.{0,20}['"][a-z0-9]{32}['"]/i },
  { name: 'PEM Private Key',          regex: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'JWT Token',                regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: 'Connection String',        regex: /(?:mongodb|postgres|mysql|redis):\/\/[^:]+:[^@]+@/ },
  { name: 'SendGrid API Key',         regex: /SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/ },
  { name: 'Slack Bot Token',          regex: /xox[baprs]-[0-9A-Za-z]{10,}/ },
  { name: 'Hardcoded Password',       regex: /password\s*[:=]\s*['"][^'"]{6,}['"]/i },
]

// ─── Base64 decode helper ──────────────────────────────────────────────────────

function tryBase64Decode(str: string): string | null {
  try {
    if (!/^[A-Za-z0-9+/=]{20,}$/.test(str)) return null
    return Buffer.from(str, 'base64').toString('utf-8')
  } catch {
    return null
  }
}

// ─── Scan a single file content ────────────────────────────────────────────────

function scanContent(path: string, content: string): Finding[] {
  if (shouldSkip(path)) return []

  const findings: Finding[] = []
  const lines = content.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const lineNum = i + 1

    // Pattern-based (HOLD)
    for (const { name, regex } of SECRET_PATTERNS) {
      if (regex.test(line)) {
        findings.push({
          severity: 'HOLD',
          file: path,
          line: lineNum,
          code: line.trim().slice(0, 120),
          message: `Hardcoded secret detected: ${name}`,
          remediation: 'Remove from source. Use environment variables or a secrets manager (e.g. GCP Secret Manager).',
        })
        break // one finding per line max
      }
    }

    // Entropy-based: extract quoted strings and check (WARN)
    const quoted = line.matchAll(/['"`]([^'"`\s]{20,})['"`]/g)
    for (const match of quoted) {
      const candidate = match[1]!

      // skip if already caught by pattern
      if (findings.some((f) => f.line === lineNum && f.severity === 'HOLD')) break

      if (isHighEntropy(candidate)) {
        findings.push({
          severity: 'WARN',
          file: path,
          line: lineNum,
          code: line.trim().slice(0, 120),
          message: `High-entropy string detected (possible secret): entropy=${shannonEntropy(candidate).toFixed(2)}`,
          remediation: 'Verify this is not a hardcoded credential. Move to environment variables if so.',
        })
        break
      }

      // try base64 decode and re-scan
      const decoded = tryBase64Decode(candidate)
      if (decoded) {
        for (const { name, regex } of SECRET_PATTERNS) {
          if (regex.test(decoded)) {
            findings.push({
              severity: 'HOLD',
              file: path,
              line: lineNum,
              code: line.trim().slice(0, 120),
              message: `Base64-encoded secret detected: ${name}`,
              remediation: 'Remove encoded secret from source. Use a secrets manager.',
            })
            break
          }
        }
      }
    }
  }

  return findings
}

// ─── Public API ────────────────────────────────────────────────────────────────

export function scanSecrets(job: ReviewJob): Finding[] {
  const findings: Finding[] = []

  for (const file of job.changed_files) {
    findings.push(...scanContent(file.path, file.content))
  }

  // also scan diff hunks for deleted-then-re-added secrets (added lines only)
  for (const diff of job.diff) {
    if (shouldSkip(diff.path)) continue
    const addedLines = diff.patch
      .split('\n')
      .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
      .map((l) => l.slice(1))
      .join('\n')

    // only report if NOT already caught from file content
    const alreadyCovered = findings.some((f) => f.file === diff.path)
    if (!alreadyCovered) {
      const diffFindings = scanContent(diff.path, addedLines)
      findings.push(...diffFindings)
    }
  }

  return findings
}
