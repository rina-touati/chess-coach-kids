import { createClient } from '@supabase/supabase-js'

const profileCookieName = 'chess_profile'

export type ApiRequest = {
  method?: string
  body?: unknown
  headers: {
    cookie?: string
    [key: string]: string | string[] | undefined
  }
}

export type ApiResponse = {
  setHeader(name: string, value: string | string[]): void
  status(code: number): ApiResponse
  json(body: unknown): void
  send(body: unknown): void
}

export type ChessProfileCookie = {
  childProfileId: string
  accessToken: string
}

export function getRequiredEnv(name: string) {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

export function getSupabaseClient() {
  return createClient(getRequiredEnv('SUPABASE_URL'), getRequiredEnv('SUPABASE_PUBLISHABLE_KEY'), {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  })
}

export function parseJsonBody<T>(req: { body?: unknown }): T {
  if (typeof req.body === 'string') {
    return JSON.parse(req.body) as T
  }
  return (req.body ?? {}) as T
}

export function parseProfileCookie(cookieHeader: string | undefined): ChessProfileCookie | null {
  if (!cookieHeader) return null

  const cookie = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${profileCookieName}=`))

  if (!cookie) return null

  const rawValue = decodeURIComponent(cookie.slice(profileCookieName.length + 1))
  const [childProfileId, accessToken] = rawValue.split('.')

  if (!childProfileId || !accessToken) return null
  return { childProfileId, accessToken }
}

export function serializeProfileCookie(profile: ChessProfileCookie) {
  const value = encodeURIComponent(`${profile.childProfileId}.${profile.accessToken}`)
  return `${profileCookieName}=${value}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`
}

export function setJsonHeaders(res: { setHeader(name: string, value: string | string[]): void }) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
}
