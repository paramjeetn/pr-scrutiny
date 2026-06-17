import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { loadFixture } from '../../src/fixtures/loader.js'
import { runBlastRadiusAgent } from '../../src/agents/blast-radius/index.js'
import { extractImports, resolveInTree } from '../../src/agents/blast-radius/parser.js'
import { buildImportGraph, buildReverseGraph, traverseAffected } from '../../src/agents/blast-radius/graph.js'
import { classify } from '../../src/agents/blast-radius/classify.js'
import type { ReviewJob, BlastRadiusMetadata } from '../../src/types/index.js'

const FIXTURE_DIR = resolve('tests/fixtures-data/pr-001-hardcoded-secret')

// ─── Parser ────────────────────────────────────────────────────────────────────

describe('Import parser', () => {
  it('extracts require() paths from JS', () => {
    const imports = extractImports('src/routes/users.js', `
const express = require('express')
const db = require('../utils/db')
const { auth } = require('../middleware/auth')
`)
    expect(imports).toContain('src/utils/db')
    expect(imports).toContain('src/middleware/auth')
    // node_modules (no relative path) should be excluded
    expect(imports).not.toContain('express')
  })

  it('extracts ES import statements from TS', () => {
    const imports = extractImports('src/services/user.ts', `
import { Router } from 'express'
import { db } from '../utils/db'
import type { User } from '../models/User'
`)
    expect(imports).toContain('src/utils/db')
    expect(imports).toContain('src/models/User')
    expect(imports).not.toContain('express')
  })

  it('handles path resolution correctly', () => {
    const imports = extractImports('src/routes/users.js', `
const db = require('../utils/db')
`)
    // ../utils/db from src/routes/ resolves to src/utils/db
    expect(imports).toContain('src/utils/db')
  })

  it('returns empty for non-relative imports only', () => {
    const imports = extractImports('src/index.ts', `
import express from 'express'
import { Pool } from 'pg'
`)
    expect(imports).toHaveLength(0)
  })
})

// ─── resolveInTree ─────────────────────────────────────────────────────────────

describe('resolveInTree', () => {
  const tree = [
    'src/utils/db.js',
    'src/routes/users.js',
    'src/middleware/auth.js',
    'src/index.ts',
  ]

  it('exact match', () => {
    expect(resolveInTree('src/utils/db.js', tree)).toBe('src/utils/db.js')
  })

  it('match by adding extension', () => {
    expect(resolveInTree('src/utils/db', tree)).toBe('src/utils/db.js')
  })

  it('returns null for unresolvable path', () => {
    expect(resolveInTree('src/nonexistent', tree)).toBeNull()
  })
})

// ─── Graph traversal ───────────────────────────────────────────────────────────

describe('Import graph traversal', () => {
  it('changing db.js finds all direct importers', async () => {
    const job = await loadFixture(FIXTURE_DIR)
    const allFiles = [...job.changed_files, ...job.related_files]
    const graph = buildImportGraph(allFiles, job.repo_tree)
    const reverse = buildReverseGraph(graph)

    // db.js is imported by routes/users.js
    const affected = traverseAffected(['src/utils/db.js'], reverse, job.repo_tree, 2)
    expect(affected.has('src/utils/db.js')).toBe(true)
    // users.js imports db.js — should be in affected set
    expect(affected.has('src/routes/users.js')).toBe(true)
  })

  it('changed files are always in affected set', async () => {
    const job = await loadFixture(FIXTURE_DIR)
    const allFiles = [...job.changed_files, ...job.related_files]
    const graph = buildImportGraph(allFiles, job.repo_tree)
    const reverse = buildReverseGraph(graph)
    const changed = job.diff.map((d) => d.path)

    const affected = traverseAffected(changed, reverse, job.repo_tree, 2)
    for (const f of changed) {
      expect(affected.has(f)).toBe(true)
    }
  })

  it('handles large repo tree in under 2s', () => {
    // Generate 600-file repo tree
    const largeTree: string[] = []
    for (let i = 0; i < 600; i++) {
      largeTree.push(`src/module${i}/index.ts`)
    }
    largeTree.push('src/utils/db.ts')

    const files = [{ path: 'src/utils/db.ts', content: "export const db = {}" }]
    const graph = buildImportGraph(files, largeTree)
    const reverse = buildReverseGraph(graph)

    const start = Date.now()
    traverseAffected(['src/utils/db.ts'], reverse, largeTree, 2)
    expect(Date.now() - start).toBeLessThan(2000)
  })
})

// ─── Classifier ────────────────────────────────────────────────────────────────

describe('Classifier', () => {
  it('detects config changes', () => {
    const meta = classify(
      ['src/config.js', 'src/routes/users.js'],
      new Set(['src/config.js', 'src/routes/users.js']),
      ['src/config.js', 'src/routes/users.js'],
      2
    )
    expect(meta.config_changes).toBe(true)
  })

  it('identifies missing test files', () => {
    const meta = classify(
      ['src/utils/db.js'],
      new Set(['src/utils/db.js']),
      ['src/utils/db.js'],  // no test file in tree
      2
    )
    expect(meta.missing_tests).toContain('src/utils/db.js')
  })

  it('does not flag missing tests when test exists', () => {
    const meta = classify(
      ['src/utils/email.js'],
      new Set(['src/utils/email.js']),
      ['src/utils/email.js', 'tests/utils/email.test.js'],
      2
    )
    expect(meta.missing_tests).not.toContain('src/utils/email.js')
  })

  it('detects route files in affected set', () => {
    const meta = classify(
      ['src/utils/db.js'],
      new Set(['src/utils/db.js', 'src/routes/users.js']),
      ['src/utils/db.js', 'src/routes/users.js'],
      2
    )
    expect(meta.affected_routes).toContain('src/routes/users.js')
  })

  it('detects migration files', () => {
    const meta = classify(
      ['migrations/V2__add_users_table.sql'],
      new Set(['migrations/V2__add_users_table.sql']),
      ['migrations/V2__add_users_table.sql'],
      2
    )
    expect(meta.migration_files).toContain('migrations/V2__add_users_table.sql')
  })
})

// ─── Full agent ────────────────────────────────────────────────────────────────

describe('BlastRadiusAgent — full run', () => {
  it('returns valid AgentResult shape', async () => {
    const job = await loadFixture(FIXTURE_DIR)
    const result = await runBlastRadiusAgent(job)

    expect(result.agent).toBe('BlastRadiusAgent')
    expect(Array.isArray(result.findings)).toBe(true)
    expect(result.trace).toMatchObject({
      agent: 'BlastRadiusAgent',
      started_at: expect.any(String),
      duration_ms: expect.any(Number),
      finding_count: expect.any(Number),
      timed_out: false,
    })
    expect(result.trace.finding_count).toBe(result.findings.length)
  })

  it('metadata has BlastRadiusMetadata shape', async () => {
    const job = await loadFixture(FIXTURE_DIR)
    const result = await runBlastRadiusAgent(job)
    const meta = result.metadata as BlastRadiusMetadata

    expect(Array.isArray(meta.affected_files)).toBe(true)
    expect(Array.isArray(meta.missing_tests)).toBe(true)
    expect(Array.isArray(meta.affected_routes)).toBe(true)
    expect(Array.isArray(meta.migration_files)).toBe(true)
    expect(typeof meta.config_changes).toBe('boolean')
    expect(typeof meta.hop_count).toBe('number')
  })

  it('affected_files includes all changed files', async () => {
    const job = await loadFixture(FIXTURE_DIR)
    const result = await runBlastRadiusAgent(job)
    const meta = result.metadata as BlastRadiusMetadata
    const changedPaths = job.diff.map((d) => d.path)

    for (const p of changedPaths) {
      expect(meta.affected_files).toContain(p)
    }
  })

  it('detects config change from src/config.js', async () => {
    const job = await loadFixture(FIXTURE_DIR)
    const result = await runBlastRadiusAgent(job)
    const meta = result.metadata as BlastRadiusMetadata
    expect(meta.config_changes).toBe(true)
  })

  it('flags missing tests for changed files', async () => {
    const job = await loadFixture(FIXTURE_DIR)
    const result = await runBlastRadiusAgent(job)
    const meta = result.metadata as BlastRadiusMetadata
    // db.js has no test file in repo-tree.json
    expect(meta.missing_tests.length).toBeGreaterThan(0)
  })

  it('all findings have severity + message', async () => {
    const job = await loadFixture(FIXTURE_DIR)
    const result = await runBlastRadiusAgent(job)
    for (const f of result.findings) {
      expect(f.severity).toMatch(/^(HOLD|WARN|SUGGEST|PASS|QUESTION)$/)
      expect(f.message).toBeTruthy()
    }
  })

  it('trace duration is non-negative', async () => {
    const job = await loadFixture(FIXTURE_DIR)
    const result = await runBlastRadiusAgent(job)
    expect(result.trace.duration_ms).toBeGreaterThanOrEqual(0)
  })
})
