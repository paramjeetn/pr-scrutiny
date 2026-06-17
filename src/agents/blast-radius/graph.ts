import type { FileContent } from '../../types/index.js'
import { extractImports, resolveInTree } from './parser.js'

// ─── Types ─────────────────────────────────────────────────────────────────────

// file path -> list of files it imports (resolved to repo paths)
export type ImportGraph = Map<string, string[]>

// ─── Build graph from available file contents ──────────────────────────────────

export function buildImportGraph(
  files: FileContent[],
  repoTree: string[]
): ImportGraph {
  const graph: ImportGraph = new Map()

  for (const file of files) {
    const rawImports = extractImports(file.path, file.content)
    const resolved: string[] = []

    for (const imp of rawImports) {
      const match = resolveInTree(imp, repoTree)
      if (match) resolved.push(match)
    }

    graph.set(file.path, resolved)
  }

  return graph
}

// ─── Build reverse graph: file -> files that import IT ────────────────────────

export function buildReverseGraph(graph: ImportGraph): ImportGraph {
  const reverse: ImportGraph = new Map()

  for (const [importer, deps] of graph) {
    for (const dep of deps) {
      if (!reverse.has(dep)) reverse.set(dep, [])
      reverse.get(dep)!.push(importer)
    }
  }

  return reverse
}

// ─── Traverse outward from changed files (up to maxHops) ──────────────────────

export function traverseAffected(
  changedFiles: string[],
  reverseGraph: ImportGraph,
  repoTree: string[],
  maxHops = 2
): Set<string> {
  const affected = new Set<string>()
  let frontier = new Set(changedFiles)

  for (let hop = 0; hop < maxHops; hop++) {
    const nextFrontier = new Set<string>()

    for (const file of frontier) {
      const importers = reverseGraph.get(file) ?? []
      for (const importer of importers) {
        if (!affected.has(importer) && !frontier.has(importer)) {
          nextFrontier.add(importer)
        }
      }
    }

    for (const f of nextFrontier) affected.add(f)
    if (nextFrontier.size === 0) break
    frontier = nextFrontier
  }

  // also include changed files themselves in affected set
  for (const f of changedFiles) affected.add(f)

  return affected
}
