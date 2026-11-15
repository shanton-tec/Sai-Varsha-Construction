import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import bcrypt from 'bcryptjs'
import { createApp } from '../app.js'
import { issueToken } from '../auth.js'

process.env.JWT_SECRET = 'unit-test-only-secret-with-at-least-32-characters'

const passwordHash = await bcrypt.hash('customer-password', 4)
const users = [
  { id: 1, name: 'Customer', email: 'customer@example.com', role: 'customer', password_hash: passwordHash },
  { id: 2, name: 'Admin', email: 'admin@example.com', role: 'admin', password_hash: passwordHash }
]
const capturedQueries = []

const database = {
  async query(sql, values = []) {
    capturedQueries.push({ sql, values })
    if (sql === 'select 1') return { rows: [{ result: 1 }], rowCount: 1 }
    if (sql.includes('insert into construction.users')) {
      const user = { id: 3, name: values[0], email: values[1], role: 'customer', password_hash: values[2] }
      users.push(user)
      const { password_hash: _passwordHash, ...publicUser } = user
      return { rows: [publicUser], rowCount: 1 }
    }
    if (sql.includes('from construction.users where email = $1')) {
      const user = users.find(account => account.email === values[0])
      return { rows: user ? [{ ...user }] : [], rowCount: user ? 1 : 0 }
    }
    if (sql.includes('from construction.users where id = $1')) {
      const user = users.find(account => String(account.id) === String(values[0]))
      if (!user) return { rows: [], rowCount: 0 }
      const { password_hash: _passwordHash, ...publicUser } = user
      return { rows: [publicUser], rowCount: 1 }
    }
    if (sql.includes('insert into construction.enquiries')) {
      const [name, phone, email, location, plotSize, message] = values
      return {
        rows: [{
          id: 1, name, phone, customer_email: email, location, plot_size: plotSize,
          message, status: 'new'
        }],
        rowCount: 1
      }
    }
    if (sql.includes('update construction.enquiries')) {
      return { rows: [{ id: values[1], status: values[0] }], rowCount: 1 }
    }
    if (sql.includes('insert into construction.projects')) {
      const [project_name, customer_email, location, status, progress, estimated_cost, next_milestone] = values
      return {
        rows: [{
          id: 12, project_name, customer_email, location, status, progress,
          estimated_cost, next_milestone
        }],
        rowCount: 1
      }
    }
    if (sql.includes('update construction.projects')) {
      return { rows: [{ id: values.at(-1), status: values[0] }], rowCount: 1 }
    }
    if (sql.includes('from construction.projects p')) return { rows: [], rowCount: 0 }
    if (sql.includes('from construction.enquiries')) return { rows: [], rowCount: 0 }
    if (sql.includes('count(*)')) return { rows: [{ count: 0 }], rowCount: 1 }
    throw new Error(`Unexpected test query: ${sql}`)
  }
}

let server
let baseUrl

before(async () => {
  server = createApp(database).listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
})

const request = (path, { method = 'GET', body, token } = {}) => fetch(`${baseUrl}/api${path}`, {
  method,
  headers: {
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(token ? { authorization: `Bearer ${token}` } : {})
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
})

test('health check reports that the database is connected', async () => {
  const response = await request('/health')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, database: 'connected' })
})

test('register stores a bcrypt hash and returns a signed customer token', async () => {
  const response = await request('/auth/register', {
    method: 'POST',
    body: { name: 'New Customer', email: 'new@example.com', password: 'a-safe-password' }
  })
  const result = await response.json()
  assert.equal(response.status, 201)
  assert.equal(result.user.role, 'customer')
  assert.equal(await bcrypt.compare('a-safe-password', users.at(-1).password_hash), true)
  assert.equal((await request('/auth/me', { token: result.token })).status, 200)
})

test('login rejects an incorrect password', async () => {
  const response = await request('/auth/login', {
    method: 'POST',
    body: { email: 'customer@example.com', password: 'incorrect-password' }
  })
  assert.equal(response.status, 401)
})

test('login returns a token and public user record for a valid customer', async () => {
  const response = await request('/auth/login', {
    method: 'POST',
    body: { email: 'customer@example.com', password: 'customer-password' }
  })
  const result = await response.json()
  assert.equal(response.status, 200)
  assert.equal(result.user.email, 'customer@example.com')
  assert.equal(Object.hasOwn(result.user, 'password_hash'), false)
  assert.equal(typeof result.token, 'string')
})

test('public enquiry submission assigns the account email from its bearer token', async () => {
  const response = await request('/enquiries', {
    method: 'POST',
    token: issueToken(users[0]),
    body: { name: 'Customer', phone: '+91 1234567890', location: 'Trichy' }
  })
  const result = await response.json()
  assert.equal(response.status, 201)
  assert.equal(result.enquiry.customer_email, 'customer@example.com')
  assert.equal(result.enquiry.status, 'new')
})

test('customer cannot access admin-only enquiries', async () => {
  const response = await request('/enquiries', { token: issueToken(users[0]) })
  assert.equal(response.status, 403)
})

test('requests without a token cannot access projects', async () => {
  const response = await request('/projects')
  assert.equal(response.status, 401)
})

test('customer projects are scoped to their own account email', async () => {
  const response = await request('/projects', { token: issueToken(users[0]) })
  assert.equal(response.status, 200)
  const projectsQuery = capturedQueries.findLast(query => query.sql.includes('from construction.projects p'))
  assert.match(projectsQuery.sql, /where p\.customer_email = \$1/)
  assert.deepEqual(projectsQuery.values, ['customer@example.com'])
})

test('admin can create a project for an existing customer', async () => {
  const response = await request('/projects', {
    method: 'POST',
    token: issueToken(users[1]),
    body: {
      project_name: 'Family home',
      customer_email: 'customer@example.com',
      location: 'Trichy'
    }
  })
  const result = await response.json()
  assert.equal(response.status, 201)
  assert.equal(result.project.project_name, 'Family home')
  assert.equal(result.project.status, 'planning')
})

test('admin can update enquiry status and invalid statuses are rejected', async () => {
  const token = issueToken(users[1])
  const update = await request('/enquiries/1', {
    method: 'PATCH', token, body: { status: 'contacted' }
  })
  assert.equal(update.status, 200)
  assert.equal((await update.json()).enquiry.status, 'contacted')

  const invalid = await request('/enquiries/1', {
    method: 'PATCH', token, body: { status: 'waiting' }
  })
  assert.equal(invalid.status, 400)
})
