import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  ReviewJob,
  Command,
  FileDiff,
  FileContent,
  RepoConfig,
} from '../types/index.js'

interface PrJson {
  number: number
  title: string
  description: string
  commit_messages: string[]
  base_branch: string
  head_sha: string
  previous_head_sha?: string | null
  repo: string
}

async function readTextFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return undefined
  }
}

async function readJsonFile<T>(path: string): Promise<T | undefined> {
  const text = await readTextFile(path)
  if (text === undefined) return undefined
  return JSON.parse(text) as T
}

async function readDirFiles(dir: string): Promise<FileContent[]> {
  const results: FileContent[] = []
  let entries: string[]
  try {
    // recursive readdir without withFileTypes → always string[]
    const { readdir: readdirFn } = await import('node:fs/promises')
    entries = (await readdirFn(dir, { recursive: true })) as unknown as string[]
  } catch {
    return results
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry)
    const content = await readTextFile(fullPath)
    if (content !== undefined) {
      // normalize path separators
      results.push({ path: entry.replace(/\\/g, '/'), content })
    }
  }
  return results
}

function parsePatch(patch: string): FileDiff[] {
  const diffs: FileDiff[] = []
  // split on "diff --git" lines
  const chunks = patch.split(/^diff --git /m).filter(Boolean)
  for (const chunk of chunks) {
    const lines = chunk.split('\n')
    // first line: "a/path b/path"
    const headerMatch = lines[0]?.match(/\S+ b\/(.+)/)
    const path = headerMatch?.[1] ?? 'unknown'
    let additions = 0
    let deletions = 0
    for (const line of lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) additions++
      if (line.startsWith('-') && !line.startsWith('---')) deletions++
    }
    diffs.push({ path, additions, deletions, patch: chunk })
  }
  return diffs
}

export async function loadFixture(
  fixturePath: string,
  options?: {
    command?: Command
    question?: string
    llmApiKey?: string
    llmProvider?: ReviewJob['llm_provider']
    llmModel?: string
  }
): Promise<ReviewJob> {
  const dir = resolve(fixturePath)

  const pr = await readJsonFile<PrJson>(join(dir, 'pr.json'))
  if (!pr) throw new Error(`Missing pr.json in ${dir}`)

  const patchText = await readTextFile(join(dir, 'diff.patch'))
  if (!patchText) throw new Error(`Missing diff.patch in ${dir}`)

  const diff = parsePatch(patchText)

  const changed_files = await readDirFiles(join(dir, 'files'))
  const related_files = await readDirFiles(join(dir, 'related'))

  const repoTree = await readJsonFile<string[]>(join(dir, 'repo-tree.json')) ?? []
  const dependencyManifest = await readTextFile(join(dir, 'package.json'))
  const existingComments = await readJsonFile<string[]>(join(dir, 'existing_comments.json'))

  const repoConfig: RepoConfig = {}

  const job: ReviewJob = {
    job_id: randomUUID(),
    command: options?.command ?? 'review',
    question: options?.question,

    diff,

    pr: {
      number: pr.number,
      title: pr.title,
      description: pr.description,
      commit_messages: pr.commit_messages,
      base_branch: pr.base_branch,
      head_sha: pr.head_sha,
      previous_head_sha: pr.previous_head_sha ?? undefined,
      repo: pr.repo,
    },

    changed_files,
    related_files,
    repo_tree: repoTree,

    dependency_manifest: dependencyManifest,
    existing_comments: existingComments,

    llm_api_key: options?.llmApiKey ?? process.env['LLM_API_KEY'] ?? '',
    llm_provider: options?.llmProvider ?? 'anthropic',
    llm_model: options?.llmModel ?? 'claude-sonnet-4-5',

    repo_config: repoConfig,

    installation_id: 0,
  }

  return job
}
