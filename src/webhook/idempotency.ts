/**
 * In-memory idempotency store for Phase 7 (local dev).
 * Phase 9 replaces this with Firestore-backed storage.
 *
 * Two checks:
 * 1. Webhook dedup: same X-GitHub-Delivery header → skip (24h TTL in prod)
 * 2. Job dedup: same (repo, prNumber, headSha) already running → skip
 */

const seenDeliveries = new Set<string>()
const activeJobs = new Set<string>()

export function isDeliverySeen(deliveryId: string): boolean {
  return seenDeliveries.has(deliveryId)
}

export function markDeliverySeen(deliveryId: string): void {
  seenDeliveries.add(deliveryId)
}

export function jobKey(repo: string, prNumber: number, headSha: string): string {
  return `${repo}:${prNumber}:${headSha}`
}

export function isJobActive(key: string): boolean {
  return activeJobs.has(key)
}

export function claimJob(key: string): void {
  activeJobs.add(key)
}

export function releaseJob(key: string): void {
  activeJobs.delete(key)
}

// For testing only
export function _reset(): void {
  seenDeliveries.clear()
  activeJobs.clear()
}
