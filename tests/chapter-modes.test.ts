import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createApp } from '../server/index.ts'
import type { QuestionInput } from '../shared/types.ts'

test('chapitres et variantes : droits, imports liés, sélection et réponses contrôlés par le serveur', async t => {
  const runtime = createApp({ authMode: 'local', dbPath: ':memory:' })
  runtime.server.listen(0, '127.0.0.1')
  await once(runtime.server, 'listening')
  const address = runtime.server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}/api`
  function client() {
    let cookie = ''
    return async (path: string, method = 'GET', input?: unknown) => {
      const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) })
      cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie
      return { status: response.status, body: await response.json() }
    }
  }
  const admin = client(), student = client(), contributor = client()
  try {
    await admin('/auth/login', 'POST', { email: 'admin@herbier.local', password: 'Herbier2026!' })
    await student('/auth/login', 'POST', { email: 'eleve@herbier.local', password: 'Herbier2026!' })
    await contributor('/auth/login', 'POST', { email: 'contributeur@herbier.local', password: 'Herbier2026!' })
    for (const request of [student, contributor]) assert.equal((await request('/chapters', 'POST', { name: 'Interdit' })).status, 403)
    assert.equal((await admin('/chapters', 'POST', { name: ' ' })).status, 400)
    const created = await admin('/chapters', 'POST', { name: 'Chapitre 1 — Cellules' })
    assert.equal(created.status, 201)
    const chapterId = created.body.id
    await t.test('un administrateur crée et renomme un chapitre sans changer son identifiant', async () => {
      const result = await admin(`/chapters/${chapterId}`, 'PATCH', { name: 'Chapitre 1 — Membranes', description: 'Notions et réflexes' })
      assert.equal(result.status, 200)
      assert.equal(result.body.id, chapterId)
      assert.equal(result.body.shortName, 'Chapitre 1 — Membranes')
      assert.equal((await student(`/chapters/${chapterId}`, 'PATCH', { name: 'Interdit' })).status, 403)
      assert.equal((await admin('/chapters/absent', 'PATCH', { name: 'Absent' })).status, 404)
    })
    const input: QuestionInput = { chapterId, difficulty: 'hard', prompt: 'Quelles affirmations décrivent une membrane ?', options: ['Une bicouche', 'Des protéines', 'Un chromosome', 'Un ribosome'], correctAnswers: [0, 1], explanation: 'Une membrane comporte une bicouche lipidique et des protéines.', image: null, status: 'pending' }
    const solo = (await admin('/questions', 'POST', input)).body
    const challengeInput = { ...input, usage: 'challenge', sourceQuestionId: solo.id, correctAnswers: [0], prompt: 'Quelle structure forme la base de la membrane ?' }
    await t.test('un QCS possède une seule bonne réponse et une source solo accessible du même chapitre', async () => {
      assert.equal((await admin('/questions', 'POST', { ...challengeInput, correctAnswers: [0, 1] })).status, 400)
      assert.equal((await admin('/questions', 'POST', { ...challengeInput, sourceQuestionId: null })).status, 400)
      assert.equal((await admin('/questions', 'POST', { ...challengeInput, chapterId: 'cellulaire' })).status, 400)
      assert.equal((await contributor('/questions', 'POST', challengeInput)).status, 400)
      assert.equal((await admin('/questions', 'POST', { ...input, sourceQuestionId: solo.id })).status, 400)
    })
    const challenge = (await admin('/questions', 'POST', challengeInput)).body
    await admin(`/questions/${solo.id}/review`, 'POST', { status: 'published' })
    await admin(`/questions/${challenge.id}/review`, 'POST', { status: 'published' })
    await t.test('les liens empêchent une suppression ou un reclassement incohérent', async () => {
      assert.equal((await admin(`/questions/${solo.id}`, 'DELETE')).status, 400)
      assert.equal((await admin(`/questions/${solo.id}`, 'PUT', { ...input, chapterId: 'cellulaire' })).status, 400)
      assert.equal((await admin('/questions', 'POST', { ...challengeInput, sourceQuestionId: challenge.id })).status, 400)
    })
    await t.test('chaque mode tire ses questions et le défi refuse plusieurs choix même via HTTP', async () => {
      const bootstrap = (await student('/bootstrap')).body
      assert.equal(bootstrap.counts[chapterId], 1)
      assert.equal(bootstrap.challengeCounts[chapterId], 1)
      const game = (await student('/games/solo', 'POST', { chapterIds: [chapterId], count: 10 })).body
      assert.equal(game.totalQuestions, 1)
      assert.equal(game.question.id, solo.id)
      assert.equal(game.deadline, null)
      assert.equal('correctAnswers' in game.question, false)
      const room = (await student('/rooms', 'POST', { chapterIds: [chapterId], count: 10 })).body
      await admin('/rooms/join', 'POST', { code: room.code })
      const started = (await student(`/games/${room.id}/start`, 'POST', {})).body
      assert.equal(started.totalQuestions, 1)
      assert.equal(started.question.id, challenge.id)
      assert.equal((await student(`/games/${room.id}/answer`, 'POST', { questionId: challenge.id, selected: [0, 1] })).status, 400)
      assert.equal((await student(`/games/${room.id}/answer`, 'POST', { questionId: challenge.id, selected: [0], points: 999999 })).status, 200)
    })
    await t.test('un import remappe les liens dans les deux ordres et annule tout sur erreur', async () => {
      const result = await admin('/questions/import', 'POST', { questions: [challenge, solo] })
      assert.equal(result.status, 201)
      const questions = (await admin(`/questions?chapterId=${chapterId}`)).body
      assert.equal(questions.length, 4)
      const imported = questions.find((q: { usage: string; id: string }) => q.usage === 'challenge' && q.id !== challenge.id)
      assert.notEqual(imported.sourceQuestionId, solo.id)
      assert.ok(questions.some((q: { id: string; usage: string }) => q.id === imported.sourceQuestionId && q.usage === 'solo'))
      assert.equal((await admin('/questions/import', 'POST', { questions: [input, { ...challengeInput, correctAnswers: [0, 1] }] })).status, 400)
      assert.equal((await admin(`/questions?chapterId=${chapterId}`)).body.length, 4)
      assert.equal((await admin('/questions/import', 'POST', { questions: [solo, challenge] })).status, 201)
      assert.equal((await admin(`/questions?chapterId=${chapterId}`)).body.length, 6)
    })
  } finally { await runtime.close() }
})
