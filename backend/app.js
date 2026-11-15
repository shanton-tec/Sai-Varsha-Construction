import bcrypt from 'bcryptjs'
import cors from 'cors'
import express from 'express'
import helmet from 'helmet'
import { rateLimit } from 'express-rate-limit'
import { body, param, query } from 'express-validator'
import {
  createAuthMiddleware,
  issueToken,
  loginValidation,
  optionalAuth,
  registerValidation,
  requireAdmin,
  validate
} from './auth.js'

const ENQUIRY_STATUSES = ['new', 'contacted', 'in_progress', 'closed']
const PROJECT_STATUSES = ['planning', 'in_progress', 'on_hold', 'completed']
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('nonexistent-account-password', 12)
const optionalTrimmedString = (field, max, label) =>
  body(field).optional().isString().trim().isLength({ max }).withMessage(`${label} must be at most ${max} characters.`)

export function createApp(db) {
  if (!db) throw new Error('A PostgreSQL database pool is required.')

  const app = express()
  const authenticate = createAuthMiddleware(db)
  const authenticateIfPresent = optionalAuth(authenticate)
  const allowedOrigins = new Set(
    (process.env.CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
      .split(',')
      .map(origin => origin.trim())
      .filter(Boolean)
  )

  app.disable('x-powered-by')
  app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false)
  app.use(helmet())
  app.use(cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) return callback(null, true)
      return callback(new Error('Origin is not allowed by CORS.'))
    }
  }))
  app.use(express.json({ limit: '16kb', strict: true }))

  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: 'draft-8',
    legacyHeaders: false
  })
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many authentication attempts. Try again later.' }
  })
  const enquiryLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many enquiry submissions. Try again later.' }
  })

  app.use('/api', apiLimiter)

  app.get('/api/health', async (_req, res, next) => {
    try {
      await db.query('select 1')
      return res.json({ ok: true, database: 'connected' })
    } catch (error) {
      console.error('Health check could not query PostgreSQL:', error)
      return res.status(503).json({ ok: false, database: 'disconnected' })
    }
  })

  app.post('/api/auth/register', authLimiter, registerValidation, validate, async (req, res, next) => {
    try {
      const { name, email, password } = req.body
      const passwordHash = await bcrypt.hash(password, 12)
      const result = await db.query(
        `insert into construction.users (name, email, password_hash)
         values ($1, $2, $3)
         returning id, name, email, role`,
        [name, email, passwordHash]
      )
      const user = result.rows[0]
      return res.status(201).json({ user, token: issueToken(user) })
    } catch (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'An account with this email already exists.' })
      }
      return next(error)
    }
  })

  app.post('/api/auth/login', authLimiter, loginValidation, validate, async (req, res, next) => {
    try {
      const { email, password } = req.body
      const result = await db.query(
        'select id, name, email, role, password_hash from construction.users where email = $1',
        [email]
      )
      const user = result.rows[0]
      const passwordMatches = await bcrypt.compare(password, user?.password_hash || DUMMY_PASSWORD_HASH)
      if (!user || !passwordMatches) {
        return res.status(401).json({ error: 'Invalid email or password.' })
      }
      delete user.password_hash
      return res.json({ user, token: issueToken(user) })
    } catch (error) {
      return next(error)
    }
  })

  app.get('/api/auth/me', authenticate, (req, res) => res.json({ user: req.user }))

  app.post('/api/enquiries', enquiryLimiter, authenticateIfPresent, [
    body('name').trim().isLength({ min: 1, max: 120 }),
    body('phone').trim().isLength({ min: 5, max: 40 }),
    body('location').optional().isString().trim().isLength({ max: 120 }),
    body('plot_size').optional().isString().trim().isLength({ max: 120 }),
    body('message').optional().isString().trim().isLength({ max: 5000 })
  ], validate, async (req, res, next) => {
    try {
      const { name, phone, location = '', plot_size = '', message = '' } = req.body
      const customerEmail = req.user?.email || null
      const result = await db.query(
        `insert into construction.enquiries
           (name, phone, customer_email, location, plot_size, message)
         values ($1, $2, $3, $4, $5, $6)
         returning id, name, phone, customer_email, location, plot_size, message, status, created_at, updated_at`,
        [name, phone, customerEmail, location, plot_size, message]
      )
      return res.status(201).json({ enquiry: result.rows[0] })
    } catch (error) {
      return next(error)
    }
  })

  app.get('/api/enquiries', authenticate, requireAdmin, [
    query('status').optional().isIn(ENQUIRY_STATUSES)
  ], validate, async (req, res, next) => {
    try {
      const result = req.query.status
        ? await db.query(
          `select id, name, phone, customer_email, location, plot_size, message, status, created_at, updated_at
           from construction.enquiries where status = $1 order by created_at desc`,
          [req.query.status]
        )
        : await db.query(
          `select id, name, phone, customer_email, location, plot_size, message, status, created_at, updated_at
           from construction.enquiries order by created_at desc`
        )
      return res.json({ enquiries: result.rows })
    } catch (error) {
      return next(error)
    }
  })

  app.patch('/api/enquiries/:id', authenticate, requireAdmin, [
    param('id').isInt({ min: 1 }),
    body('status').isIn(ENQUIRY_STATUSES).withMessage(`Status must be one of: ${ENQUIRY_STATUSES.join(', ')}.`)
  ], validate, async (req, res, next) => {
    try {
      const result = await db.query(
        `update construction.enquiries set status = $1, updated_at = now()
         where id = $2
         returning id, name, phone, customer_email, location, plot_size, message, status, created_at, updated_at`,
        [req.body.status, req.params.id]
      )
      if (!result.rowCount) return res.status(404).json({ error: 'Enquiry not found.' })
      return res.json({ enquiry: result.rows[0] })
    } catch (error) {
      return next(error)
    }
  })

  app.get('/api/projects', authenticate, async (req, res, next) => {
    try {
      const result = req.user.role === 'admin'
        ? await db.query(
          `select p.id, p.project_name, p.customer_email, p.location, p.status, p.progress,
                  p.estimated_cost, p.next_milestone, p.created_at, p.updated_at
           from construction.projects p order by p.updated_at desc`
        )
        : await db.query(
          `select p.id, p.project_name, p.customer_email, p.location, p.status, p.progress,
                  p.estimated_cost, p.next_milestone, p.created_at, p.updated_at
           from construction.projects p
           where p.customer_email = $1
           order by p.updated_at desc`,
          [req.user.email]
        )
      return res.json({ projects: result.rows })
    } catch (error) {
      return next(error)
    }
  })

  app.post('/api/projects', authenticate, requireAdmin, [
    body('project_name').trim().isLength({ min: 1, max: 160 }),
    body('customer_email').trim().isEmail().normalizeEmail(),
    body('location').trim().isLength({ min: 1, max: 200 }),
    body('status').optional().isIn(PROJECT_STATUSES),
    body('progress').optional().isInt({ min: 0, max: 100 }).toInt(),
    body('estimated_cost').optional({ values: 'null' }).isFloat({ min: 0, max: 999999999999.99 }).toFloat(),
    body('next_milestone').optional({ values: 'falsy' }).isString().trim().isLength({ max: 240 })
  ], validate, async (req, res, next) => {
    try {
      const {
        project_name, customer_email, location, status = 'planning',
        progress = 0, estimated_cost = null, next_milestone = ''
      } = req.body
      const result = await db.query(
        `insert into construction.projects
           (project_name, customer_email, location, status, progress, estimated_cost, next_milestone)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning id, project_name, customer_email, location, status, progress, estimated_cost, next_milestone, created_at, updated_at`,
        [project_name, customer_email, location, status, progress, estimated_cost, next_milestone]
      )
      return res.status(201).json({ project: result.rows[0] })
    } catch (error) {
      if (error.code === '23503') {
        return res.status(400).json({ error: 'Create a customer account with this email before assigning a project.' })
      }
      return next(error)
    }
  })

  app.patch('/api/projects/:id', authenticate, requireAdmin, [
    param('id').isInt({ min: 1 }),
    body('project_name').optional().trim().isLength({ min: 1, max: 160 }),
    body('customer_email').optional().trim().isEmail().normalizeEmail(),
    body('location').optional().trim().isLength({ min: 1, max: 200 }),
    body('status').optional().isIn(PROJECT_STATUSES),
    body('progress').optional().isInt({ min: 0, max: 100 }).toInt(),
    body('estimated_cost').optional({ values: 'null' }).isFloat({ min: 0, max: 999999999999.99 }).toFloat(),
    optionalTrimmedString('next_milestone', 240, 'Next milestone')
  ], validate, async (req, res, next) => {
    const allowedFields = ['project_name', 'customer_email', 'location', 'status', 'progress', 'estimated_cost', 'next_milestone']
    const fields = allowedFields.filter(field => Object.hasOwn(req.body, field))
    if (!fields.length) return res.status(400).json({ error: 'Provide at least one project field to update.' })

    try {
      const assignments = fields.map((field, index) => `${field} = $${index + 1}`)
      const values = fields.map(field => req.body[field] === '' && field === 'next_milestone' ? '' : req.body[field])
      values.push(req.params.id)
      const result = await db.query(
        `update construction.projects
         set ${assignments.join(', ')}, updated_at = now()
         where id = $${values.length}
         returning id, project_name, customer_email, location, status, progress, estimated_cost, next_milestone, created_at, updated_at`,
        values
      )
      if (!result.rowCount) return res.status(404).json({ error: 'Project not found.' })
      return res.json({ project: result.rows[0] })
    } catch (error) {
      if (error.code === '23503') {
        return res.status(400).json({ error: 'Create a customer account with this email before assigning a project.' })
      }
      return next(error)
    }
  })

  app.get('/api/admin/summary', authenticate, requireAdmin, async (_req, res, next) => {
    try {
      const [users, enquiries, projects] = await Promise.all([
        db.query("select count(*)::int as count from construction.users where role = 'customer'"),
        db.query('select count(*)::int as count from construction.enquiries'),
        db.query('select count(*)::int as count from construction.projects')
      ])
      return res.json({
        customers: users.rows[0].count,
        enquiries: enquiries.rows[0].count,
        projects: projects.rows[0].count
      })
    } catch (error) {
      return next(error)
    }
  })

  app.use((req, res) => res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` }))

  app.use((error, _req, res, _next) => {
    if (error.message === 'Origin is not allowed by CORS.') {
      return res.status(403).json({ error: error.message })
    }
    if (error instanceof SyntaxError && Object.hasOwn(error, 'body')) {
      return res.status(400).json({ error: 'Request body must be valid JSON.' })
    }
    console.error('API request failed:', error)
    return res.status(500).json({ error: 'Internal server error.' })
  })

  return app
}
