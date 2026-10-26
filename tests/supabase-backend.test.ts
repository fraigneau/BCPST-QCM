import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createApp } from '../server/index.ts'
import { ApiError } from '../server/games.ts'
import { createSupabaseTokenVerifier, resolveAuthConfiguration, type SupabaseAuthClientFactory } from '../server/supabase-auth.ts'
import type { GameState, User } from '../shared/types.ts'

const config = { url: 'https://example.supabase.co', publishableKey: 'sb_publishable_test_key' }
const studentId = '11111111-1111-4111-8111-111111111111'
const adminId = '22222222-2222-4222-8222-222222222222'
const collisionId = '33333333-3333-4333-8333-333333333333'
const tokenFor = (id: string, exp = Math.floor(Date.now() / 1000) + 3600) => `${Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: id, exp, user_metadata: { role: 'admin' } })).toString('base64url')}.test-signature`
const makeUser = (id: string, role: User['role'], email: string): User => ({ id, role, email, name: role === 'admin' ? 'Admin Cloud' : 'Élève Cloud', createdAt: '2026-10-01T12:00:00.000Z' })

test('la configuration auth exige un choix cohérent et aucune clé secrète', () => {
  assert.equal(resolveAuthConfiguration({ env: {} }).mode, 'local')
  assert.equal(resolveAuthConfiguration({ env: { VITE_SUPABASE_URL: config.url, VITE_SUPABASE_PUBLISHABLE_KEY: config.publishableKey } }).mode, 'supabase')
  assert.throws(() => resolveAuthConfiguration({ env: { VITE_SUPABASE_URL: config.url } }), /incomplète/)
  assert.throws(() => resolveAuthConfiguration({ env: { QCM_AUTH_MODE: 'supabase' } }), /incomplète/)
  assert.throws(() => resolveAuthConfiguration({ env: { QCM_AUTH_MODE: 'incorrect' } }), /local ou supabase/)
  assert.equal(resolveAuthConfiguration({ env: { QCM_AUTH_MODE: 'local', VITE_SUPABASE_URL: config.url } }).mode, 'local')
  assert.throws(() => resolveAuthConfiguration({ config: { ...config, publishableKey: 'sb_secret_forbidden' }, env: {} }), /publishable/)
  assert.throws(() => resolveAuthConfiguration({ config: { ...config, publishableKey: 'eyJhbGciOiJIUzI1NiJ9.service_role' }, env: {} }), /publishable/)
  assert.throws(() => resolveAuthConfiguration({ config: { ...config, url: `${config.url}/rest/v1` }, env: {} }), /invalide/)
})

test('les identités Supabase et les rôles autoritaires protègent les parcours hybrides', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'qcm-cloud-auth-'))
  const validExpiry = Math.floor(Date.now() / 1000) + 3600
  const profiles = new Map<string, User>([
    [studentId, makeUser(studentId, 'student', 'student@cloud.example')],
    [adminId, makeUser(adminId, 'admin', 'admin@cloud.example')],
    [collisionId, makeUser(collisionId, 'student', 'eleve@herbier.local')],
  ])
  const tokens = new Map([...profiles.keys()].map(id => [tokenFor(id, validExpiry), id]))
  const disabled = new Set<string>()
  let profileCalls = 0
  const factory: SupabaseAuthClientFactory = (_settings, token) => ({
    auth: { getUser: async received => {
      assert.equal(received, token)
      const id = tokens.get(token)
      return id ? { data: { user: { id, user_metadata: { role: 'admin' } } }, error: null } : { data: { user: null }, error: { status: 401 } }
    } },
    rpc: async name => {
      assert.equal(name, 'current_profile')
      profileCalls++
      const id = tokens.get(token)!
      return disabled.has(id) ? { data: null, error: { code: '42501' } } : { data: profiles.get(id), error: null }
    },
  })
  const verifier = createSupabaseTokenVerifier(config, factory)
  const runtime = createApp({ authMode: 'supabase', supabaseConfig: config, verifySupabaseToken: verifier, streamAuthRecheckMs: 20, dbPath: join(directory, 'test.sqlite'), uploadsDir: join(directory, 'uploads') })
  runtime.server.listen(0, '127.0.0.1')
  await once(runtime.server, 'listening')
  const address = runtime.server.address()
  assert.ok(address && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}`
  const studentToken = tokenFor(studentId, validExpiry)
  const adminToken = tokenFor(adminId, validExpiry)
  async function request(path: string, token?: string, method = 'GET', body?: unknown, cookie?: string) {
    const response = await fetch(`${url}/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, body: await response.json() }
  }
  try {
    await t.test('le mode public est explicite et aucun cookie local ou faux JWT ne passe', async () => {
      assert.deepEqual((await request('/config')).body, { authMode: 'supabase' })
      assert.equal((await request('/auth/login', undefined, 'POST', { email: 'admin@herbier.local', password: 'Herbier2026!' })).status, 409)
      assert.equal((await request('/auth/register', undefined, 'POST', { name: 'Local élève', email: 'local@example.fr', password: 'UnMotDePasse2026!' })).status, 409)
      const cookie = 'previous-valid-local-session'
      runtime.db.prepare('INSERT INTO sessions(token,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(cookie).digest('hex'), 'demo-admin', Date.now() + 60000)
      assert.equal((await request('/bootstrap', undefined, 'GET', undefined, `herbier_session=${cookie}`)).status, 401)
      assert.equal((await request('/bootstrap', `${studentToken}forged`)).status, 401)
      assert.equal((await request('/bootstrap?access_token=' + studentToken)).status, 401)
      const expired = tokenFor(studentId, Math.floor(Date.now() / 1000) - 10)
      tokens.set(expired, studentId)
      assert.equal((await request('/bootstrap', expired)).status, 401)
    })

    await t.test('le profil RPC contrôle les rôles et le miroir ne fusionne jamais les comptes', async () => {
      const bootstrap = await request('/bootstrap', studentToken)
      assert.equal(bootstrap.status, 200)
      assert.equal(bootstrap.body.user.id, studentId)
      assert.equal(bootstrap.body.user.role, 'student')
      assert.equal((await request('/users', studentToken)).status, 403)
      const row = runtime.db.prepare('SELECT * FROM users WHERE id=?').get(studentId)!
      assert.equal(row.auth_provider, 'supabase')
      assert.equal(row.password_hash === 'Herbier2026!', false)
      runtime.db.prepare("UPDATE users SET role='admin' WHERE id=?").run(studentId)
      assert.equal((await request('/users', studentToken)).status, 403)
      assert.equal(runtime.db.prepare('SELECT role FROM users WHERE id=?').get(studentId)!.role, 'student')
      profiles.set(studentId, { ...profiles.get(studentId)!, role: 'contributor' })
      assert.equal((await request('/questions', studentToken)).status, 200)
      profiles.set(studentId, { ...profiles.get(studentId)!, role: 'student' })
      assert.equal((await request('/questions', studentToken)).status, 403)
      disabled.add(studentId)
      assert.equal((await request('/bootstrap', studentToken)).status, 403)
      disabled.delete(studentId)
      assert.equal((await request('/bootstrap', tokenFor(collisionId, validExpiry))).status, 409)
      assert.equal(runtime.db.prepare('SELECT id FROM users WHERE email=?').get('eleve@herbier.local')!.id, 'demo-student')
      assert.equal((await request('/bootstrap', adminToken)).status, 200)
      const users = await request('/users', adminToken)
      assert.equal(users.status, 200)
      assert.equal(users.body.length, 2)
      assert.ok(users.body.every((user: User) => !user.id.startsWith('demo-')))
      assert.equal((await request(`/users/${studentId}`, adminToken, 'PATCH', { role: 'admin' })).status, 409)
      const board = await request('/leaderboard', studentToken)
      assert.equal(board.body.length, 2)
      assert.ok(profileCalls >= 10)
    })

    await t.test('une identité cloud joue en solo avec un score local durable', async () => {
      const created = await request('/games/solo', studentToken, 'POST', { chapterIds: [], count: 1 })
      assert.equal(created.status, 201)
      const game = created.body as GameState
      assert.equal(game.deadline, null)
      assert.equal(game.hostId, studentId)
      const q = runtime.games.read(game.id).questions[0]!
      const answered = await request(`/games/${game.id}/answer`, studentToken, 'POST', { questionId: q.id, selected: q.correctAnswers })
      assert.equal(answered.status, 200)
      assert.equal(answered.body.result.points, 100)
      assert.equal((await request(`/games/${game.id}/next`, studentToken, 'POST', {})).body.status, 'finished')
      assert.equal((await request('/progress', studentToken)).body.totalPoints, 100)
    })

    await t.test('le flux Bearer se ferme après révocation, changement de rôle, expiration et déconnexion', async () => {
      const room = (await request('/rooms', studentToken, 'POST', { chapterIds: [], count: 1 })).body as GameState
      const controller = new AbortController()
      try {
        const response = await fetch(`${url}/api/games/${room.id}/events`, { headers: { Authorization: `Bearer ${studentToken}` }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(4000)]) })
        assert.equal(response.status, 200)
        const reader = response.body!.getReader()
        let received = ''
        while (!received.includes('event: state')) received += new TextDecoder().decode((await reader.read()).value)
        disabled.add(studentId)
        assert.equal((await reader.read()).done, true)
        disabled.delete(studentId)
        await reader.cancel()
      } finally { disabled.delete(studentId); controller.abort() }
      const roleController = new AbortController()
      try {
        const stream = await fetch(`${url}/api/games/${room.id}/events`, { headers: { Authorization: `Bearer ${studentToken}` }, signal: AbortSignal.any([roleController.signal, AbortSignal.timeout(4000)]) })
        const reader = stream.body!.getReader()
        let initial = ''
        while (!initial.includes('event: state')) initial += new TextDecoder().decode((await reader.read()).value)
        profiles.set(studentId, { ...profiles.get(studentId)!, role: 'contributor' })
        assert.equal((await reader.read()).done, true)
        assert.equal((await request('/bootstrap', studentToken)).body.user.role, 'contributor')
        await reader.cancel()
      } finally { profiles.set(studentId, { ...profiles.get(studentId)!, role: 'student' }); roleController.abort() }
      const expiring = tokenFor(studentId, Math.floor(Date.now() / 1000) + 2)
      tokens.set(expiring, studentId)
      const expiryController = new AbortController()
      try {
        const stream = await fetch(`${url}/api/games/${room.id}/events`, { headers: { Authorization: `Bearer ${expiring}` }, signal: AbortSignal.any([expiryController.signal, AbortSignal.timeout(4000)]) })
        assert.equal(stream.status, 200)
        const reader = stream.body!.getReader()
        let initial = ''
        while (!initial.includes('event: state')) initial += new TextDecoder().decode((await reader.read()).value)
        assert.equal((await reader.read()).done, true)
        await reader.cancel()
      } finally { expiryController.abort() }
      const logoutController = new AbortController()
      try {
        const stream = await fetch(`${url}/api/games/${room.id}/events`, { headers: { Authorization: `Bearer ${studentToken}` }, signal: AbortSignal.any([logoutController.signal, AbortSignal.timeout(4000)]) })
        const reader = stream.body!.getReader()
        let initial = ''
        while (!initial.includes('event: state')) initial += new TextDecoder().decode((await reader.read()).value)
        assert.equal((await request('/auth/logout', studentToken, 'POST', {})).status, 200)
        assert.equal((await reader.read()).done, true)
        await reader.cancel()
      } finally { logoutController.abort() }
    })
  } finally {
    await runtime.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('le vérificateur distingue la panne cloud du profil non autorisé', async () => {
  const token = tokenFor(studentId)
  const unavailable = createSupabaseTokenVerifier(config, () => ({ auth: { getUser: async () => ({ data: { user: null }, error: { status: 0 } }) }, rpc: async () => ({ data: null, error: null }) }))
  await assert.rejects(unavailable(token), (error: unknown) => error instanceof ApiError && error.status === 503)
  const throttled = createSupabaseTokenVerifier(config, () => ({ auth: { getUser: async () => ({ data: { user: null }, error: { status: 429 } }) }, rpc: async () => ({ data: null, error: null }) }))
  await assert.rejects(throttled(token), (error: unknown) => error instanceof ApiError && error.status === 503)
  const invalidProfile = createSupabaseTokenVerifier(config, () => ({ auth: { getUser: async () => ({ data: { user: { id: studentId } }, error: null }) }, rpc: async () => ({ data: { ...makeUser(studentId, 'student', 'student@cloud.example'), disabled_at: '2026-10-01' }, error: null }) }))
  await assert.rejects(invalidProfile(token), (error: unknown) => error instanceof ApiError && error.status === 403)
})

test('les JWT malformés sont refusés avant toute requête cloud', async () => {
  let calls = 0
  const verifier = createSupabaseTokenVerifier(config, () => {
    calls++
    throw new Error('Le réseau ne doit pas être appelé.')
  })
  const payloadToken = (payload: unknown) => `eyJhbGciOiJFUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.test-signature`
  for (const token of ['malformed-token', 'a.b', 'a.b.c.d', 'a..c', 'a.b.c=', 'a.@@@.c', 'a.not-json.c', payloadToken(null), payloadToken('texte'), payloadToken(42), payloadToken([]), payloadToken({ sub: studentId }), payloadToken({ sub: 'invalid-id', exp: 9999999999 }), payloadToken({ sub: studentId, exp: '9999999999' }), tokenFor(studentId, 1)]) {
    await assert.rejects(verifier(token), (error: unknown) => error instanceof ApiError && error.status === 401)
  }
  assert.equal(calls, 0)
  await assert.rejects(verifier(tokenFor(studentId)), (error: unknown) => error instanceof ApiError && error.status === 503)
  assert.equal(calls, 1)
})
