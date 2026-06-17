// Extract import paths from file content (regex-based, not AST)

// ─── Language patterns ─────────────────────────────────────────────────────────

const JS_TS_PATTERNS = [
  // import ... from './path'
  /\bimport\s+(?:type\s+)?(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/g,
  // require('./path')
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  // export ... from './path'
  /\bexport\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/g,
  // dynamic import('./path')
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
]

const PYTHON_PATTERNS = [
  // from .module import ...  OR  from module import ...
  /\bfrom\s+([\w./]+)\s+import\b/g,
  // import module
  /^\s*import\s+([\w./,\s]+)/gm,
]

const GO_PATTERNS = [
  // import "path/to/pkg"
  /\bimport\s+"([^"]+)"/g,
  // import alias "path/to/pkg"
  /\b\w+\s+"([^"]+)"/g,
]

// ─── Path resolution ───────────────────────────────────────────────────────────

function isRelative(p: string): boolean {
  return p.startsWith('./') || p.startsWith('../')
}

function resolvePath(importPath: string, fromFile: string): string | null {
  if (!isRelative(importPath)) return null  // skip node_modules / stdlib

  // strip leading ./
  const dir = fromFile.split('/').slice(0, -1).join('/')
  const segments = [...(dir ? dir.split('/') : []), ...importPath.split('/')]
  const resolved: string[] = []

  for (const seg of segments) {
    if (seg === '..') resolved.pop()
    else if (seg !== '.') resolved.push(seg)
  }

  return resolved.join('/')
}

function matchAll(content: string, pattern: RegExp): string[] {
  const results: string[] = []
  // reset lastIndex for safety
  pattern.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = pattern.exec(content)) !== null) {
    if (m[1]) results.push(m[1].trim())
  }
  return results
}

// ─── Public API ────────────────────────────────────────────────────────────────

export function extractImports(filePath: string, content: string): string[] {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  const raw: string[] = []

  if (['js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs'].includes(ext)) {
    for (const pat of JS_TS_PATTERNS) {
      raw.push(...matchAll(content, new RegExp(pat.source, pat.flags)))
    }
  } else if (ext === 'py') {
    for (const pat of PYTHON_PATTERNS) {
      raw.push(...matchAll(content, new RegExp(pat.source, pat.flags)))
    }
  } else if (ext === 'go') {
    for (const pat of GO_PATTERNS) {
      raw.push(...matchAll(content, new RegExp(pat.source, pat.flags)))
    }
  }

  // Resolve relative paths, drop unresolvable (node_modules etc.)
  const resolved: string[] = []
  for (const imp of raw) {
    // handle comma-separated python imports
    for (const part of imp.split(',')) {
      const trimmed = part.trim()
      const r = resolvePath(trimmed, filePath)
      if (r) resolved.push(r)
    }
  }

  return [...new Set(resolved)]
}

// Fuzzy match: find best match in repo tree for a resolved import path
// (handles missing extension, index files)
export function resolveInTree(importPath: string, repoTree: string[]): string | null {
  // exact match
  if (repoTree.includes(importPath)) return importPath

  // try with common extensions
  const exts = ['.js', '.ts', '.jsx', '.tsx', '.mjs']
  for (const ext of exts) {
    const candidate = importPath + ext
    if (repoTree.includes(candidate)) return candidate
  }

  // try index file
  for (const ext of exts) {
    const candidate = importPath + '/index' + ext
    if (repoTree.includes(candidate)) return candidate
  }

  // prefix match (sometimes imports omit src/)
  const base = importPath.split('/').pop() ?? ''
  const matches = repoTree.filter((p) => p.endsWith('/' + base) || p === base)
  if (matches.length === 1) return matches[0]!

  return null
}
