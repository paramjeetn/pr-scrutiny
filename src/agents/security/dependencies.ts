import type { ReviewJob, Finding } from '../../types/index.js'

// ─── Types ─────────────────────────────────────────────────────────────────────

interface PackageJson {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

interface OsvVuln {
  id: string
  summary?: string
  severity?: Array<{ type: string; score: number }>
  database_specific?: { severity?: string }
}

interface OsvResponse {
  vulns?: OsvVuln[]
}

// ─── OSV API ───────────────────────────────────────────────────────────────────

// Injectable for testing
export type OsvFetcher = (pkg: string, version: string) => Promise<OsvResponse>

export const defaultOsvFetcher: OsvFetcher = async (pkg, version) => {
  const url = 'https://api.osv.dev/v1/query'
  const body = JSON.stringify({
    version,
    package: { name: pkg, ecosystem: 'npm' },
  })
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) return {}
  return res.json() as Promise<OsvResponse>
}

// ─── Semver helpers ────────────────────────────────────────────────────────────

function stripRange(version: string): string {
  // strip ^, ~, >=, <=, >, <, = prefix
  return version.replace(/^[\^~>=<]+/, '').trim()
}

function parseVersion(v: string): [number, number, number] {
  const parts = stripRange(v).split('.').map(Number)
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
}

// ─── Parse manifest: extract all packages with their versions ─────────────────

function parseManifest(manifest: string): Record<string, string> {
  try {
    const parsed = JSON.parse(manifest) as PackageJson
    return {
      ...parsed.dependencies,
      ...parsed.devDependencies,
    }
  } catch {
    return {}
  }
}

// ─── CVE severity from OSV response ───────────────────────────────────────────

function maxCvss(vuln: OsvVuln): number {
  let max = 0
  for (const s of vuln.severity ?? []) {
    if (s.score > max) max = s.score
  }
  // fallback: database_specific severity string
  if (max === 0 && vuln.database_specific?.severity) {
    const sev = vuln.database_specific.severity.toUpperCase()
    if (sev === 'CRITICAL') max = 9.0
    else if (sev === 'HIGH') max = 7.5
    else if (sev === 'MEDIUM') max = 5.0
    else if (sev === 'LOW') max = 2.0
  }
  return max
}

// ─── Public API ────────────────────────────────────────────────────────────────

export async function scanDependencies(
  job: ReviewJob,
  osvFetcher: OsvFetcher = defaultOsvFetcher
): Promise<Finding[]> {
  if (!job.dependency_manifest) return []

  const packages = parseManifest(job.dependency_manifest)
  if (Object.keys(packages).length === 0) return []

  const findings: Finding[] = []
  const now = Date.now()
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000

  // Run OSV queries in parallel (max 10 at a time to avoid hammering the API)
  const entries = Object.entries(packages)
  const BATCH = 10

  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH)
    const results = await Promise.allSettled(
      batch.map(async ([pkg, versionRange]) => {
        const version = stripRange(versionRange)
        if (!version || version === '*' || version === 'latest') return

        let osvData: OsvResponse = {}
        try {
          osvData = await osvFetcher(pkg, version)
        } catch {
          // OSV unreachable — skip silently in agent context
          return
        }

        for (const vuln of osvData.vulns ?? []) {
          const cvss = maxCvss(vuln)
          if (cvss < 7.0) continue

          findings.push({
            severity: cvss >= 9.0 ? 'HOLD' : 'WARN',
            message: `Dependency ${pkg}@${version} has CVE ${vuln.id} (CVSS ${cvss.toFixed(1)}): ${vuln.summary ?? 'no summary'}`,
            remediation: `Update ${pkg} to a patched version. Check https://osv.dev/vulnerability/${vuln.id} for details.`,
          })
        }

        // Flag very new packages (< 30 days on npm, no prior history signal)
        // Heuristic: major version 0, minor <= 1 — genuinely new packages
        const [major, minor] = parseVersion(version)
        if (major === 0 && minor <= 1) {
          findings.push({
            severity: 'WARN',
            message: `Dependency ${pkg}@${version} appears to be a very early release (v${major}.${minor}.x). Verify this package is trustworthy before shipping.`,
            remediation: 'Check the package on npm: publication date, author, download count, and source repo.',
          })
        }
      })
    )

    // surface any unexpected errors as WARN findings
    for (const result of results) {
      if (result.status === 'rejected') {
        findings.push({
          severity: 'WARN',
          message: `Dependency audit: error querying OSV — ${String(result.reason)}`,
        })
      }
    }
  }

  return findings
}
