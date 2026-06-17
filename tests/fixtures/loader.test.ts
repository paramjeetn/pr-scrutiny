import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { loadFixture } from '../../src/fixtures/loader.js'
import type { ReviewJob, FileDiff, FileContent } from '../../src/types/index.js'

const FIXTURE_DIR = resolve('tests/fixtures-data/pr-001-hardcoded-secret')

describe('loadFixture', () => {
  it('returns a ReviewJob with all required top-level fields', async () => {
    const job = await loadFixture(FIXTURE_DIR)

    expect(job).toMatchObject<Partial<ReviewJob>>({
      job_id: expect.any(String),
      command: 'review',
      pr: expect.any(Object),
      diff: expect.any(Array),
      changed_files: expect.any(Array),
      related_files: expect.any(Array),
      repo_tree: expect.any(Array),
      llm_provider: 'anthropic',
      llm_model: expect.any(String),
      installation_id: 0,
    })
  })

  it('job_id is a valid UUID', async () => {
    const job = await loadFixture(FIXTURE_DIR)
    expect(job.job_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
  })

  it('each call produces a unique job_id', async () => {
    const a = await loadFixture(FIXTURE_DIR)
    const b = await loadFixture(FIXTURE_DIR)
    expect(a.job_id).not.toBe(b.job_id)
  })

  it('PR fields parsed correctly from pr.json', async () => {
    const { pr } = await loadFixture(FIXTURE_DIR)
    expect(pr.number).toBe(42)
    expect(pr.title).toBe('Add user profile endpoint and update database utilities')
    expect(pr.repo).toBe('acme-corp/backend-api')
    expect(pr.head_sha).toBe('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2')
    expect(pr.commit_messages).toHaveLength(3)
    expect(pr.base_branch).toBe('main')
  })

  it('diff parsed from diff.patch — correct file count and shape', async () => {
    const { diff } = await loadFixture(FIXTURE_DIR)
    expect(diff.length).toBeGreaterThanOrEqual(3)

    for (const entry of diff) {
      expect(entry).toMatchObject<Partial<FileDiff>>({
        path: expect.any(String),
        additions: expect.any(Number),
        deletions: expect.any(Number),
        patch: expect.any(String),
      })
      expect(entry.additions).toBeGreaterThanOrEqual(0)
      expect(entry.deletions).toBeGreaterThanOrEqual(0)
    }
  })

  it('diff covers expected files', async () => {
    const { diff } = await loadFixture(FIXTURE_DIR)
    const paths = diff.map((d) => d.path)
    expect(paths).toContain('src/config.js')
    expect(paths).toContain('src/routes/users.js')
    expect(paths).toContain('src/utils/db.js')
  })

  it('changed_files loaded with path + content', async () => {
    const { changed_files } = await loadFixture(FIXTURE_DIR)
    expect(changed_files.length).toBeGreaterThan(0)

    for (const f of changed_files) {
      expect(f).toMatchObject<Partial<FileContent>>({
        path: expect.any(String),
        content: expect.any(String),
      })
      expect(f.content.length).toBeGreaterThan(0)
    }
  })

  it('changed_files includes expected files', async () => {
    const { changed_files } = await loadFixture(FIXTURE_DIR)
    const paths = changed_files.map((f) => f.path)
    expect(paths.some((p) => p.includes('config.js'))).toBe(true)
    expect(paths.some((p) => p.includes('users.js'))).toBe(true)
    expect(paths.some((p) => p.includes('db.js'))).toBe(true)
  })

  it('related_files loaded', async () => {
    const { related_files } = await loadFixture(FIXTURE_DIR)
    expect(related_files.length).toBeGreaterThan(0)
    expect(related_files[0]!.path).toMatch(/auth/)
  })

  it('repo_tree is a non-empty string array', async () => {
    const { repo_tree } = await loadFixture(FIXTURE_DIR)
    expect(repo_tree.length).toBeGreaterThan(0)
    expect(typeof repo_tree[0]).toBe('string')
  })

  it('dependency_manifest is populated', async () => {
    const { dependency_manifest } = await loadFixture(FIXTURE_DIR)
    expect(dependency_manifest).toBeTruthy()
    expect(dependency_manifest).toContain('express')
  })

  it('existing_comments is an array of strings', async () => {
    const { existing_comments } = await loadFixture(FIXTURE_DIR)
    expect(existing_comments).toBeDefined()
    expect(Array.isArray(existing_comments)).toBe(true)
    expect(existing_comments!.length).toBeGreaterThan(0)
  })

  it('command option is respected', async () => {
    const job = await loadFixture(FIXTURE_DIR, { command: 'summarize' })
    expect(job.command).toBe('summarize')
  })

  it('question option set for ask command', async () => {
    const job = await loadFixture(FIXTURE_DIR, {
      command: 'ask',
      question: 'What does this PR change?',
    })
    expect(job.command).toBe('ask')
    expect(job.question).toBe('What does this PR change?')
  })

  it('llm options can be overridden', async () => {
    const job = await loadFixture(FIXTURE_DIR, {
      llmProvider: 'openai',
      llmModel: 'gpt-4o',
      llmApiKey: 'sk-test-key',
    })
    expect(job.llm_provider).toBe('openai')
    expect(job.llm_model).toBe('gpt-4o')
    expect(job.llm_api_key).toBe('sk-test-key')
  })

  it('repo_config defaults to empty object', async () => {
    const job = await loadFixture(FIXTURE_DIR)
    expect(job.repo_config).toBeDefined()
    expect(typeof job.repo_config).toBe('object')
  })
})
