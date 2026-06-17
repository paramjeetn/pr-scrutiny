import type { AgentResult, JobTrace } from '../types/index.js'
import { getDb } from './firestore.js'
import { Timestamp, FieldValue } from '@google-cloud/firestore'

const FINDINGS_COLLECTION = 'jobs'
const TRACES_COLLECTION   = 'traces'

// TTLs
const FINDINGS_TTL_MS = 4  * 60 * 60 * 1000  // 4 hours
const TRACES_TTL_MS   = 7  * 24 * 60 * 60 * 1000  // 7 days

function expiresAt(ttlMs: number): Timestamp {
  return Timestamp.fromDate(new Date(Date.now() + ttlMs))
}

export async function saveFindings(jobKey: string, results: AgentResult[]): Promise<void> {
  await getDb().collection(FINDINGS_COLLECTION).doc(jobKey).set({
    results: JSON.stringify(results),
    expires_at: expiresAt(FINDINGS_TTL_MS),
    saved_at: FieldValue.serverTimestamp(),
  })
}

export async function getFindings(jobKey: string): Promise<AgentResult[] | null> {
  const doc = await getDb().collection(FINDINGS_COLLECTION).doc(jobKey).get()
  if (!doc.exists) return null

  const data = doc.data()!
  // Check TTL manually (Firestore TTL deletion is eventually consistent)
  if (data['expires_at'] && (data['expires_at'] as Timestamp).toDate() < new Date()) {
    return null
  }

  return JSON.parse(data['results'] as string) as AgentResult[]
}

export async function saveTrace(jobId: string, trace: JobTrace): Promise<void> {
  await getDb().collection(TRACES_COLLECTION).doc(jobId).set({
    trace: JSON.stringify(trace),
    expires_at: expiresAt(TRACES_TTL_MS),
    saved_at: FieldValue.serverTimestamp(),
  })
}

export async function getTrace(jobId: string): Promise<JobTrace | null> {
  const doc = await getDb().collection(TRACES_COLLECTION).doc(jobId).get()
  if (!doc.exists) return null
  return JSON.parse(doc.data()!['trace'] as string) as JobTrace
}
