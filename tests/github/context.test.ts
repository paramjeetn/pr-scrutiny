import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReviewJob } from '../../src/types/index.js'

// ─── Mock octokit before importing context assembler ─────────────────────────

const mockGetPR = vi.fn()
const mockListFiles = vi.fn()
const mockGetContent = vi.fn()
const mockGetTree = vi.fn()
const mockListComments = vi.fn()
const mockListCommits = vi.fn()

vi.mock('octokit', () => ({
  Octokit: vi.fn().mockImplementation(() => ({
    rest: {
      pulls: {
        get: mockGetPR,
        listFiles: mockListFiles,
        listCommits: mockListCommits,
        createReview: vi.fn().mockResolvedValue({}),
      },
      repos: { getContent: mockGetContent },
      git: { getTree: mockGetTree },
      issues: {
        listComments: mockListComments,
        createComment: vi.fn().mockResolvedValue({ data: { id: 99 } }),
        deleteComment: vi.fn().mockResolvedValue({}),
      },
    },
  })),
}))

import { assembleContext } from '../../src/github/context.js'

// ─── Fixture data ─────────────────────────────────────────────────────────────

function makePRResponse() {
  return {
    data: {
      number: 42,
      title: 'Add user profile endpoint',
      body: 'Adds GET /users/:id/profile',
      head: { sha: 'abc123def456' },
      base: { ref: 'main' },
    },
  }
}

function makeFilesResponse(files = [
  { filename: 'src/routes/users.js', additions: 20, deletions: 5, patch: '@@ -1,5 +1,20 @@\n+const router = require("express").Router()', status: 'modified' },
  { filename: 'src/utils/db.js', additions: 10, deletions: 2, patch: '@@ -1,2 +1,10 @@\n+const pool = require("pg").Pool', status: 'modified' },
]) {
  return { data: files }
}

function makeTreeResponse(paths = ['src/routes/users.js', 'src/utils/db.js', 'src/middleware/auth.js']) {
  return {
    data: {
      tree: paths.map((p) => ({ type: 'blob', path: p })),
    },
  }
}

function makeContentResponse(content: string) {
  return {
    data: {
      encoding: 'base64',
      content: Buffer.from(content).toString('base64'),
    },
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Context Assembler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetPR.mockResolvedValue(makePRResponse())
    mockListFiles.mockResolvedValue(makeFilesResponse())
    mockGetTree.mockResolvedValue(makeTreeResponse())
    mockListComments.mockResolvedValue({ data: [] })
    mockListCommits.mockResolvedValue({ data: [
      { commit: { message: 'Add profile endpoint' } },
    ]})
    mockGetContent.mockResolvedValue(makeContentResponse('// file content'))
  })

  it('returns a valid ReviewJob shape', async () => {
    const job = await assembleContext('acme/backend', 42, {
      command: 'review',
      installationToken: 'token-123',
      llmApiKey: 'sk-fake',
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
    })

    expect(job.job_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(job.command).toBe('review')
    expect(job.pr.number).toBe(42)
    expect(job.pr.title).toBe('Add user profile endpoint')
    expect(job.pr.repo).toBe('acme/backend')
    expect(job.pr.head_sha).toBe('abc123def456')
    expect(job.pr.base_branch).toBe('main')
    expect(Array.isArray(job.diff)).toBe(true)
    expect(Array.isArray(job.changed_files)).toBe(true)
    expect(Array.isArray(job.repo_tree)).toBe(true)
  })

  it('diff maps GitHub files to FileDiff shape', async () => {
    const job = await assembleContext('acme/backend', 42, {
      command: 'review',
      installationToken: 'token-123',
      llmApiKey: 'sk-fake',
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
    })

    expect(job.diff[0]!.path).toBe('src/routes/users.js')
    expect(job.diff[0]!.additions).toBe(20)
    expect(job.diff[0]!.deletions).toBe(5)
    expect(typeof job.diff[0]!.patch).toBe('string')
  })

  it('fetches file content for changed files', async () => {
    const job = await assembleContext('acme/backend', 42, {
      command: 'review',
      installationToken: 'token-123',
      llmApiKey: 'sk-fake',
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
    })

    expect(job.changed_files.length).toBeGreaterThan(0)
    expect(job.changed_files[0]!.content).toBe('// file content')
  })

  it('includes repo tree from git tree API', async () => {
    const job = await assembleContext('acme/backend', 42, {
      command: 'review',
      installationToken: 'token-123',
      llmApiKey: 'sk-fake',
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
    })

    expect(job.repo_tree).toContain('src/routes/users.js')
    expect(job.repo_tree).toContain('src/utils/db.js')
  })

  it('includes commit messages', async () => {
    const job = await assembleContext('acme/backend', 42, {
      command: 'review',
      installationToken: 'token-123',
      llmApiKey: 'sk-fake',
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
    })

    expect(job.pr.commit_messages).toContain('Add profile endpoint')
  })

  it('caps files at MAX_FILES (25) when repo has many changed files', async () => {
    const manyFiles = Array.from({ length: 30 }, (_, i) => ({
      filename: `src/file${i}.js`,
      additions: 1,
      deletions: 0,
      patch: '+const x = 1',
      status: 'modified',
    }))
    mockListFiles.mockResolvedValue({ data: manyFiles })

    const job = await assembleContext('acme/backend', 42, {
      command: 'review',
      installationToken: 'token-123',
      llmApiKey: 'sk-fake',
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
    })

    expect(job.diff.length).toBeLessThanOrEqual(25)
  })

  it('prioritizes security-sensitive files when capping', async () => {
    const files = [
      ...Array.from({ length: 20 }, (_, i) => ({
        filename: `src/component${i}.js`, additions: 1, deletions: 0, patch: '', status: 'modified',
      })),
      { filename: 'src/config/secrets.js', additions: 5, deletions: 0, patch: '', status: 'modified' },
      { filename: '.env.production', additions: 2, deletions: 0, patch: '', status: 'modified' },
      { filename: 'src/auth/jwt.js', additions: 3, deletions: 0, patch: '', status: 'modified' },
      { filename: 'src/utils/password.js', additions: 1, deletions: 0, patch: '', status: 'modified' },
      { filename: 'src/misc/helper.js', additions: 1, deletions: 0, patch: '', status: 'modified' },
      { filename: 'src/misc/util.js', additions: 1, deletions: 0, patch: '', status: 'modified' },
    ]
    mockListFiles.mockResolvedValue({ data: files })

    const job = await assembleContext('acme/backend', 42, {
      command: 'review',
      installationToken: 'token-123',
      llmApiKey: 'sk-fake',
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
    })

    const paths = job.diff.map((d) => d.path)
    expect(paths).toContain('src/config/secrets.js')
    expect(paths).toContain('.env.production')
    expect(paths).toContain('src/auth/jwt.js')
  })

  it('handles git tree fetch failure gracefully (non-fatal)', async () => {
    mockGetTree.mockRejectedValue(new Error('Tree too large'))

    const job = await assembleContext('acme/backend', 42, {
      command: 'review',
      installationToken: 'token-123',
      llmApiKey: 'sk-fake',
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
    })

    // Should still return a job, just with empty tree
    expect(job).toBeDefined()
    expect(job.repo_tree).toEqual([])
  })

  it('passes through question for /ask command', async () => {
    const job = await assembleContext('acme/backend', 42, {
      command: 'ask',
      question: 'What does db.js export?',
      installationToken: 'token-123',
      llmApiKey: 'sk-fake',
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
    })

    expect(job.command).toBe('ask')
    expect(job.question).toBe('What does db.js export?')
  })

  it('throws on invalid repo format', async () => {
    await expect(
      assembleContext('not-a-valid-repo', 1, {
        command: 'review',
        installationToken: 'tok',
        llmApiKey: '',
        llmProvider: 'openai',
        llmModel: 'gpt-4o-mini',
      })
    ).rejects.toThrow('Invalid repo')
  })
})
