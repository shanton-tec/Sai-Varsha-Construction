import 'dotenv/config'
import { createApp } from './app.js'
import { pool } from './db.js'

const required = ['DATABASE_URL', 'JWT_SECRET']
const missing = required.filter(key => !process.env[key])
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`)
  process.exit(1)
}
if (process.env.JWT_SECRET.length < 32) {
  console.error('JWT_SECRET must contain at least 32 characters.')
  process.exit(1)
}
if (process.env.NODE_ENV === 'production' && !process.env.CORS_ORIGINS) {
  console.error('CORS_ORIGINS must be set in production.')
  process.exit(1)
}

const port = Number(process.env.PORT || process.env.API_PORT || 4000)
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('API_PORT must be a valid port number.')
  process.exit(1)
}

const server = createApp(pool).listen(port, () => {
  console.log(`Sai Varsha API listening on http://localhost:${port}`)
})

const shutdown = signal => {
  console.log(`${signal} received; closing API server.`)
  server.close(async error => {
    if (error) console.error('Error while closing API server:', error)
    try {
      await pool.end()
    } catch (poolError) {
      console.error('Error while closing PostgreSQL pool:', poolError)
      process.exitCode = 1
    }
    process.exit()
  })
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
