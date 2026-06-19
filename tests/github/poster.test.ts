import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockCreateComment = vi.fn()
const mockDeleteComment = vi.fn()
const mockCreateReview = vi.fn()

vi.mock('octokit', () => ({
  Octokit: vi.fn().mockImplementation(() => ({
    rest: {
      issues: {
        createComment: mockCreateComment,
        deleteComment: mockDeleteComment,
      },
      pulls: {
        createReview: mockCreateReview,
      },
    },
  })),
}))

import { CommentPoster } from '../../src/github/poster.js'
import type { FormattedReview } from '../../src/orchestrator/formatter.js'

describe('CommentPoster', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateComment.mockResolvedValue({ data: { id: 101 } })
    mockDeleteComment.mockResolvedValue({})
    mockCreateReview.mockResolvedValue({})
  })

  it('throws on invalid repo format', () => {
    expect(() => new CommentPoster('token', 'notvalid')).toThrow('Invalid repo')
  })

  it('postProvisional posts a command-specific comment and returns its ID', async () => {
    const poster = new CommentPoster('token', 'acme/backend')
    const id = await poster.postProvisional(42, 'review')
    expect(id).toBe(101)
    expect(mockCreateComment).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 42, body: expect.stringContaining('reviewing') })
    )
  })

  it('postProvisional uses command-specific messages', async () => {
    const poster = new CommentPoster('token', 'acme/backend')
    await poster.postProvisional(42, 'summarize')
    expect(mockCreateComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('summarizing') })
    )
    vi.clearAllMocks()
    mockCreateComment.mockResolvedValue({ data: { id: 101 } })
    await poster.postProvisional(42, 'ask')
    expect(mockCreateComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('thinking') })
    )
    vi.clearAllMocks()
    mockCreateComment.mockResolvedValue({ data: { id: 101 } })
    await poster.postProvisional(42, 'blast-radius')
    expect(mockCreateComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('blast radius') })
    )
  })

  it('deleteComment calls GitHub delete API', async () => {
    const poster = new CommentPoster('token', 'acme/backend')
    await poster.deleteComment(101)
    expect(mockDeleteComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 101 })
    )
  })

  it('deleteComment failure is silent (non-fatal)', async () => {
    mockDeleteComment.mockRejectedValue(new Error('Not found'))
    const poster = new CommentPoster('token', 'acme/backend')
    // Should not throw
    await expect(poster.deleteComment(999)).resolves.toBeUndefined()
  })

  it('postSummary posts markdown and returns comment ID', async () => {
    const poster = new CommentPoster('token', 'acme/backend')
    const id = await poster.postSummary(42, '## Review\n\nLooks good!')
    expect(id).toBe(101)
    expect(mockCreateComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: '## Review\n\nLooks good!' })
    )
  })

  it('postInlineReview calls createReview with comments array', async () => {
    const poster = new CommentPoster('token', 'acme/backend')
    await poster.postInlineReview(42, 'sha123', [
      { path: 'src/config.js', line: 5, body: '🚫 **HOLD**: Hardcoded secret' },
      { path: 'src/routes/users.js', line: 12, body: '⚠️ **WARN**: Auth missing' },
    ])

    expect(mockCreateReview).toHaveBeenCalledWith(expect.objectContaining({
      pull_number: 42,
      commit_id: 'sha123',
      event: 'COMMENT',
      comments: expect.arrayContaining([
        expect.objectContaining({ path: 'src/config.js', line: 5 }),
        expect.objectContaining({ path: 'src/routes/users.js', line: 12 }),
      ]),
    }))
  })

  it('postInlineReview is skipped when no inline comments', async () => {
    const poster = new CommentPoster('token', 'acme/backend')
    await poster.postInlineReview(42, 'sha123', [])
    expect(mockCreateReview).not.toHaveBeenCalled()
  })

  it('postReview: posts inline review + summary, then deletes provisional', async () => {
    const poster = new CommentPoster('token', 'acme/backend')
    const review: FormattedReview = {
      inline: [{ path: 'src/config.js', line: 5, body: '🚫 **HOLD**: Secret' }],
      summary: '## PR Scrutiny Review\n\nFound 1 issue.',
    }

    await poster.postReview(42, 'sha123', review, 999)

    // summary only (provisional was posted externally)
    expect(mockCreateComment).toHaveBeenCalledTimes(1)
    // inline review
    expect(mockCreateReview).toHaveBeenCalledTimes(1)
    // provisional deleted
    expect(mockDeleteComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 999 }))
  })

  it('postReview: inline failure does not prevent summary posting', async () => {
    mockCreateReview.mockRejectedValue(new Error('line out of range'))
    const poster = new CommentPoster('token', 'acme/backend')
    const review: FormattedReview = {
      inline: [{ path: 'src/file.js', line: 999, body: 'comment' }],
      summary: '## PR Scrutiny Review\n\nFound issues.',
    }

    await poster.postReview(42, 'sha123', review, 101)

    // Summary still posted despite inline failure
    expect(mockCreateComment).toHaveBeenCalledTimes(1)  // summary only
    expect(mockDeleteComment).toHaveBeenCalledTimes(1)
  })

  it('postReview with no inline comments skips createReview', async () => {
    const poster = new CommentPoster('token', 'acme/backend')
    const review: FormattedReview = {
      inline: [],
      summary: '## PR Scrutiny Review\n\nAll clear.',
    }

    await poster.postReview(42, 'sha123', review, 101)

    expect(mockCreateReview).not.toHaveBeenCalled()
    expect(mockCreateComment).toHaveBeenCalledTimes(1)  // summary only
  })
})
