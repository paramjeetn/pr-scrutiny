import type { BlastRadiusMetadata } from '../../types/index.js'

// ─── Path classifiers ──────────────────────────────────────────────────────────

const TEST_FILE_PATTERNS = [
  /\.(test|spec)\.[jt]sx?$/,
  /__tests__\//,
  /\/tests?\//,
]

const ROUTE_PATTERNS = [
  /\/routes?\//,
  /\/controllers?\//,
  /\/handlers?\//,
  /router\./,
]

const CONFIG_PATTERNS = [
  /config/i,
  /\.env/,
  /settings/i,
  /constants/i,
]

const MIGRATION_PATTERNS = [
  /migrat/i,
  /schema/i,
  /\d{13,}.*\.sql$/,   // timestamped migration
  /V\d+__.*\.sql$/,    // Flyway-style
]

function isTestFile(path: string): boolean {
  return TEST_FILE_PATTERNS.some((p) => p.test(path))
}

function isRouteFile(path: string): boolean {
  return ROUTE_PATTERNS.some((p) => p.test(path))
}

function isConfigFile(path: string): boolean {
  return CONFIG_PATTERNS.some((p) => p.test(path))
}

function isMigrationFile(path: string): boolean {
  return MIGRATION_PATTERNS.some((p) => p.test(path))
}

// ─── Find which changed source files are missing a test file ──────────────────

function findMissingTests(
  changedFiles: string[],
  repoTree: string[]
): string[] {
  const missing: string[] = []

  for (const file of changedFiles) {
    if (isTestFile(file)) continue
    const nameNoExt = file.replace(/\.[^.]+$/, '').split('/').pop() ?? ''
    const hasTest = repoTree.some((p) => {
      // same-path test: src/utils/db.test.js
      const base = file.replace(/\.[^.]+$/, '')
      if (p.startsWith(base + '.test') || p.startsWith(base + '.spec')) return true
      // co-located __tests__: src/utils/__tests__/db.test.js
      if (p.includes('__tests__/' + nameNoExt)) return true
      // mirrored tests dir: tests/utils/db.test.js  OR  test/utils/db.test.js
      if (/(?:^|[\\/])tests?[\\/]/.test(p) && (p.includes('/' + nameNoExt + '.test') || p.includes('/' + nameNoExt + '.spec'))) return true
      return false
    })
    if (!hasTest) missing.push(file)
  }

  return missing
}

// ─── Public API ────────────────────────────────────────────────────────────────

export function classify(
  changedFiles: string[],
  affectedFiles: Set<string>,
  repoTree: string[],
  hopCount: number
): BlastRadiusMetadata {
  const affected = [...affectedFiles]

  const affectedRoutes = affected.filter(isRouteFile)
  const migrationFiles = changedFiles.filter(isMigrationFile)
  const configChanges = changedFiles.some(isConfigFile)
  const missingTests = findMissingTests(changedFiles, repoTree)

  return {
    affected_files: affected.sort(),
    missing_tests: missingTests,
    affected_routes: affectedRoutes,
    config_changes: configChanges,
    migration_files: migrationFiles,
    hop_count: hopCount,
  }
}
