import { Octokit } from 'octokit'
import { randomUUID } from 'node:crypto'
import type {
  ReviewJob, FileDiff, FileContent, Command, RepoConfig, LLMProvider,
} from '../types/index.js'
import { extractImports, resolveInTree } from '../agents/blast-radius/parser.js'

// ─── Diff size limits (from architecture doc) ────────────────────────────────

const MAX_FILES = 25
const MAX_DIFF_LINES = 500
const MAX_FILE_LINES = 1000

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AssemblerOptions {
  command: Command
  question?: string
  installationToken: string
  llmApiKey: string
  llmProvider: LLMProvider
  llmModel: string
  repoConfig?: RepoConfig
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parsePRFiles(files: GHFile[]): FileDiff[] {
  return files.map((f) => ({
    path: f.filename,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch ?? '',
  }))
}

interface GHFile {
  filename: string
  additions: number
  deletions: number
  patch?: string
  status: string
}

function totalDiffLines(diffs: FileDiff[]): number {
  return diffs.reduce((sum, d) => sum + d.additions + d.deletions, 0)
}

async function fetchFileContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string
): Promise<string | null> {
  try {
    const res = await octokit.rest.repos.getContent({ owner, repo, path, ref })
    const data = res.data
    if ('content' in data && data.encoding === 'base64') {
      return Buffer.from(data.content, 'base64').toString('utf-8')
    }
    return null
  } catch {
    return null
  }
}

async function fetchRepoConfig(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string
): Promise<RepoConfig> {
  try {
    const content = await fetchFileContent(octokit, owner, repo, '.pr-scrutiny.yml', ref)
    if (!content) return {}
    // Minimal YAML parse — only handle simple key: value pairs
    const config: RepoConfig = {}
    for (const line of content.split('\n')) {
      const m = line.match(/^(\w+):\s*(.+)$/)
      if (!m) continue
      const [, key, val] = m
      if (key === 'min_severity') config.min_severity = val!.trim() as RepoConfig['min_severity']
      if (key === 'auto_review_on_ready') config.auto_review_on_ready = val!.trim() === 'true'
    }
    return config
  } catch {
    return {}
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function assembleContext(
  fullRepo: string,
  prNumber: number,
  options: AssemblerOptions
): Promise<ReviewJob> {
  const [owner, repo] = fullRepo.split('/')
  if (!owner || !repo) throw new Error(`Invalid repo: ${fullRepo}`)

  const octokit = new Octokit({ auth: options.installationToken })

  // 1. PR metadata
  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber })
  const headSha = pr.head.sha
  const baseBranch = pr.base.ref

  // 2. Changed files
  const { data: ghFiles } = await octokit.rest.pulls.listFiles({
    owner, repo, pull_number: prNumber, per_page: 100,
  })

  // Enforce file limit — prioritize security-sensitive paths
  const securityPaths = /config|secret|key|auth|password|credential|\.env/i
  const sorted = [...ghFiles].sort((a, b) =>
    (securityPaths.test(b.filename) ? 1 : 0) - (securityPaths.test(a.filename) ? 1 : 0)
  )
  const limitedFiles = sorted.slice(0, MAX_FILES)
  const skippedFiles = ghFiles.length - limitedFiles.length

  let diffs = parsePRFiles(limitedFiles as GHFile[])

  // Enforce diff line limit
  if (totalDiffLines(diffs) > MAX_DIFF_LINES) {
    // Truncate patches that are too large
    diffs = diffs.map((d) => {
      const lines = d.patch.split('\n')
      if (lines.length > MAX_FILE_LINES) {
        return { ...d, patch: lines.slice(0, MAX_FILE_LINES).join('\n') + '\n... (truncated)' }
      }
      return d
    })
  }

  // 3. Fetch full content of changed files
  const changedContents: FileContent[] = []
  for (const diff of diffs) {
    const content = await fetchFileContent(octokit, owner, repo, diff.path, headSha)
    if (content) changedContents.push({ path: diff.path, content })
  }

  // 4. Fetch repo tree (for blast radius)
  let repoTree: string[] = []
  try {
    const { data: tree } = await octokit.rest.git.getTree({
      owner, repo, tree_sha: headSha, recursive: '1',
    })
    repoTree = tree.tree
      .filter((n) => n.type === 'blob')
      .map((n) => n.path!)
      .filter(Boolean)
  } catch {
    // Tree fetch failing is non-fatal
  }

  // 5. Fetch 1-hop related files (imports of changed files)
  const relatedPaths = new Set<string>()
  for (const file of changedContents) {
    const imports = extractImports(file.path, file.content)
    for (const imp of imports) {
      const resolved = resolveInTree(imp, repoTree)
      if (resolved && !diffs.some((d) => d.path === resolved)) {
        relatedPaths.add(resolved)
      }
    }
  }

  // Cap related files at 10
  const relatedFiles: FileContent[] = []
  for (const path of [...relatedPaths].slice(0, 10)) {
    const content = await fetchFileContent(octokit, owner, repo, path, headSha)
    if (content) relatedFiles.push({ path, content })
  }

  // 6. Dependency manifest
  let dependencyManifest: string | undefined
  for (const manifest of ['package.json', 'requirements.txt', 'go.mod', 'Cargo.toml']) {
    const content = await fetchFileContent(octokit, owner, repo, manifest, headSha)
    if (content) { dependencyManifest = content; break }
  }

  // 7. Existing PR comments (for LLM dedup)
  const { data: comments } = await octokit.rest.issues.listComments({
    owner, repo, issue_number: prNumber, per_page: 20,
  })
  const existingComments = comments
    .filter((c) => c.user?.login?.includes('bot') || c.body?.includes('PR Scrutiny'))
    .map((c) => c.body ?? '')
    .slice(0, 5)

  // 8. Repo config
  const repoConfig = options.repoConfig ?? await fetchRepoConfig(octokit, owner, repo, headSha)

  // 9. Commit messages
  const { data: prCommits } = await octokit.rest.pulls.listCommits({
    owner, repo, pull_number: prNumber, per_page: 20,
  })
  const commitMessages = prCommits.map((c) => c.commit.message)

  const job: ReviewJob = {
    job_id: randomUUID(),
    command: options.command,
    question: options.question,

    diff: diffs,

    pr: {
      number: prNumber,
      title: pr.title,
      description: pr.body ?? '',
      commit_messages: commitMessages,
      base_branch: baseBranch,
      head_sha: headSha,
      repo: fullRepo,
    },

    changed_files: changedContents,
    related_files: relatedFiles,
    repo_tree: repoTree,

    dependency_manifest: dependencyManifest,
    existing_comments: existingComments,

    llm_api_key: options.llmApiKey,
    llm_provider: options.llmProvider,
    llm_model: options.llmModel,

    repo_config: repoConfig,
    installation_id: 0,  // set by caller
  }

  if (skippedFiles > 0) {
    console.warn(`[context] Skipped ${skippedFiles} files (limit: ${MAX_FILES})`)
  }

  return job
}
