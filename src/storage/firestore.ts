import { Firestore } from '@google-cloud/firestore'

let _db: Firestore | null = null

export function getDb(): Firestore {
  if (!_db) {
    _db = new Firestore({
      projectId: process.env['GCP_PROJECT_ID'],
      // In Cloud Run: uses Application Default Credentials automatically.
      // Locally: set GOOGLE_APPLICATION_CREDENTIALS env var to a service account key file.
    })
  }
  return _db
}

// For tests — inject a mock Firestore instance
export function _setDb(db: Firestore) { _db = db }
export function _resetDb() { _db = null }
