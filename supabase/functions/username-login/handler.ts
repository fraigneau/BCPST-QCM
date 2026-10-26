export interface LoginTokens { access_token: string; refresh_token: string }
export type PasswordResult = { tokens: LoginTokens } | { status: 401 | 429 | 503 }
export interface UsernameLoginDependencies {
  allowedOrigins: readonly string[]
  findProfile: (username: string) => Promise<{ id: string; disabled: boolean } | null>
  findEmail: (userId: string) => Promise<string | null>
  signIn: (email: string, password: string) => Promise<PasswordResult>
  attemptAllowed?: (username: string) => boolean
  corsHeaders?: Record<string, string>
}

export function createAttemptLimiter(now: () => number = Date.now) {
  const attempts = new Map<string, { count: number; until: number }>()
  return (username: string) => {
    const time = now()
    const previous = attempts.get(username)
    if (previous && previous.until > time) return ++previous.count <= 20
    if (attempts.size >= 2048) {
      for (const [name, attempt] of attempts) if (attempt.until <= time) attempts.delete(name)
      if (attempts.size >= 2048) return false
    }
    attempts.set(username, { count: 1, until: time + 60000 })
    return true
  }
}

async function readInput(request: Request): Promise<unknown> {
  if (!request.body) throw new Error('body')
  const reader = request.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let size = 0
  let raw = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 4096) { await reader.cancel(); throw new Error('body') }
      raw += decoder.decode(value, { stream: true })
    }
    return JSON.parse(raw + decoder.decode())
  } finally { reader.releaseLock() }
}

export function createUsernameLoginHandler(dependencies: UsernameLoginDependencies) {
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get('Origin')
    const allowed = !origin || dependencies.allowedOrigins.includes(origin)
    const headers = new Headers(dependencies.corsHeaders)
    headers.delete('Access-Control-Allow-Origin')
    headers.set('Vary', 'Origin')
    headers.set('Cache-Control', 'no-store')
    headers.set('Content-Type', 'application/json; charset=utf-8')
    headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS')
    if (allowed && origin) headers.set('Access-Control-Allow-Origin', origin)
    const json = (message: string, status: number) => Response.json({ message }, { status, headers })
    if (!allowed) return json('Origine non autorisée.', 403)
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    if (request.method !== 'POST') { headers.set('Allow', 'POST, OPTIONS'); return json('Méthode non autorisée.', 405) }
    if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) return json('Requête invalide.', 400)
    let input: unknown
    try { input = await readInput(request) } catch { return json('Requête invalide.', 400) }
    if (!input || typeof input !== 'object' || Array.isArray(input)) return json('Requête invalide.', 400)
    const record = input as Record<string, unknown>
    if (typeof record.identifier !== 'string' || typeof record.password !== 'string') return json('Requête invalide.', 400)
    const username = record.identifier.trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9._-]{2,23}$/.test(username) || !record.password.length || record.password.length > 128) return json('Identifiant ou mot de passe incorrect.', 401)
    if (dependencies.attemptAllowed && !dependencies.attemptAllowed(username)) return json('Trop de tentatives. Réessaie dans une minute.', 429)
    try {
      const profile = await dependencies.findProfile(username)
      const email = await dependencies.findEmail(profile?.id ?? crypto.randomUUID())
      const canSignIn = !!profile && !profile.disabled && !!email
      const result = await dependencies.signIn(canSignIn ? email! : `absent-${crypto.randomUUID()}@username-login.invalid`, record.password)
      if ('status' in result) {
        if (result.status === 503) return json('La connexion est momentanément indisponible.', 503)
        if (result.status === 429) return json('Trop de tentatives. Réessaie plus tard.', 429)
        return json('Identifiant ou mot de passe incorrect.', 401)
      }
      if (!canSignIn || !result.tokens.access_token || !result.tokens.refresh_token) return json('Identifiant ou mot de passe incorrect.', 401)
      return Response.json({ access_token: result.tokens.access_token, refresh_token: result.tokens.refresh_token }, { headers })
    } catch { return json('La connexion est momentanément indisponible.', 503) }
  }
}
