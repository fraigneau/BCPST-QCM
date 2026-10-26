import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { User } from '../shared/types.ts'
import { createSessionService, authErrorMessage, type SessionState } from '../src/services/session-service.ts'

const alice: User = { id: 'alice', name: 'Alice', email: 'alice@example.test', role: 'admin', createdAt: '2026-10-21T12:00:00Z' }
const bob: User = { ...alice, id: 'bob', name: 'Bob', email: 'bob@example.test', role: 'student' }
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
const bootstrap = (user: User) => ({ user, chapters: [], counts: {}, progress: {} })

function fixture(mode: 'supabase' | 'local' = 'supabase') {
  const state: SessionState = { user: null, bootstrap: null, loading: true, authMode: 'local', error: null }
  let current: { user: { id: string }; access_token: string } | null = null
  let listener: ((event: string, current: unknown) => void) | undefined
  let cleared = 0
  let signupInput: unknown
  const requests: { path: string; headers: Headers; body: unknown }[] = []
  let intercept: ((path: string) => Promise<Response> | undefined) | undefined
  const client = { auth: {
    onAuthStateChange: (callback: typeof listener) => { listener = callback; return { data: { subscription: { unsubscribe: () => { listener = undefined } } } } },
    getSession: async () => ({ data: { session: current }, error: null }),
    signInWithPassword: async (input: { email: string }) => {
      const user = input.email === bob.email ? bob : alice
      current = { user: { id: user.id }, access_token: `token-${user.id}` }
      listener?.('SIGNED_IN', current)
      return { data: { session: current }, error: null }
    },
    signUp: async (input: unknown) => { signupInput = input; return { data: { session: null, user: null }, error: null } },
    signOut: async () => { current = null; listener?.('SIGNED_OUT', null); return { error: null } },
  } } as unknown as SupabaseClient
  const service = createSessionService(state, {
    getClient: () => { assert.equal(mode, 'supabase'); return client },
    clearActiveGame: () => { cleared++ },
    fetch: async (url, init) => {
      const path = String(url)
      const headers = new Headers(init?.headers)
      requests.push({ path, headers, body: init?.body ? JSON.parse(String(init.body)) : null })
      const overridden = intercept?.(path)
      if (overridden) return overridden
      if (path === '/api/config') return response({ authMode: mode })
      if (path === '/api/bootstrap') return response(bootstrap(current?.user.id === bob.id ? bob : alice))
      return response({})
    },
  })
  return { state, service, requests, get cleared() { return cleared }, get signupInput() { return signupInput },
    setCurrent: (user: User) => { current = { user: { id: user.id }, access_token: `token-${user.id}` } },
    intercept: (callback: typeof intercept) => { intercept = callback },
    event: (event: string) => listener?.(event, current),
  }
}

test('connexion cloud : mot de passe confié au SDK, Bearer sur bootstrap et aucun login local', async t => {
  const f = fixture()
  t.after(f.service.dispose)
  await f.service.signIn(alice.email, 'MotDePasse2026!')
  assert.equal(f.state.user?.role, 'admin')
  assert.equal(f.state.authMode, 'supabase')
  assert.equal(f.requests.some(r => r.path === '/api/auth/login'), false)
  assert.equal(f.requests.find(r => r.path === '/api/bootstrap')?.headers.get('Authorization'), 'Bearer token-alice')
  assert.ok(f.requests.every(r => !JSON.stringify(r.body).includes('MotDePasse')))
  await f.service.request('/progress', { headers: { Authorization: 'Bearer forged' } })
  assert.equal(f.requests.at(-1)?.headers.get('Authorization'), 'Bearer token-alice')
})

test('inscription cloud : confirmation e-mail sans fausse session ni rôle transmis', async t => {
  const f = fixture()
  t.after(f.service.dispose)
  const result = await f.service.signUp({ name: ' Camille ', email: 'camille@example.test', password: 'MotDePasse2026!' })
  assert.equal(result.requiresConfirmation, true)
  assert.equal(f.state.user, null)
  assert.deepEqual(f.signupInput, { email: 'camille@example.test', password: 'MotDePasse2026!', options: { data: { display_name: 'Camille' } } })
  assert.equal(f.requests.some(r => r.path === '/api/bootstrap'), false)
})

test('connexion locale explicite : cookie conservé et aucun appel au SDK cloud', async t => {
  const f = fixture('local')
  t.after(f.service.dispose)
  await f.service.signIn('admin@herbier.local', 'Herbier2026!')
  assert.equal(f.state.user?.id, alice.id)
  assert.deepEqual(f.requests.find(r => r.path === '/api/auth/login')?.body, { email: 'admin@herbier.local', password: 'Herbier2026!' })
  assert.equal(f.requests.at(-1)?.headers.has('Authorization'), false)
})

test('bootstrap tardif d’Alice ignoré après connexion de Bob, même si la requête échoue', async t => {
  for (const status of [200, 503]) {
    const f = fixture()
    t.after(f.service.dispose)
    await f.service.signIn(alice.email, 'MotDePasse2026!')
    let release!: (response: Response) => void
    const delayed = new Promise<Response>(resolve => { release = resolve })
    f.intercept(path => path === '/api/bootstrap' ? delayed : undefined)
    const pending = f.service.refreshSession()
    await new Promise(resolve => setTimeout(resolve, 0))
    f.intercept(undefined)
    await f.service.signIn(bob.email, 'MotDePasse2026!')
    release(response(status === 200 ? bootstrap(alice) : { message: 'Panne distante.' }, status))
    await pending
    assert.equal(f.state.user?.id, bob.id)
    assert.equal(f.state.error, null)
  }
})

test('déconnexion : bootstrap tardif ne peut pas rétablir la session et la reprise du quiz est effacée', async t => {
  const f = fixture()
  t.after(f.service.dispose)
  await f.service.signIn(alice.email, 'MotDePasse2026!')
  let release!: (response: Response) => void
  const delayed = new Promise<Response>(resolve => { release = resolve })
  f.intercept(path => path === '/api/bootstrap' ? delayed : undefined)
  const pending = f.service.refreshSession()
  await new Promise(resolve => setTimeout(resolve, 0))
  await f.service.signOut()
  release(response(bootstrap(alice)))
  await pending
  assert.equal(f.state.user, null)
  assert.equal(f.state.bootstrap, null)
  assert.ok(f.cleared > 0)
})

test('panne cloud visible sans secours local ni suppression de la session SDK', async t => {
  const f = fixture()
  t.after(f.service.dispose)
  f.setCurrent(alice)
  f.intercept(path => path === '/api/bootstrap' ? Promise.resolve(response({ message: 'Supabase temporairement indisponible.' }, 503)) : undefined)
  await f.service.refreshSession()
  assert.equal(f.state.authMode, 'supabase')
  assert.match(f.state.error ?? '', /temporairement/)
  assert.equal((await f.service.headers()).get('Authorization'), 'Bearer token-alice')
  assert.equal(f.requests.some(r => r.path === '/api/auth/login'), false)
})

test('un échec de configuration ne permet pas une connexion locale implicite', async t => {
  const f = fixture()
  t.after(f.service.dispose)
  f.intercept(path => path === '/api/config' ? Promise.resolve(response({ message: 'Serveur indisponible.' }, 503)) : undefined)
  await assert.rejects(f.service.signIn(alice.email, 'MotDePasse2026!'), /indisponible/)
  assert.equal(f.requests.some(r => r.path === '/api/auth/login'), false)
})

test('les erreurs Auth connues sont expliquées en français', () => {
  assert.match(authErrorMessage({ code: 'invalid_credentials' }), /incorrect/)
  assert.match(authErrorMessage({ code: 'email_not_confirmed' }), /Confirmez/)
})
