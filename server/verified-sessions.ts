import { createHash } from 'node:crypto'
import { ApiError } from './games.ts'
import type { SupabaseTokenVerifier, VerifiedSupabaseIdentity } from './supabase-auth.ts'

interface SessionEntry {
  identity?: VerifiedSupabaseIdentity
  validUntil: number
  pending?: Promise<VerifiedSupabaseIdentity>
}

export function createVerifiedSessions(verify: SupabaseTokenVerifier, now = Date.now) {
  const sessions = new Map<string, SessionEntry>()
  let closed = false

  function invalidateUser(userId: string) {
    for (const [key, entry] of sessions) if (entry.identity?.user.id === userId) sessions.delete(key)
  }

  async function get(token: string, fresh = false): Promise<VerifiedSupabaseIdentity> {
    if (closed) throw new ApiError(503, 'Le serveur s’arrête.')
    const key = createHash('sha256').update(token).digest('hex')
    let entry = sessions.get(key)
    if (entry?.identity && entry.identity.expiresAt <= now()) { sessions.delete(key); throw new ApiError(401, 'Session Supabase expirée.') }
    if (!fresh && entry?.identity && entry.validUntil > now()) return entry.identity
    if (entry?.pending) return entry.pending
    if (!entry) {
      for (const [oldKey, old] of sessions) if (!old.pending && old.validUntil <= now()) sessions.delete(oldKey)
      if (sessions.size >= 1000) throw new ApiError(503, 'Trop de sessions actives. Réessayez dans un instant.')
      entry = { validUntil: 0 }
      sessions.set(key, entry)
    }
    const current = entry
    current.pending = Promise.resolve().then(() => verify(token)).then(identity => {
      if (closed || sessions.get(key) !== current) throw new ApiError(401, 'Cette session a été invalidée. Reconnectez-vous.')
      if (!Number.isFinite(identity.expiresAt) || identity.expiresAt <= now()) throw new ApiError(401, 'Session Supabase expirée.')
      for (const old of sessions.values()) if (old.identity?.user.id === identity.user.id && old.identity.user.role !== identity.user.role) { invalidateUser(identity.user.id); break }
      current.identity = { user: Object.freeze({ ...identity.user }), expiresAt: identity.expiresAt }
      current.validUntil = Math.min(now() + 300000, identity.expiresAt)
      sessions.set(key, current)
      return current.identity
    }).catch(error => {
      if (sessions.get(key) === current) {
        if (current.identity) invalidateUser(current.identity.user.id)
        sessions.delete(key)
      }
      throw error
    }).finally(() => { current.pending = undefined })
    return current.pending
  }

  return { get, invalidateUser, close: () => { closed = true; sessions.clear() } }
}
