import type { ReviewJob, Finding } from '../../types/index.js'

// ─── Route handler patterns ────────────────────────────────────────────────────

// Matches Express-style and decorator-style route definitions
const ROUTE_PATTERNS = [
  // Express: router.get('/path', ...) or app.post('/path', ...)
  /(?:router|app)\.(get|post|put|patch|delete|all)\s*\(\s*['"`][^'"`,]+['"`]/,
  // NestJS / TypeScript decorators: @Get('/path'), @Post(), etc.
  /@(Get|Post|Put|Patch|Delete|All)\s*\(/,
  // Fastify: fastify.get('/path', ...)
  /fastify\.(get|post|put|patch|delete)\s*\(/,
  // Hono: app.get('/path', ...)
  /\bapp\.(get|post|put|patch|delete)\s*\(/,
]

// ─── Auth middleware patterns ──────────────────────────────────────────────────

const AUTH_IMPORT_PATTERNS = [
  /require\s*\(\s*['"`][^'"]+(?:auth|middleware|guard|jwt|passport)[^'"]*['"`]\s*\)/i,
  /import\s+.+\s+from\s+['"`][^'"]+(?:auth|middleware|guard|jwt|passport)[^'"]*['"`]/i,
]

const AUTH_USAGE_PATTERNS = [
  /\brequireAuth\b/,
  /\bauthenticate\b/,
  /\bverifyToken\b/,
  /\bjwt\.verify\b/,
  /\bpassport\.authenticate\b/,
  /\bGuard\b/,              // NestJS AuthGuard
  /\bauthorize\b/i,
  /\bmiddleware\s*\(\s*['"`]auth/i,
  /\bcheckAuth\b/,
  /\bisAuthenticated\b/,
]

// ─── Dangerous CORS / JWT config patterns ─────────────────────────────────────

const CORS_WILDCARD_WITH_CREDS = /Access-Control-Allow-Origin['":\s]+\*[\s\S]{0,200}credentials['":\s]+true/
const JWT_ALGO_NONE = /algorithms?\s*[:=]\s*['"`]none['"`]/i

// ─── Helpers ───────────────────────────────────────────────────────────────────

function hasAuthMiddleware(content: string): boolean {
  return AUTH_USAGE_PATTERNS.some((p) => p.test(content))
}

function hasAuthImport(content: string): boolean {
  return AUTH_IMPORT_PATTERNS.some((p) => p.test(content))
}

function extractRouteLine(line: string): string {
  // extract the HTTP method + path for context
  const m =
    line.match(/\.(get|post|put|patch|delete|all)\s*\(\s*(['"`][^'"`,]*['"`])/) ??
    line.match(/@(Get|Post|Put|Patch|Delete)\s*\(\s*(['"`][^'"`,]*['"`])/)
  if (m) return `${m[1]!.toUpperCase()} ${m[2] ?? ''}`
  return line.trim().slice(0, 80)
}

// ─── Scan a single file ────────────────────────────────────────────────────────

function scanFile(
  path: string,
  content: string,
  relatedContents: string[]
): Finding[] {
  const findings: Finding[] = []
  const lines = content.split('\n')

  // Check if auth is imported/used in this file
  const allContent = [content, ...relatedContents].join('\n')
  const fileHasAuthImport = hasAuthImport(content)
  const fileHasAuthUsage = hasAuthMiddleware(content)

  // Check CORS wildcard + credentials
  if (CORS_WILDCARD_WITH_CREDS.test(allContent)) {
    findings.push({
      severity: 'HOLD',
      file: path,
      message: 'CORS misconfiguration: Access-Control-Allow-Origin: * combined with credentials: true. This allows any origin to make credentialed cross-origin requests.',
      remediation: 'Set a specific origin allowlist instead of *. Wildcard and credentials cannot be combined per the CORS spec.',
    })
  }

  // Check JWT algorithms: none
  if (JWT_ALGO_NONE.test(content)) {
    findings.push({
      severity: 'HOLD',
      file: path,
      message: "JWT configured with algorithm 'none' — signature verification is disabled. Any token will be accepted.",
      remediation: "Set algorithms to a specific value: ['RS256'] or ['HS256']. Never use 'none' in production.",
    })
  }

  // Scan for new route handlers without auth
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const lineNum = i + 1

    const isRoute = ROUTE_PATTERNS.some((p) => p.test(line))
    if (!isRoute) continue

    // Look at a window of lines around this route for inline auth usage
    const windowStart = Math.max(0, i - 2)
    const windowEnd = Math.min(lines.length - 1, i + 10)
    const window = lines.slice(windowStart, windowEnd + 1).join('\n')

    const routeHasInlineAuth = hasAuthMiddleware(window)

    if (routeHasInlineAuth) continue // auth applied inline — safe

    if (!fileHasAuthImport && !fileHasAuthUsage) {
      // No auth anywhere in file — clear gap
      findings.push({
        severity: 'WARN',
        file: path,
        line: lineNum,
        code: line.trim().slice(0, 120),
        message: `New route handler added without visible auth middleware: ${extractRouteLine(line)}`,
        remediation: 'Confirm this route is intentionally public. If not, add authentication middleware (e.g. requireAuth).',
      })
    } else if (fileHasAuthImport || fileHasAuthUsage) {
      // Auth imported/used elsewhere in file but not on this specific route
      findings.push({
        severity: 'SUGGEST',
        file: path,
        line: lineNum,
        code: line.trim().slice(0, 120),
        message: `Route handler may be missing auth middleware: ${extractRouteLine(line)}. Other routes in this file use auth, but this one may not.`,
        remediation: 'Verify auth middleware is applied to this route either inline or via a parent router.',
      })
    }
  }

  return findings
}

// ─── Public API ────────────────────────────────────────────────────────────────

export function scanAuth(job: ReviewJob): Finding[] {
  const findings: Finding[] = []
  const relatedContents = job.related_files.map((f) => f.content)

  for (const file of job.changed_files) {
    findings.push(...scanFile(file.path, file.content, relatedContents))
  }

  return findings
}
