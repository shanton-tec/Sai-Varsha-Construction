import { createContext, useContext, useEffect, useState } from 'react'
import { apiRequest, clearAuthToken, getAuthToken, saveAuthToken } from '../lib/api'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [authError, setAuthError] = useState('')

  useEffect(() => {
    const token = getAuthToken()
    if (!token) {
      setLoading(false)
      return undefined
    }

    let active = true
    apiRequest('/auth/me', { token })
      .then(({ user: currentUser }) => {
        if (active) setUser(currentUser)
      })
      .catch(error => {
        if (active) {
          if (error.status === 401) clearAuthToken()
          else setAuthError(error.message)
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => { active = false }
  }, [])

  const authenticate = async (path, body) => {
    const { user: currentUser, token } = await apiRequest(path, {
      method: 'POST',
      body,
      token: null
    })
    saveAuthToken(token)
    setAuthError('')
    setUser(currentUser)
    return currentUser
  }

  const signIn = (email, password) =>
    authenticate('/auth/login', { email, password })

  const signUp = (name, email, password) =>
    authenticate('/auth/register', { name, email, password })

  const signOut = async () => {
    clearAuthToken()
    setUser(null)
    setAuthError('')
  }

  return <AuthContext.Provider value={{
    user,
    role: user?.role ?? null,
    loading,
    authError,
    configured: true,
    signIn,
    signUp,
    signOut
  }}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used within AuthProvider.')
  return context
}
