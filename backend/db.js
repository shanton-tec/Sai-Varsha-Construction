import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import pg from 'pg'

const { Pool } = pg

const sslCaPath = process.env.DATABASE_SSL_CA
const ssl = process.env.DATABASE_SSL === 'false'
  ? false
  : sslCaPath
    ? {
      ca: readFileSync(resolve(process.cwd(), sslCaPath), 'utf8'),
      rejectUnauthorized: true
    }
    : true

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl,
  max: Number(process.env.DATABASE_POOL_SIZE || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000
})

pool.on('error', error => {
  console.error('Unexpected PostgreSQL pool error:', error)
})
