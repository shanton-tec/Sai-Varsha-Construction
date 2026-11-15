const API_BASE_URL = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')
const TOKEN_KEY = 'sai-varsha-api-token'

export const getAuthToken = () => window.localStorage.getItem(TOKEN_KEY)
export const saveAuthToken = token => window.localStorage.setItem(TOKEN_KEY, token)
export const clearAuthToken = () => window.localStorage.removeItem(TOKEN_KEY)

export async function apiRequest(path, { method = 'GET', body, token = getAuthToken() } = {}) {
  let response
  try {
    response = await fetch(`${API_BASE_URL}/api${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
  } catch (error) {
    throw new Error(`Cannot reach the backend API. Start the API server and check the connection. ${error.message}`)
  }

  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(data.error || `API request failed (${response.status}).`)
    error.status = response.status
    throw error
  }
  return data
}
