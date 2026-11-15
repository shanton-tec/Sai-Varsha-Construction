import jwt from 'jsonwebtoken'
import { body, validationResult } from 'express-validator'

export const validate = (req, res, next) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Invalid request.', details: errors.array() })
  }
  return next()
}

export const registerValidation = [
  body('name').trim().isLength({ min: 1, max: 120 }).withMessage('Name must be 1–120 characters.'),
  body('email').trim().isEmail().withMessage('Enter a valid email address.').normalizeEmail(),
  body('password').isString().isLength({ min: 8, max: 128 }).withMessage('Password must be 8–128 characters.')
]

export const loginValidation = [
  body('email').trim().isEmail().withMessage('Enter a valid email address.').normalizeEmail(),
  body('password').isString().isLength({ min: 1, max: 128 }).withMessage('Enter your password.')
]

export function createAuthMiddleware(db) {
  return async (req, res, next) => {
    const token = req.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]
    if (!token) return res.status(401).json({ error: 'Authentication required.' })

    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET, {
        algorithms: ['HS256'],
        issuer: 'sai-varsha-construction-api',
        audience: 'sai-varsha-construction-app'
      })
      if (typeof payload.sub !== 'string') {
        return res.status(401).json({ error: 'Invalid or expired authentication token.' })
      }
      const result = await db.query(
        'select id, name, email, role from construction.users where id = $1',
        [payload.sub]
      )
      if (!result.rowCount) return res.status(401).json({ error: 'Account no longer exists.' })
      req.user = result.rows[0]
      return next()
    } catch (error) {
      if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Invalid or expired authentication token.' })
      }
      return next(error)
    }
  }
}

export function optionalAuth(authenticate) {
  return (req, res, next) => req.get('authorization')
    ? authenticate(req, res, next)
    : next()
}

export const requireAdmin = (req, res, next) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Administrator access required.' })
  }
  return next()
}

export function issueToken(user) {
  return jwt.sign({ sub: String(user.id) }, process.env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: process.env.JWT_EXPIRES_IN || '12h',
    issuer: 'sai-varsha-construction-api',
    audience: 'sai-varsha-construction-app'
  })
}
