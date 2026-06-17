export type Command =
  | 'review'
  | 'review:security'
  | 'review:perf'
  | 'summarize'
  | 'ask'
  | 'blast-radius'
  | 're-review'

export interface FileDiff {
  path: string
  additions: number
  deletions: number
  patch: string // unified diff format
}

export interface FileContent {
  path: string
  content: string
}

export interface ReviewJob {
  // identity
  job_id: string
  command: Command
  question?: string // only for /ask

  // diff — always multiple files
  diff: FileDiff[]

  // PR context
  pr: {
    number: number
    title: string
    description: string
    commit_messages: string[]
    base_branch: string
    head_sha: string
    previous_head_sha?: string // for /re-review delta
    repo: string               // "owner/repo"
  }

  // file contents
  changed_files: FileContent[]
  related_files: FileContent[] // 1-hop imports of changed files (cross-file analysis)

  // optional
  dependency_manifest?: string  // package.json / requirements.txt / go.mod
  existing_comments?: string[]  // for LLM deduplication

  // customer config
  llm_api_key: string
  llm_provider: 'anthropic' | 'openai' | 'google'

  // github auth
  installation_id: number
}

export type Severity = 'HOLD' | 'WARN' | 'SUGGEST' | 'PASS' | 'QUESTION'

export interface Finding {
  severity: Severity
  file?: string
  line?: number
  code?: string
  message: string
  remediation?: string
}

export interface AgentResult {
  agent: string
  findings: Finding[]
  metadata?: Record<string, unknown>
}

export interface InstallationConfig {
  api_key: string
  provider: 'anthropic' | 'openai' | 'google'
  email: string
  active: boolean
}
