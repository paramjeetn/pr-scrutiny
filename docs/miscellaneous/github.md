# GitHub API / Webhook Reference

Features used per phase. Updated only when a phase is confirmed done.

---

## Webhooks — Phase 7

Events we subscribe to: `pull_request`, `issue_comment`, `pull_request_review`, `pull_request_review_comment`.

### Key payload paths

**Slash command** (`issue_comment.created`):
- `body.comment.body` — command text (e.g. `/review`)
- `body.issue.pull_request` — present = comment is on a PR (not a plain issue)
- `body.issue.number` — PR number
- `body.comment.user.login` — commenter (for collaborator check)
- `body.repository.full_name` — `"owner/repo"`
- `body.installation.id` — installation ID → Firestore lookup key (GitHub App only)

**PR events** (`pull_request.*`):
- `body.pull_request.number`
- `body.pull_request.head.sha` — current head SHA
- `body.pull_request.base.ref` — base branch
- `body.pull_request.base.repo.full_name`
- `body.action` — `opened | closed | reopened | synchronize`
- `body.before` / `body.after` — old/new SHA on `synchronize` (for `/re-review` delta)

**Required headers**:
- `x-github-event` — event type
- `x-github-delivery` — unique delivery ID (idempotency key)
- `x-hub-signature-256` — HMAC-SHA256 of raw body with webhook secret (must validate before processing)

### PR number path differs by event type
| Event | PR number path |
|---|---|
| `pull_request` | `body.pull_request.number` |
| `issue_comment` | `body.issue.number` |
| `pull_request_review` | `body.pull_request.number` |

---

## Octokit — Phase 8

### GitHub App auth
JWT (signed with App private key) → POST `/app/installations/{id}/access_tokens` → Installation Access Token.
Token scoped to one installation, expires in 1h.

### Context Assembler API calls
- `GET /repos/{owner}/{repo}/pulls/{pull_number}/files` — changed files + patches
- `GET /repos/{owner}/{repo}/pulls/{pull_number}` — PR metadata (title, body, base/head SHAs, commits URL)
- `GET /repos/{owner}/{repo}/contents/{path}?ref={sha}` — file content at head SHA
- `GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1` — full repo file tree (for blast radius)

### Comment Poster API calls
- `POST /repos/{owner}/{repo}/issues/{issue_number}/comments` — post provisional comment + final top-level summary
- `POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews` — batch inline comments (single atomic POST)
- `DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}` — delete provisional comment after review posted
