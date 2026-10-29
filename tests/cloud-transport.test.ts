import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SupabaseClient } from '@supabase/supabase-js'
import { readBackendMode } from '../src/services/backend-mode.ts'
import { cloudRoute, createCloudTransport, cloudStatus } from '../src/services/cloud-transport.ts'
import { createSessionService, type SessionState } from '../src/services/session-service.ts'
import { createSupabaseDataClient } from '../src/services/supabase-data.ts'

test('Pages utilise Supabase par défaut et le mode de démonstration reste explicite', () => {
  assert.equal(readBackendMode({ PROD: true }), 'supabase')
  assert.equal(readBackendMode({ MODE: 'cloud' }), 'supabase')
  assert.equal(readBackendMode({ MODE: 'development' }), 'local')
  assert.equal(readBackendMode({ PROD: true, VITE_BACKEND: 'local' }), 'local')
  assert.throws(() => readBackendMode({ VITE_BACKEND: 'unknown' }), /VITE_BACKEND/)
})

test('les commandes conservent leurs paramètres sans accepter un score ou un rôle comme autorité', () => {
  assert.deepEqual(cloudRoute('/api/games/partie/answer', 'POST', { questionId: 'question', selected: [1] }), { fn: 'qcm_game', action: 'answer', payload: { gameId: 'partie', questionId: 'question', selected: [1] } })
  assert.deepEqual(cloudRoute('/api/users/élève', 'PATCH', { role: 'contributor' }), { fn: 'qcm_content', action: 'update_user', payload: { role: 'contributor', userId: 'élève' } })
  assert.equal(cloudRoute('/api/leaderboard?chapterId=geologie', 'GET').payload.chapterId, 'geologie')
  assert.deepEqual(cloudRoute('/api/chapters/new-chapter', 'PATCH', { name: 'Chapitre 2' }), { fn: 'qcm_content', action: 'update_chapter', payload: { name: 'Chapitre 2', chapterId: 'new-chapter' } })
  assert.equal(cloudRoute('/api/chapters', 'POST', { name: 'Chapitre 1' }).action, 'create_chapter')
  assert.equal(cloudRoute('/api/questions/import', 'POST', { questions: [] }).action, 'import')
  assert.throws(() => cloudRoute('/api/private/question_keys', 'GET'), /disponible/)
  assert.equal(cloudStatus({ code: '42501' }), 403)
  assert.equal(cloudStatus({ code: 'PGRST301' }), 401)
})

function fixture() {
  const calls: { fn: string; action: string; payload: Record<string, unknown> }[] = []
  let result: unknown = {}
  let rpcError: unknown = null
  let imageCalls = 0
  const client = {
    rpc: (fn: string, args: { action: string; payload: Record<string, unknown> }) => {
      calls.push({ fn, ...args })
      const response = Promise.resolve({ data: structuredClone(result), error: rpcError })
      return Object.assign(response, { abortSignal: () => response })
    },
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'test-token', user: { id: 'student' } } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
    storage: { from: () => ({ createSignedUrls: async (paths: string[]) => { imageCalls++; return { data: paths.map(path => ({ path, signedUrl: `https://example.supabase.co/storage/v1/object/sign/${path}?token=temporary`, error: null })), error: null } } }) },
  } as unknown as SupabaseClient
  const rawTransport = createCloudTransport(() => client)
  const transport: typeof fetch = (input, options = {}) => rawTransport(input, { ...options, headers: options.headers ?? { Authorization: 'Bearer test-token' } })
  return { client, transport, calls, setResult: (data: unknown) => { result = data }, setError: (error: unknown) => { rpcError = error }, get imageCalls() { return imageCalls } }
}

test('une réponse utilise une seule RPC et la configuration ne demande aucun serveur local', async () => {
  const f = fixture()
  assert.deepEqual(await (await f.transport('/api/config')).json(), { authMode: 'supabase' })
  assert.equal(f.calls.length, 0)
  f.setResult({ result: { points: 100 } })
  const response = await f.transport('/api/games/game/answer', { method: 'POST', body: JSON.stringify({ selected: [0], questionId: 'q' }) })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).result.points, 100)
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0]?.fn, 'qcm_game')
})

test('les images privées sont signées une fois et leur clé est conservée pour édition et export', async () => {
  const f = fixture()
  f.setResult([{ id: 'q', image: 'owner/image.png' }])
  const first = await (await f.transport('/api/questions')).json()
  await f.transport('/api/questions')
  assert.equal(f.imageCalls, 1)
  assert.match(first[0].image, /token=temporary/)
  await f.transport('/api/questions/q', { method: 'PUT', body: JSON.stringify({ image: first[0].image }) })
  assert.equal(f.calls.at(-1)?.payload.image, 'owner/image.png')
  const exported = await (await f.transport('/api/questions/export')).json()
  assert.equal(exported[0].image, 'owner/image.png')
  await f.transport('/api/questions/q', { method: 'PUT', headers: { Authorization: 'Bearer refreshed-token' }, body: JSON.stringify({ image: 'https://example.supabase.co/storage/v1/object/sign/question-images/owner/image.png?token=old' }) })
  assert.equal(f.calls.at(-1)?.payload.image, 'owner/image.png')
})

test('les erreurs SQL sont visibles et une migration manquante ne provoque pas de secours local', async () => {
  const f = fixture()
  f.setError({ code: '42501', message: 'Accès refusé.' })
  assert.equal((await f.transport('/api/questions')).status, 403)
  f.setError({ code: 'PGRST202', message: 'Missing RPC' })
  const response = await f.transport('/api/bootstrap')
  assert.equal(response.status, 503)
  assert.match((await response.json()).message, /mise à jour/)
})

test('une session Pages restaurée charge le compte distant sans requête vers Node', async t => {
  const f = fixture()
  f.setResult({ user: { id: 'student', role: 'student', name: 'Camille' }, chapters: [], progress: {}, counts: {} })
  const state: SessionState = { user: null, bootstrap: null, loading: true, authMode: 'local', error: null }
  const service = createSessionService(state, { fetch: f.transport, getClient: () => f.client })
  t.after(service.dispose)
  await service.refreshSession()
  assert.equal(state.authMode, 'supabase')
  assert.equal(state.user?.id, 'student')
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0]?.action, 'bootstrap')
})

test('les requêtes et images gardent leur identité quand une autre session démarre', async () => {
  const requests: { token: string; path: string }[] = []
  let release: (() => void) | undefined
  const blocked = new Promise<void>(resolve => { release = resolve })
  let announced: (() => void) | undefined
  const entered = new Promise<void>(resolve => { announced = resolve })
  const transport = createCloudTransport(authorization => createSupabaseDataClient({ url: 'https://example.supabase.co', publishableKey: 'sb_publishable_test' }, authorization, async (input, init) => {
    const token = new Headers(init?.headers).get('Authorization') ?? ''
    const path = String(input)
    requests.push({ token, path })
    if (path.includes('/rpc/')) {
      if (token === 'Bearer account-A') { announced?.(); await blocked }
      return new Response(JSON.stringify([{ image: 'owner/image.png' }]), { headers: { 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify([{ path: 'owner/image.png', signedURL: `/object/sign/owner/image.png?token=${token.slice(7)}` }]), { headers: { 'Content-Type': 'application/json' } })
  }))
  const first = transport('/api/questions', { headers: { Authorization: 'Bearer account-A' } })
  await entered
  const second = await (await transport('/api/questions', { headers: { Authorization: 'Bearer account-B' } })).json()
  release?.()
  const previous = await (await first).json()
  const next = await (await transport('/api/questions', { headers: { Authorization: 'Bearer account-B' } })).json()
  assert.match(previous[0].image, /account-A/)
  assert.match(second[0].image, /account-B/)
  assert.equal(next[0].image, second[0].image)
  assert.equal(requests.filter(item => item.path.includes('/sign/') && item.token === 'Bearer account-B').length, 1)
  assert.equal(requests.filter(item => item.path.includes('/sign/') && item.token === 'Bearer account-A').length, 1)
  assert.equal((await transport('/api/rooms', { method: 'POST' })).status, 401)
})

test('modifier le pseudo appelle uniquement la RPC personnelle sans accepter un utilisateur ou un rôle cible', async () => {
  let argumentsReceived: unknown
  const transport = createCloudTransport(() => ({ rpc: (name: string, args: unknown) => { argumentsReceived = { name, args }; return Promise.resolve({ data: { id: 'student', username: 'yann' }, error: null }) } } as unknown as SupabaseClient))
  const response = await transport('/api/profile/username', { method: 'PATCH', headers: { Authorization: 'Bearer current-user' }, body: JSON.stringify({ username: 'yann', userId: 'other', role: 'admin' }) })
  assert.equal(response.status, 200)
  assert.deepEqual(argumentsReceived, { name: 'qcm_set_username', args: { candidate: 'yann' } })
})
