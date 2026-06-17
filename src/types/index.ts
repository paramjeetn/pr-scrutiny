// ─── Commands ────────────────────────────────────────────────────────────────

export type Command =
  | 'review'
  | 'review:security'
  | 'review:perf'
  | 'summarize'
  | 'ask'
  | 'blast-radius'
  | 're-review'

// ─── Severity ─────────────────────────────────────────────────────────────────

export type Severity = 'HOLD' | 'WARN' | 'SUGGEST' | 'PASS' | 'QUESTION'

export const SEVERITY_ORDER: Record<Severity, number> = {
  HOLD: 0,
  WARN: 1,
  SUGGEST: 2,
  PASS: 3,
  QUESTION: 4,
}

// ─── Diff + file content ───────────────────────────────────────────────────────

export interface FileDiff {
  path: string
  additions: number
  deletions: number
  patch: string  // unified diff format
}

export interface FileContent {
  path: string
  content: string
}

// ─── Findings ─────────────────────────────────────────────────────────────────

export interface Finding {
  severity: Severity
  file?: string
  line?: number
  code?: string       // short snippet for context
  message: string
  remediation?: string
}

// ─── Agent results + traces ────────────────────────────────────────────────────

export interface AgentTrace {
  agent: string
  started_at: string   // ISO timestamp
  duration_ms: number
  finding_count: number
  timed_out: boolean
  error?: string
}

export interface AgentResult {
  agent: string
  findings: Finding[]
  metadata?: Record<string, unknown>
  trace: AgentTrace
}

// ─── Job trace (aggregated across all agents) ──────────────────────────────────

export interface JobTrace {
  job_id: string
  command: Command
  started_at: string
  duration_ms: number
  agents: AgentTrace[]
  total_findings: number
  llm_tokens_used?: number
}

// ─── Blast radius metadata ─────────────────────────────────────────────────────

export interface BlastRadiusMetadata {
  affected_files: string[]
  missing_tests: string[]        // changed files with no corresponding test file
  affected_routes: string[]
  config_changes: boolean
  migration_files: string[]
  hop_count: number
}

// ─── Repo config (.pr-scrutiny.yml) ───────────────────────────────────────────

export interface RepoConfig {
  ignore_paths?: string[]
  min_severity?: Severity
  auto_review_on_ready?: boolean
  disabled_agents?: string[]
  llm_provider?: LLMProvider
}

// ─── LLM provider ─────────────────────────────────────────────────────────────

export type LLMProvider = 'anthropic' | 'openai' | 'google'

export const PROVIDER_MODELS: Record<LLMProvider, string[]> = {
  anthropic: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-sonnet-4-5', 'claude-haiku-4-5'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini'],
  google: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
}

// ─── Installation config (Firestore) ──────────────────────────────────────────

export interface InstallationConfig {
  api_key: string          // KMS-encrypted at rest
  provider: LLMProvider
  model: string            // e.g. "claude-sonnet-4-5"
  email: string            // required — for error alerts
  active: boolean
  created_at: string
  updated_at: string
}

// ─── Core review job ──────────────────────────────────────────────────────────

export interface ReviewJob {
  // identity
  job_id: string
  command: Command
  question?: string         // only for /ask

  // diff
  diff: FileDiff[]

  // PR context
  pr: {
    number: number
    title: string
    description: string
    commit_messages: string[]
    base_branch: string
    head_sha: string
    previous_head_sha?: string   // for /re-review delta
    repo: string                 // "owner/repo"
  }

  // file contents
  changed_files: FileContent[]
  related_files: FileContent[]   // 1-hop imports (cross-file analysis)

  // repo structure (for blast radius)
  repo_tree: string[]            // full list of file paths in repo

  // optional
  dependency_manifest?: string   // package.json / requirements.txt / go.mod
  existing_comments?: string[]   // for LLM dedup

  // customer config
  llm_api_key: string
  llm_provider: LLMProvider
  llm_model: string

  // repo config (from .pr-scrutiny.yml, defaults applied)
  repo_config: RepoConfig

  // github auth
  installation_id: number
}
