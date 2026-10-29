import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAttemptLimiter, createUsernameLoginHandler, type UsernameLoginDependencies } from '../supabase/functions/username-login/handler.ts'

import { resolveAllowedOrigins } from '../supabase/functions/username-login/origins.ts'

function fixture() {
  const calls: { kind: string; value: string }[] = []
  const dependencies: UsernameLoginDependencies = {
    allowedOrigins: resolveAllowedOrigins(),
    corsHeaders: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type' },
    findProfile: async username => { calls.push({ kind: 'profile', value: username }); return username === 'yann' || username === 'disabled' ? { id: username, disabled: username === 'disabled' } : null },
    findEmail: async id => { calls.push({ kind: 'email', value: id }); return id === 'yann' || id === 'disabled' ? 'private@example.test' : null },
    signIn: async (email, password) => { calls.push({ kind: 'auth', value: email }); return email === 'private@example.test' && password === 'correct' ? { tokens: { access_token: 'access', refresh_token: 'refresh' } } : { status: 401 } },
  }
  return { calls, dependencies, handle: (request: Request) => createUsernameLoginHandler(dependencies)(request) }
}
function request(identifier: string, password = 'wrong') {
  return new Request('https://example.supabase.co/functions/v1/username-login', { method: 'POST', headers: { Origin: 'https://bcpst-qcm.pages.dev', 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier, password }) })
}

test('la fonction authentifie via Auth et ne renvoie que les jetons du compte autorisé', async () => {
  const f = fixture()
  const response = await f.handle(request(' YaNN ', 'correct'))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { access_token: 'access', refresh_token: 'refresh' })
  assert.deepEqual(f.calls, [{ kind: 'profile', value: 'yann' }, { kind: 'email', value: 'yann' }, { kind: 'auth', value: 'private@example.test' }])
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
})

test('pseudo absent, désactivé et mauvais mot de passe gardent le même refus sans dévoiler un e-mail', async () => {
  const failures: unknown[] = []
  for (const username of ['yann', 'missing', 'disabled']) {
    const f = fixture()
    const response = await f.handle(request(username))
    assert.equal(response.status, 401)
    failures.push(await response.json())
    assert.equal(f.calls.length, 3)
    if (username !== 'yann') assert.match(f.calls.at(-1)!.value, /^absent-.+@username-login\.invalid$/)
  }
  assert.deepEqual(failures[0], failures[1])
  assert.deepEqual(failures[1], failures[2])
  assert.ok(!JSON.stringify(failures).includes('@'))
})

test('CORS, préflight, méthodes et données invalides sont traités avant toute lecture privilégiée', async () => {
  const f = fixture()
  const preflight = await f.handle(new Request(request('yann'), { method: 'OPTIONS', body: null }))
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), 'https://bcpst-qcm.pages.dev')
  const foreign = await f.handle(new Request(request('yann'), { headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' } }))
  assert.equal(foreign.status, 403)
  assert.equal(foreign.headers.get('Access-Control-Allow-Origin'), null)
  assert.equal((await f.handle(new Request('https://example.supabase.co', { method: 'GET' }))).status, 405)
  assert.equal((await f.handle(request('bad@email.test'))).status, 401)
  assert.equal((await f.handle(new Request('https://example.supabase.co', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: 'yann', password: 'x'.repeat(5000) }) }))).status, 400)
  assert.deepEqual(f.calls, [])
})

test('les pannes et limites ne produisent pas de faux jetons et ne se présentent pas comme un mot de passe faux', async () => {
  const f = fixture()
  f.dependencies.findProfile = async () => { throw new Error('secret configuration details') }
  const failure = await f.handle(request('yann'))
  assert.equal(failure.status, 503)
  assert.ok(!(await failure.text()).includes('secret'))
  const limited = fixture()
  limited.dependencies.signIn = async () => ({ status: 429 })
  assert.equal((await limited.handle(request('yann'))).status, 429)
  let now = 0
  const allow = createAttemptLimiter(() => now)
  for (let i = 0; i < 20; i++) assert.equal(allow('yann'), true)
  assert.equal(allow('yann'), false)
  now = 60001
  assert.equal(allow('yann'), true)
})


test('le domaine de production accepte le préflight et une connexion par pseudo, sans ouvrir les autres domaines', async () => {
  const f = fixture()
  const headers = { Origin: 'https://qcm.fraigneau.fr', 'Content-Type': 'application/json' }
  const preflight = await f.handle(new Request('https://example.supabase.co/functions/v1/username-login', { method: 'OPTIONS', headers }))
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), headers.Origin)
  assert.deepEqual(f.calls, [])
  const response = await f.handle(new Request(request('yann', 'correct'), { headers }))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), headers.Origin)
  const foreign = await f.handle(new Request(request('yann'), { headers: { ...headers, Origin: 'https://qcm.fraigneau.fr.evil.test' } }))
  assert.equal(foreign.status, 403)
  assert.equal(foreign.headers.get('Access-Control-Allow-Origin'), null)
})

test('une liste explicite des origines remplace les valeurs par défaut', () => {
  assert.deepEqual(resolveAllowedOrigins(' https://preview.example , ,http://localhost:5173 '), ['https://preview.example', 'http://localhost:5173'])
  assert.deepEqual(resolveAllowedOrigins(''), [])
})
