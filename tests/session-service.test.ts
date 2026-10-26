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
  let usernameInput: unknown
  let usernameError: { context: Response } | null = null
  let available = true
  let usernameWait: Promise<void> | undefined
  const requests: { path: string; headers: Headers; body: unknown }[] = []
  let intercept: ((path: string) => Promise<Response> | undefined) | undefined
  const client = { rpc: async () => ({ data: available, error: null }), functions: { invoke: async (_name: string, options: { body: unknown }) => {
    usernameInput = options.body
    if (usernameWait) await usernameWait
    return { data: usernameError ? null : { access_token: 'token-bob', refresh_token: 'refresh-bob' }, error: usernameError }
  } }, auth: {
    onAuthStateChange: (callback: typeof listener) => { listener = callback; return { data: { subscription: { unsubscribe: () => { listener = undefined } } } } },
    getSession: async () => ({ data: { session: current }, error: null }),
    signInWithPassword: async (input: { email: string }) => {
      const user = input.email === bob.email ? bob : alice
      current = { user: { id: user.id }, access_token: `token-${user.id}` }
      listener?.('SIGNED_IN', current)
      return { data: { session: current }, error: null }
    },
    signUp: async (input: unknown) => { signupInput = input; return { data: { session: null, user: null }, error: null } },
    setSession: async (tokens: { access_token: string }) => { current = { user: { id: bob.id }, access_token: tokens.access_token }; listener?.('SIGNED_IN', current); return { error: null } },
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
  return { state, service, requests, get cleared() { return cleared }, get signupInput() { return signupInput }, get usernameInput() { return usernameInput },
    setAvailable: (value: boolean) => { available = value },
    failUsername: (status: number) => { usernameError = { context: response({}, status) } },
    delayUsername: (wait: Promise<void>) => { usernameWait = wait },
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
  assert.deepEqual(f.requests.find(r => r.path === '/api/auth/login')?.body, { identifier: 'admin@herbier.local', password: 'Herbier2026!' })
  assert.equal(f.requests.at(-1)?.headers.has('Authorization'), false)
})

test('connexion par pseudo : la fonction reçoit les identifiants et le SDK installe la vraie session', async t => {
  const f = fixture()
  t.after(f.service.dispose)
  await f.service.signIn('  YaNN  ', 'FixtureOnly2026!')
  assert.deepEqual(f.usernameInput, { identifier: 'yann', password: 'FixtureOnly2026!' })
  assert.equal(f.state.user?.id, bob.id)
  assert.equal(f.requests.find(request => request.path === '/api/bootstrap')?.headers.get('Authorization'), 'Bearer token-bob')
  assert.ok(f.requests.every(request => !JSON.stringify(request.body).includes('FixtureOnly2026!')))
})

test('un échec de connexion pseudo ne crée aucune session et distingue la panne du mauvais mot de passe', async t => {
  for (const status of [401, 404, 429, 503]) {
    const f = fixture()
    t.after(f.service.dispose)
    f.failUsername(status)
    await assert.rejects(f.service.signIn('yann', 'wrong'), status === 401 ? /Identifiant ou mot de passe incorrect/ : status === 429 ? /Trop de tentatives/ : /Utilise ton adresse e-mail/)
    assert.equal(f.state.user, null)
    assert.ok(!f.requests.some(request => request.path === '/api/bootstrap'))
  }
})

test('une réponse de connexion pseudo terminée après déconnexion ne rétablit pas la session', async t => {
  const f = fixture()
  t.after(f.service.dispose)
  let release!: () => void
  f.delayUsername(new Promise<void>(resolve => { release = resolve }))
  const pending = f.service.signIn('yann', 'FixtureOnly2026!')
  await new Promise(resolve => setTimeout(resolve, 0))
  await f.service.signOut()
  release()
  await assert.rejects(pending, /session a changé/)
  assert.equal(f.state.user, null)
  await assert.rejects(f.service.headers(), /Connectez-vous/)
})

test('l’inscription vérifie un pseudo normalisé sans transmettre de rôle et refuse un doublon', async t => {
  const f = fixture()
  t.after(f.service.dispose)
  await f.service.signUp({ name: 'Yann', username: '  YaNN ', email: 'yann@example.test', password: 'FixtureOnly2026!' })
  assert.deepEqual(f.signupInput, { email: 'yann@example.test', password: 'FixtureOnly2026!', options: { data: { display_name: 'Yann', username: 'yann' } } })
  f.setAvailable(false)
  await assert.rejects(f.service.signUp({ name: 'Yann', username: 'yann', email: 'another@example.test', password: 'FixtureOnly2026!' }), /déjà utilisé/)
})

test('changer de pseudo met à jour le profil courant et ne peut pas changer d’identité', async t => {
  const f = fixture()
  t.after(f.service.dispose)
  await f.service.signIn(alice.email, 'MotDePasse2026!')
  f.intercept(path => path === '/api/profile/username' ? Promise.resolve(response({ ...alice, username: 'alice.bcpst' })) : undefined)
  await f.service.setUsername(' Alice.BCPST ')
  assert.equal(f.state.user?.username, 'alice.bcpst')
  assert.equal(f.state.bootstrap?.user.username, 'alice.bcpst')
  assert.deepEqual(f.requests.at(-1)?.body, { username: 'alice.bcpst' })
  f.intercept(path => path === '/api/profile/username' ? Promise.resolve(response(bob)) : undefined)
  await assert.rejects(f.service.setUsername('bob'), /session a changé/)
  assert.equal(f.state.user?.id, alice.id)
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
