// Auth middleware — applied to protected routes only
// NOTE: The new /profile and /admin/users routes do NOT use this middleware.

const jwt = require('jsonwebtoken')

function requireAuth(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1]
  if (!token) return res.status(401).json({ error: 'Unauthorized' })

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET)
    req.user = payload
    next()
  } catch {
    res.status(401).json({ error: 'Invalid token' })
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' })
  }
  next()
}

module.exports = { requireAuth, requireAdmin }
