# GCP Services Reference

Features used per phase. Updated only when a phase is confirmed done.

---

## Cloud Run
Runtime for the webhook server. Scales to zero. Concurrency set to 1 (isolates jobs). No CPU time limit — needed for static analysis on large diffs.
_Used from: Phase 7 (server) onwards._

## Firestore
Document store for installation configs, job state, idempotency keys, CVE cache.
Collections: `installations/{id}`, `jobs/{repo}:{pr}:{sha}`, `idempotency/{delivery_id}`, `cve_cache/{pkg}:{version}`.
TTLs: jobs 4h, idempotency 24h, CVE cache 6h, installations permanent.
_Used from: Phase 9 onwards._

## Secret Manager
Stores GitHub App private key and webhook secret. Fetched at server startup.
_Used from: Phase 7 onwards._

## KMS
Encrypts customer API keys before writing to Firestore. Decrypts on read.
_Used from: Phase 9 onwards._

## Cloud Logging
Structured JSON logs per request and per job. Every JobTrace written here.
_Used from: Phase 7 onwards._

## Cloud Build
CI/CD pipeline: builds Docker image, pushes to Artifact Registry, deploys to Cloud Run.
_Used from: Phase 10 onwards._
