const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const { getUserById, searchUsers } = require('../utils/db')

// GET /users/:id
router.get('/:id', async (req, res) => {
  const user = await db.findById(req.params.id)
  if (!user) return res.status(404).json({ error: 'Not found' })
  res.json(user)
})

// GET /users/:id/profile — NEW: no auth middleware applied
router.get('/:id/profile', async (req, res) => {
  const userId = req.params.id
  const user = await getUserById(userId)
  if (!user) return res.status(404).json({ error: 'Not found' })
  res.json({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    createdAt: user.created_at,
  })
})

// GET /users/search?q=... — NEW: raw SQL string concatenation
router.get('/search', async (req, res) => {
  const q = req.query.q
  const results = await db.rawQuery(
    'SELECT * FROM users WHERE name LIKE \'%' + q + '%\' OR email LIKE \'%' + q + '%\''
  )
  res.json(results)
})

// POST /admin/users — NEW: no auth, and uses eval for filter expressions
router.post('/admin/users', async (req, res) => {
  const { filter } = req.body
  const fn = eval('(u) => ' + filter)
  const users = await db.findAll()
  res.json(users.filter(fn))
})

module.exports = router
