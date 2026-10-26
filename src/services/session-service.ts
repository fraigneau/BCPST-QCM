import type { SupabaseClient } from '@supabase/supabase-js'
import type { Bootstrap, User } from '../../shared/types.ts'

export type AuthMode = 'local' | 'supabase'
export interface SessionState {
  user: User | null
  bootstrap: Bootstrap | null
  loading: boolean
  authMode: AuthMode
  error: string | null
}

type AuthClient = Pick<SupabaseClient, 'auth'>
export class RequestError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}
export class SessionChangedError extends Error {
  constructor() { super('La session a changé. Réessayez dans votre nouvel espace.') }
}

export function authErrorMessage(error: { code?: string; message?: string }): string {
  const messages: Record<string, string> = {
    invalid_credentials: 'Adresse e-mail ou mot de passe incorrect.',
    email_not_confirmed: 'Confirmez votre adresse e-mail avant de vous connecter.',
    user_banned: 'Ce compte est désactivé.',
    signup_disabled: 'Les inscriptions sont temporairement fermées.',
    over_email_send_rate_limit: 'Trop d’e-mails demandés. Patientez avant de réessayer.',
    over_request_rate_limit: 'Trop de tentatives. Patientez avant de réessayer.',
    user_already_exists: 'Cette adresse possède déjà un compte.',
    weak_password: 'Choisissez un mot de passe plus robuste, de dix caractères minimum.',
    email_address_invalid: 'Vérifiez votre adresse e-mail.',
    email_address_not_authorized: 'Cette adresse ne peut pas recevoir l’e-mail de confirmation avec la configuration actuelle.',
  }
  return messages[error.code ?? ''] ?? 'La connexion à Supabase a échoué. Vérifiez votre connexion puis réessayez.'
}

export function createSessionService(state: SessionState, dependencies: {
  fetch: typeof fetch
  getClient: () => AuthClient
  clearActiveGame?: () => void
}) {
  let configuration: Promise<void> | undefined
  let authOperation = false
  let generation = 0
  let cloudIdentity: string | null = null
  let disposed = false
  let unsubscribe: (() => void) | undefined
  let scheduled: ReturnType<typeof setTimeout> | undefined

  function clearIdentity() {
    generation++
    state.user = null
    state.bootstrap = null
    dependencies.clearActiveGame?.()
  }

  async function decode<T>(response: Response): Promise<T> {
    const data = await response.json().catch(() => null) as { message?: string } | null
    if (!response.ok) throw new RequestError(response.status, data?.message ?? 'Le serveur est indisponible. Réessayez.')
    if (data === null) throw new RequestError(502, 'Le serveur a renvoyé une réponse invalide.')
    return data as T
  }

  async function configure() {
    if (!configuration) {
      configuration = (async () => {
        const config = await decode<{ authMode: AuthMode }>(await dependencies.fetch('/api/config', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10000) }))
        if (config.authMode !== 'local' && config.authMode !== 'supabase') throw new Error('Configuration d’authentification invalide.')
        state.authMode = config.authMode
        if (state.authMode === 'supabase') {
          const { data } = dependencies.getClient().auth.onAuthStateChange((event, current) => {
            if (disposed || event === 'INITIAL_SESSION') return
            const identity = current?.user.id ?? null
            if (identity !== cloudIdentity || event === 'SIGNED_OUT') {
              cloudIdentity = identity
              clearIdentity()
              if (!authOperation) {
                clearTimeout(scheduled)
                scheduled = setTimeout(() => { if (!disposed) void refreshSession() }, 0)
              }
            }
          })
          unsubscribe = () => data.subscription.unsubscribe()
        }
      })().catch(error => { configuration = undefined; throw error })
    }
    await configuration
  }

  async function headers(): Promise<Headers> {
    await configure()
    const result = new Headers({ 'Content-Type': 'application/json' })
    if (state.authMode === 'supabase') {
      const version = generation
      const { data, error } = await dependencies.getClient().auth.getSession()
      if (version !== generation) throw new SessionChangedError()
      if (error) throw new RequestError(401, authErrorMessage(error))
      if (!data.session) throw new RequestError(401, 'Connectez-vous pour continuer.')
      if (cloudIdentity !== data.session.user.id) {
        const changingAccount = cloudIdentity !== null || state.user !== null
        cloudIdentity = data.session.user.id
        if (changingAccount) clearIdentity()
      }
      result.set('Authorization', `Bearer ${data.session.access_token}`)
    }
    return result
  }

  async function request<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
    const requestHeaders = await headers()
    new Headers(options.headers).forEach((value, key) => {
      if (key.toLowerCase() !== 'authorization') requestHeaders.set(key, value)
    })
    const version = generation
    try {
      const response = await dependencies.fetch(`/api${path}`, { ...options, credentials: 'same-origin', headers: requestHeaders, cache: 'no-store', signal: AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(15000)]) })
      const data = await decode<T>(response)
      if (version !== generation) throw new SessionChangedError()
      return data
    } catch (error) {
      if (version !== generation) throw new SessionChangedError()
      if (error instanceof RequestError && error.status === 401 && version === generation) clearIdentity()
      throw error
    }
  }

  async function refreshSession() {
    state.error = null
    try {
      const data = await request<Bootstrap>('/bootstrap')
      state.user = data.user
      state.bootstrap = data
    } catch (error) {
      if (error instanceof SessionChangedError) return
      clearIdentity()
      if (!(error instanceof RequestError && error.status === 401)) state.error = error instanceof Error ? error.message : 'Impossible de charger votre espace.'
    } finally { state.loading = false }
  }

  async function signIn(email: string, password: string) {
    await configure()
    authOperation = true
    state.error = null
    clearIdentity()
    try {
      if (state.authMode === 'supabase') {
        const { error } = await dependencies.getClient().auth.signInWithPassword({ email: email.trim(), password })
        if (error) throw new Error(authErrorMessage(error))
      } else {
        await request('/auth/login', { method: 'POST', body: JSON.stringify({ email: email.trim(), password }) })
      }
      await refreshSession()
      if (!state.user) throw new Error(state.error ?? 'Votre session est indisponible. Reconnectez-vous.')
    } finally { authOperation = false }
  }

  async function signUp(input: { name: string; email: string; password: string }) {
    await configure()
    if (input.name.trim().length < 2 || input.name.trim().length > 60 || input.password.length < 10 || input.password.length > 128) throw new Error('Indiquez un nom de 2 à 60 caractères et un mot de passe de 10 à 128 caractères.')
    authOperation = true
    state.error = null
    clearIdentity()
    try {
      if (state.authMode === 'supabase') {
        const { data, error } = await dependencies.getClient().auth.signUp({ email: input.email.trim(), password: input.password, options: { data: { display_name: input.name.trim() } } })
        if (error) throw new Error(authErrorMessage(error))
        if (!data.session) return { requiresConfirmation: true }
      } else {
        await request('/auth/register', { method: 'POST', body: JSON.stringify({ ...input, name: input.name.trim(), email: input.email.trim() }) })
      }
      await refreshSession()
      if (!state.user) throw new Error(state.error ?? 'Votre session est indisponible. Reconnectez-vous.')
      return { requiresConfirmation: false }
    } finally { authOperation = false }
  }

  async function signOut() {
    await configure()
    authOperation = true
    clearIdentity()
    let failure: unknown
    try {
      if (state.authMode === 'supabase') {
        try { await request('/auth/logout', { method: 'POST', body: '{}' }) } catch { }
        const { error } = await dependencies.getClient().auth.signOut({ scope: 'local' })
        if (error) failure = new Error(authErrorMessage(error))
      } else {
        await request('/auth/logout', { method: 'POST', body: '{}' })
      }
    } catch (error) { failure = error }
    finally {
      cloudIdentity = null
      clearIdentity()
      state.error = null
      authOperation = false
    }
    if (failure) throw failure
  }

  return { request, refreshSession, signIn, signUp, signOut, headers, generation: () => generation, dispose: () => { disposed = true; clearTimeout(scheduled); unsubscribe?.() } }
}
