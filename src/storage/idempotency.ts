import { getDb } from './firestore.js'
import { Timestamp, FieldValue } from '@google-cloud/firestore'

const DELIVERY_COLLECTION = 'idempotency'
const JOB_COLLECTION      = 'active_jobs'

const DELIVERY_TTL_MS = 24 * 60 * 60 * 1000  // 24 hours
const JOB_TTL_MS      = 4  * 60 * 60 * 1000  // 4 hours (max job runtime)

function expiresAt(ttlMs: number): Timestamp {
  return Timestamp.fromDate(new Date(Date.now() + ttlMs))
}

/**
 * Returns true if this delivery ID is new (not seen before) and claims it.
 * Returns false if already seen (duplicate webhook delivery).
 * Uses Firestore transaction for atomicity.
 */
export async function checkAndClaimDelivery(deliveryId: string): Promise<boolean> {
  const ref = getDb().collection(DELIVERY_COLLECTION).doc(deliveryId)

  return getDb().runTransaction(async (tx) => {
    const doc = await tx.get(ref)
    if (doc.exists) return false  // already seen

    tx.set(ref, {
      claimed_at: FieldValue.serverTimestamp(),
      expires_at: expiresAt(DELIVERY_TTL_MS),
    })
    return true
  })
}

export function jobKey(repo: string, prNumber: number, sha: string): string {
  return `${repo}:${prNumber}:${sha}`
}

/**
 * Returns true if this job key is new (not active) and claims it.
 * Returns false if already running.
 */
export async function checkAndClaimJob(key: string): Promise<boolean> {
  const ref = getDb().collection(JOB_COLLECTION).doc(key)

  return getDb().runTransaction(async (tx) => {
    const doc = await tx.get(ref)
    if (doc.exists) {
      // Check if the existing claim has expired (stale lock)
      const data = doc.data()!
      const expires = (data['expires_at'] as Timestamp).toDate()
      if (expires > new Date()) return false  // still active
    }

    tx.set(ref, {
      claimed_at: FieldValue.serverTimestamp(),
      expires_at: expiresAt(JOB_TTL_MS),
    })
    return true
  })
}

export async function releaseJob(key: string): Promise<void> {
  await getDb().collection(JOB_COLLECTION).doc(key).delete()
}
