import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { ApiError } from './games.ts'
import type { User } from '../shared/types.ts'

export type AuthMode = 'local' | 'supabase'
export interface SupabaseAuthConfig { url: string; publishableKey: string }
export interface VerifiedSupabaseIdentity { user: User; expiresAt: number }
export type SupabaseTokenVerifier = (token: string) => Promise<VerifiedSupabaseIdentity>
export interface SupabaseAuthClient {
  auth: { getUser(token: string): PromiseLike<{ data: { user: { id: string; email?: string; user_metadata?: Record<string, unknown> } | null }; error: unknown }> }
  rpc(name: 'current_profile'): PromiseLike<{ data: unknown; error: unknown }>
}
export type SupabaseAuthClientFactory = (config: SupabaseAuthConfig, token: string) => SupabaseAuthClient

export function resolveAuthConfiguration(options: { mode?: AuthMode; config?: SupabaseAuthConfig; env?: Record<string, string | undefined> } = {}) {
  const env = options.env ?? process.env
  const mode = options.mode ?? env.QCM_AUTH_MODE
  if (mode !== undefined && mode !== 'local' && mode !== 'supabase') throw new Error('QCM_AUTH_MODE doit être local ou supabase.')
  if (mode === 'local') return { mode: 'local' as const, config: null }
  const url = (options.config?.url ?? env.VITE_SUPABASE_URL ?? '').trim()
  const publishableKey = (options.config?.publishableKey ?? env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '').trim()
  if (!url && !publishableKey && mode === undefined) return { mode: 'local' as const, config: null }
  if (!url || !publishableKey) throw new Error('Configuration Supabase incomplète : VITE_SUPABASE_URL et VITE_SUPABASE_PUBLISHABLE_KEY sont nécessaires. Pour le mode local, définir QCM_AUTH_MODE=local.')
  let parsedUrl: URL
  try { parsedUrl = new URL(url) } catch { throw new Error('VITE_SUPABASE_URL est invalide.') }
  if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash || parsedUrl.pathname !== '/' || !['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('VITE_SUPABASE_URL est invalide.')
  if (parsedUrl.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsedUrl.hostname)) throw new Error('Supabase distant exige une URL HTTPS.')
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey)) throw new Error('Utiliser une clé Supabase publishable, jamais une clé secrète ou service_role.')
  return { mode: 'supabase' as const, config: { url: parsedUrl.href.replace(/\/$/, ''), publishableKey } }
}

const profileSchema = z.object({ id: z.uuid(), name: z.string().trim().min(2).max(60), email: z.email().max(254), role: z.enum(['student', 'contributor', 'admin']), createdAt: z.iso.datetime({ offset: true }), disabled_at: z.unknown().optional(), disabledAt: z.unknown().optional() })
const claimsSchema = z.object({ sub: z.uuid(), exp: z.number().finite() })

const boundedFetch: typeof fetch = (input, init) => fetch(input, { ...init, signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(5000)]) })

export function createSupabaseTokenVerifier(config: SupabaseAuthConfig, factory: SupabaseAuthClientFactory = (settings, token) => createClient(settings.url, settings.publishableKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: boundedFetch, headers: { Authorization: `Bearer ${token}` } } })): SupabaseTokenVerifier {
  return async token => {
    try {
      const parts = token.split('.')
      if (token.length > 16384 || parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw new ApiError(401, 'Jeton Supabase invalide.')
      let decoded: unknown
      try { decoded = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()) }
      catch { throw new ApiError(401, 'Jeton Supabase invalide.') }
      const parsedClaims = claimsSchema.safeParse(decoded)
      if (!parsedClaims.success || !Number.isFinite(parsedClaims.data.exp * 1000) || parsedClaims.data.exp * 1000 <= Date.now()) throw new ApiError(401, 'Session Supabase invalide ou expirée.')
      const claims = parsedClaims.data
      const client = factory(config, token)
      const identity = await client.auth.getUser(token)
      if (identity.error || !identity.data.user) {
        const status = Number((identity.error as { status?: unknown } | null)?.status)
        const unavailable = Boolean(identity.error) && (!(status >= 400 && status < 500) || status === 429)
        throw new ApiError(unavailable ? 503 : 401, unavailable ? 'Le service d’authentification Supabase est indisponible.' : 'Session Supabase invalide ou expirée.')
      }
      if (claims.sub !== identity.data.user.id || claims.exp * 1000 <= Date.now()) throw new ApiError(401, 'Session Supabase invalide ou expirée.')
      const result = await client.rpc('current_profile')
      if (result.error) {
        const code = (result.error as { code?: string }).code
        throw new ApiError(code === '42501' ? 403 : 503, code === '42501' ? 'Ce profil Supabase est désactivé ou inaccessible.' : 'Profil Supabase indisponible. Vérifiez les migrations du projet.')
      }
      const profile = profileSchema.safeParse(result.data)
      if (!profile.success || profile.data.id !== identity.data.user.id || profile.data.disabled_at || profile.data.disabledAt) throw new ApiError(403, 'Ce profil Supabase est désactivé ou invalide.')
      const { id, name, email, role, createdAt } = profile.data
      return { user: { id, name, email: email.toLowerCase(), role, createdAt }, expiresAt: claims.exp * 1000 }
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw new ApiError(503, 'Le service d’authentification Supabase est indisponible.')
    }
  }
}
