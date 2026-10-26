import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createVerifiedSessions } from '../server/verified-sessions.ts'
import { createApp } from '../server/index.ts'
import type { VerifiedSupabaseIdentity } from '../server/supabase-auth.ts'

const identity: VerifiedSupabaseIdentity = { user: { id: '11111111-1111-4111-8111-111111111111', name: 'Camille', email: 'camille@example.test', role: 'student', createdAt: '2026-10-21T12:00:00Z' }, expiresAt: 3600000 }

test('les lectures réutilisent une session vérifiée sans prolonger sa durée', async () => {
  let now = 0
  let calls = 0
  const sessions = createVerifiedSessions(async () => { calls++; return identity }, () => now)
  await Promise.all([sessions.get('token'), sessions.get('token')])
  assert.equal(calls, 1)
  now = 299999
  await sessions.get('token')
  assert.equal(calls, 1)
  now = 300001
  await sessions.get('token')
  assert.equal(calls, 2)
  sessions.close()
})

test('une vérification en arrière-plan ne bloque pas une réponse déjà autorisée', async () => {
  let release!: (value: VerifiedSupabaseIdentity) => void
  let slow = false
  const sessions = createVerifiedSessions(() => slow ? new Promise(resolve => { release = resolve }) : Promise.resolve(identity), () => 0)
  await sessions.get('token')
  slow = true
  const background = sessions.get('token', true)
  await Promise.resolve()
  assert.equal((await sessions.get('token')).user.id, identity.user.id)
  release(identity)
  await background
  sessions.close()
})

test('expiration du JWT et échec d’un contrôle interdisent toute réutilisation', async () => {
  let now = 0
  let revoked = false
  let calls = 0
  const sessions = createVerifiedSessions(async () => { calls++; if (revoked) throw new Error('Profil désactivé.'); return { ...identity, expiresAt: 10000 } }, () => now)
  await sessions.get('token-a')
  await sessions.get('token-b')
  revoked = true
  await assert.rejects(sessions.get('token-a', true), /désactivé/)
  await assert.rejects(sessions.get('token-b'), /désactivé/)
  assert.equal(calls, 4)
  revoked = false
  await sessions.get('token-a')
  now = 10000
  await assert.rejects(sessions.get('token-a'), /expirée/)
  assert.equal(calls, 5)
  sessions.close()
})

test('un contrôle terminé après déconnexion ne rétablit pas la session', async () => {
  let release!: (value: VerifiedSupabaseIdentity) => void
  let slow = false
  const sessions = createVerifiedSessions(() => slow ? new Promise(resolve => { release = resolve }) : Promise.resolve(identity), () => 0)
  await sessions.get('token')
  slow = true
  const pending = sessions.get('token', true)
  await Promise.resolve()
  sessions.invalidateUser(identity.user.id)
  release(identity)
  await assert.rejects(pending, /invalidée/)
  sessions.close()
})

test('un changement de rôle invalide aussi les autres jetons connus du compte', async () => {
  let role = identity.user.role
  let calls = 0
  const sessions = createVerifiedSessions(async () => { calls++; return { ...identity, user: { ...identity.user, role } } }, () => 0)
  await sessions.get('token-a')
  await sessions.get('token-b')
  role = 'contributor'
  await sessions.get('token-a', true)
  assert.equal((await sessions.get('token-b')).user.role, 'contributor')
  assert.equal(calls, 4)
  sessions.close()
})

test('une série de réponses ne refait pas le trajet Supabase et les accès privilégiés restent vérifiés', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'qcm-response-speed-'))
  let verificationCalls = 0
  const runtime = createApp({ authMode: 'supabase', supabaseConfig: { url: 'https://example.supabase.co', publishableKey: 'sb_publishable_test' },
    dbPath: join(directory, 'test.sqlite'), uploadsDir: join(directory, 'uploads'),
    verifySupabaseToken: async () => { verificationCalls++; await delay(350); return { ...identity, expiresAt: Date.now() + 3600000 } },
  })
  runtime.server.listen(0, '127.0.0.1')
  await once(runtime.server, 'listening')
  const address = runtime.server.address()
  assert.ok(address && typeof address !== 'string')
  const request = async (path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${address.port}/api${path}`, { headers: { Authorization: 'Bearer test-verified-token', 'Content-Type': 'application/json' }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) })
    return { status: res.status, body: await res.json() }
  }
  try {
    const coldStart = performance.now()
    assert.equal((await request('/bootstrap')).status, 200)
    const coldMs = performance.now() - coldStart
    assert.equal(verificationCalls, 1)
    const game = (await request('/games/solo', { count: 3 })).body
    const durations: number[] = []
    for (let i = 0; i < 3; i++) {
      const q = runtime.games.read(game.id).questions[i]!
      const started = performance.now()
      const result = await request(`/games/${game.id}/answer`, { selected: q.correctAnswers, questionId: q.id })
      durations.push(performance.now() - started)
      assert.equal(result.status, 200)
      assert.equal(result.body.result.points, 100)
      assert.equal((await request(`/games/${game.id}/next`, {})).status, 200)
    }
    assert.equal(verificationCalls, 1)
    assert.equal((await request('/questions')).status, 403)
    assert.equal(verificationCalls, 2)
    assert.equal((await request('/QuEsTiOnS')).status, 403)
    assert.equal(verificationCalls, 3)
    t.diagnostic(`Supabase simulé : premier accès ${Math.round(coldMs)} ms ; réponses ${durations.map(ms => `${Math.round(ms)} ms`).join(', ')} ; aucun nouvel appel Auth pour les réponses.`)
  } finally { await runtime.close(); rmSync(directory, { recursive: true, force: true }) }
})
