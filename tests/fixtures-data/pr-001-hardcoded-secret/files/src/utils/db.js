const { Pool } = require('pg')
const config = require('../config')

const pool = new Pool({
  host: config.db.host,
  password: config.db.password,
  database: 'appdb',
})

async function findById(id) {
  const res = await pool.query('SELECT * FROM users WHERE id = $1', [id])
  return res.rows[0] || null
}

async function getUserById(id) {
  return findById(id)
}

async function findAll() {
  const res = await pool.query('SELECT * FROM users')
  return res.rows
}

async function rawQuery(sql) {
  const res = await pool.query(sql)
  return res.rows
}

async function searchUsers(term) {
  // N+1: fetches each user individually inside a loop
  const ids = await pool.query('SELECT id FROM users WHERE active = true')
  const results = []
  for (const row of ids.rows) {
    const user = await findById(row.id)
    if (user && (user.name.includes(term) || user.email.includes(term))) {
      results.push(user)
    }
  }
  return results
}

// Complexity: deeply nested, high cyclomatic complexity
async function processUserBatch(users, options) {
  const out = []
  for (const user of users) {
    if (user.active) {
      if (user.role === 'admin') {
        if (options.includeAdmins) {
          if (user.verified) {
            if (options.strictMode) {
              if (user.mfaEnabled) {
                out.push({ ...user, tier: 'verified-admin-mfa' })
              } else {
                out.push({ ...user, tier: 'verified-admin' })
              }
            } else {
              out.push({ ...user, tier: 'admin' })
            }
          } else if (options.allowUnverified) {
            out.push({ ...user, tier: 'unverified-admin' })
          }
        }
      } else if (user.role === 'moderator') {
        if (options.includeModerators) {
          out.push({ ...user, tier: 'moderator' })
        }
      } else {
        out.push({ ...user, tier: 'user' })
      }
    }
  }
  return out
}

module.exports = { findById, getUserById, findAll, rawQuery, searchUsers, processUserBatch }
