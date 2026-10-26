import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { createApp } from '../server/index.ts'
import type { GameState, Question, QuestionInput } from '../shared/types.ts'

class Client {
  cookie = ''
  url: string
  constructor(url: string) { this.url = url }
  async request(path: string, method = 'GET', body?: unknown) {
    const response = await fetch(`${this.url}/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(this.cookie ? { Cookie: this.cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const cookie = response.headers.get('set-cookie')
    if (cookie) this.cookie = cookie.split(';')[0]!
    return { status: response.status, body: await response.json(), headers: response.headers }
  }
  async login(email: string) {
    const response = await this.request('/auth/login', 'POST', { email, password: 'Herbier2026!' })
    assert.equal(response.status, 200)
    return response.body.user
  }
}

test('API locale : sessions, permissions, validation, parties et persistance', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'herbier-api-'))
  let runtime = createApp({ authMode: 'local', dbPath: join(directory, 'test.sqlite'), uploadsDir: join(directory, 'uploads'), questionDurationMs: 1200, correctionDurationMs: 70 })
  runtime.server.listen(0, '127.0.0.1')
  await once(runtime.server, 'listening')
  const address = runtime.server.address()
  assert.ok(address && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}`
  const anonymous = new Client(url)
  const student = new Client(url)
  const admin = new Client(url)
  const contributor = new Client(url)
  const second = new Client(url)
  let questions: Question[] = []
  let chapterId = ''
  let studentId = ''
  const input: QuestionInput = { chapterId: '', difficulty: 'medium', prompt: 'Quel organite est délimité par une double membrane ?', options: ['Mitochondrie', 'Ribosome', 'Lysosome', 'Peroxysome'], correctAnswers: [0], explanation: 'La mitochondrie possède une membrane externe et une membrane interne.', image: null, status: 'pending' }
  try {
    await t.test('authentification, cookies et inscription limitée au rôle élève', async () => {
      assert.equal((await anonymous.request('/bootstrap')).status, 401)
      assert.equal((await anonymous.request('/auth/login', 'POST', { email: 'eleve@herbier.local', password: 'incorrect' })).status, 401)
      const login = await student.request('/auth/login', 'POST', { email: 'eleve@herbier.local', password: 'Herbier2026!' })
      assert.equal(login.status, 200)
      assert.match(login.headers.get('set-cookie')!, /HttpOnly/i)
      assert.match(login.headers.get('set-cookie')!, /SameSite=Strict/i)
      assert.equal('password_hash' in login.body.user, false)
      studentId = login.body.user.id
      await admin.login('admin@herbier.local')
      await contributor.login('contributeur@herbier.local')
      const register = await second.request('/auth/register', 'POST', { name: 'Élève de test', email: 'test@example.fr', password: 'UnMotDePasse2026!', role: 'admin' })
      assert.equal(register.status, 201)
      assert.equal(register.body.user.role, 'student')
      const bootstrap = await student.request('/bootstrap')
      assert.equal(bootstrap.body.chapters.length, 5)
      chapterId = bootstrap.body.chapters[0].id
      input.chapterId = chapterId
      assert.equal((await student.request('/users')).status, 403)
      assert.equal((await contributor.request('/users')).status, 403)
      assert.equal((await student.request('/questions')).status, 403)
      questions = (await admin.request('/questions')).body
      assert.ok(questions.length >= 30)
    })

    await t.test('les contributions nécessitent une validation et les imports sont atomiques', async () => {
      assert.equal((await student.request('/questions', 'POST', input)).status, 403)
      assert.equal((await contributor.request('/questions', 'POST', { ...input, status: 'published' })).status, 400)
      const created = await contributor.request('/questions', 'POST', input)
      assert.equal(created.status, 201)
      const id = created.body.id
      assert.equal((await contributor.request(`/questions/${id}/review`, 'POST', { status: 'published' })).status, 403)
      assert.equal((await admin.request(`/questions/${id}/review`, 'POST', { status: 'published' })).status, 200)
      assert.equal((await contributor.request(`/questions/${id}`, 'PUT', input)).status, 403)
      const countBefore = (await contributor.request('/questions')).body.length
      const invalid = await contributor.request('/questions/import', 'POST', { questions: [input, { ...input, correctAnswers: [8] }] })
      assert.equal(invalid.status, 400)
      assert.equal((await contributor.request('/questions')).body.length, countBefore)
      const imported = await contributor.request('/questions/import', 'POST', { questions: [questions[0]] })
      assert.equal(imported.status, 201)
      assert.equal(imported.body.imported, 1)
      const owned = (await contributor.request('/questions')).body as Question[]
      assert.equal(owned.filter(q => q.status === 'pending').length, 1)
      const selfDemote = await admin.request('/users/demo-admin', 'PATCH', { role: 'student' })
      assert.equal(selfDemote.status, 400)
      const forbiddenImage = await contributor.request('/uploads', 'POST', { dataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' })
      assert.equal(forbiddenImage.status, 400)
    })

    await t.test('les permissions sont vérifiées sur chaque écriture et les sessions résistent à la falsification', async () => {
      const published = questions[0]!
      assert.equal((await student.request(`/questions/${published.id}`, 'DELETE')).status, 403)
      assert.equal((await student.request(`/questions/${published.id}/review`, 'POST', { status: 'published' })).status, 403)
      assert.equal((await student.request('/questions/import', 'POST', { questions: [input] })).status, 403)
      assert.equal((await contributor.request(`/questions/${published.id}`, 'PUT', input)).status, 403)
      assert.equal((await contributor.request(`/questions/${published.id}`, 'DELETE')).status, 403)
      const peer = (await second.request('/bootstrap')).body.user
      assert.equal((await student.request(`/users/${peer.id}`, 'PATCH', { role: 'admin' })).status, 403)
      const promoted = await admin.request(`/users/${peer.id}`, 'PATCH', { role: 'contributor' })
      assert.equal(promoted.status, 200)
      assert.equal((await second.request('/bootstrap')).body.user.role, 'contributor')
      assert.equal((await second.request('/questions')).status, 200)
      assert.equal((await admin.request(`/users/${peer.id}`, 'PATCH', { role: 'student' })).status, 200)
      assert.equal((await second.request('/questions')).status, 403)
      const forged = new Client(url)
      forged.cookie = `${student.cookie.slice(0, -1)}${student.cookie.endsWith('a') ? 'b' : 'a'}`
      assert.equal((await forged.request('/bootstrap')).status, 401)
      const csrf = await fetch(`${url}/api/games/solo`, { method: 'POST', headers: { Cookie: student.cookie, Origin: 'https://exemple-externe.invalid', 'Content-Type': 'application/json' }, body: JSON.stringify({ chapterIds: [], count: 1 }) })
      assert.equal(csrf.status, 403)
      for (const path of ['/server/seed.ts', '/data/herbier.sqlite', '/@fs/C:/application/server/database.ts', '/@fs/C:/application/data/herbier.sqlite-wal', '/%73erver/seed.ts', '/.env.local']) {
        const privateFile = await fetch(`${url}${path}`)
        assert.equal(privateFile.status, 404, path)
      }
    })

    await t.test('les images sont persistées, servies et vérifiées par contenu et taille', async () => {
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII='
      assert.equal((await student.request('/uploads', 'POST', { dataUrl: `data:image/png;base64,${png}` })).status, 403)
      assert.equal((await contributor.request('/uploads', 'POST', { dataUrl: `data:image/jpeg;base64,${png}` })).status, 400)
      const oversized = Buffer.alloc(2 * 1024 * 1024 + 1)
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(oversized)
      const tooLarge = await contributor.request('/uploads', 'POST', { dataUrl: `data:image/png;base64,${oversized.toString('base64')}` })
      assert.equal(tooLarge.status, 400)
      const uploaded = await contributor.request('/uploads', 'POST', { dataUrl: `data:image/png;base64,${png}` })
      assert.equal(uploaded.status, 201)
      assert.match(uploaded.body.url, /^\/uploads\/[a-f0-9-]+\.png$/)
      const image = await fetch(`${url}${uploaded.body.url}`)
      assert.equal(image.status, 200)
      assert.equal(image.headers.get('x-content-type-options'), 'nosniff')
      assert.match(image.headers.get('content-type')!, /image\/png/)
      assert.deepEqual(Buffer.from(await image.arrayBuffer()), Buffer.from(png, 'base64'))
      const illustrated = await contributor.request('/questions', 'POST', { ...input, image: uploaded.body.url })
      assert.equal(illustrated.status, 201)
      assert.equal(illustrated.body.image, uploaded.body.url)
      assert.equal((await contributor.request('/questions', 'POST', { ...input, image: 'javascript:alert(1)' })).status, 400)
    })

    await t.test('le solo protège les corrections et calcule les points côté serveur', async () => {
      const created = await student.request('/games/solo', 'POST', { chapterIds: [chapterId], difficulty: 'all', count: 1 })
      assert.equal(created.status, 201)
      const game = created.body as GameState
      assert.ok(game.question)
      assert.equal(game.deadline, null)
      assert.equal('correctAnswers' in game.question, false)
      assert.equal('explanation' in game.question, false)
      assert.equal('authorId' in game.question, false)
      assert.deepEqual(game.results, [])
      assert.equal(game.result, null)
      const q = questions.find(q => q.id === game.question!.id) ?? (await admin.request('/questions')).body.find((q: Question) => q.id === game.question!.id)
      const wrongQuestion = await student.request(`/games/${game.id}/answer`, 'POST', { questionId: 'stale-question', selected: q.correctAnswers })
      assert.equal(wrongQuestion.status, 409)
      const answer = await student.request(`/games/${game.id}/answer`, 'POST', { questionId: q.id, selected: q.correctAnswers, points: 999999, elapsedMs: 0 })
      assert.equal(answer.status, 200)
      assert.equal(answer.body.result.correct, true)
      assert.equal(answer.body.result.points, 100)
      assert.equal(answer.body.deadline, null)
      assert.deepEqual(answer.body.result.correctAnswers, q.correctAnswers)
      const duplicate = await student.request(`/games/${game.id}/answer`, 'POST', { questionId: q.id, selected: q.correctAnswers })
      assert.equal(duplicate.status, 409)
      const next = await student.request(`/games/${game.id}/next`, 'POST', {})
      assert.equal(next.body.status, 'finished')
      assert.equal((await student.request(`/games/${game.id}/answer`, 'POST', { questionId: q.id, selected: q.correctAnswers })).status, 409)
      const progress = (await student.request('/progress')).body
      assert.equal(progress.answered, 1)
      assert.equal(progress.correct, 1)
      assert.equal(progress.gamesPlayed, 1)
      assert.equal(progress.totalPoints, answer.body.result.points)
      const board = (await student.request(`/leaderboard?chapterId=${chapterId}`)).body
      assert.equal(board.length, 4)
      assert.equal(board[0].userId, studentId)
      assert.equal(board[0].points, answer.body.result.points)
      assert.ok(board.some((row: { points: number }) => row.points === 0))
      assert.equal((await second.request(`/games/${game.id}`)).status, 403)
    })

    await t.test('le solo accepte une réflexion prolongée sans chronomètre ni bonus de rapidité', async () => {
      const game = (await contributor.request('/games/solo', 'POST', { chapterIds: [chapterId], difficulty: 'all', count: 2 })).body as GameState
      const saved = runtime.games.read(game.id)
      saved.startedAt = Date.now() - 3600_000
      saved.deadline = Date.now() - 3598_800
      runtime.games.save(saved)
      const resumed = (await contributor.request(`/games/${game.id}`)).body as GameState
      assert.equal(resumed.deadline, null)
      assert.equal(resumed.phase, 'question')
      assert.equal(resumed.question!.id, game.question!.id)
      assert.equal(resumed.result, null)
      assert.equal(runtime.games.read(game.id).deadline, null)
      assert.equal(runtime.games.advance(runtime.games.read(game.id)), false)
      const q = (await admin.request('/questions')).body.find((q: Question) => q.id === game.question!.id) as Question
      const answered = await contributor.request(`/games/${game.id}/answer`, 'POST', { questionId: q.id, selected: q.correctAnswers })
      assert.equal(answered.status, 200)
      assert.equal(answered.body.result.correct, true)
      assert.equal(answered.body.result.points, 100)
      assert.ok(answered.body.result.elapsedMs >= 3600_000)
      assert.equal(answered.body.deadline, null)
      assert.equal(runtime.games.read(game.id).correctionUntil, null)
      await delay(100)
      const correction = (await contributor.request(`/games/${game.id}`)).body as GameState
      assert.equal(correction.phase, 'correction')
      assert.equal(correction.questionIndex, 0)
      const next = (await contributor.request(`/games/${game.id}/next`, 'POST', {})).body as GameState
      assert.equal(next.questionIndex, 1)
      assert.equal(next.deadline, null)
      const secondQuestion = (await admin.request('/questions')).body.find((q: Question) => q.id === next.question!.id) as Question
      const incorrect = secondQuestion.correctAnswers.length === 1 && secondQuestion.correctAnswers[0] === 0 ? [1] : [0]
      const wrong = await contributor.request(`/games/${game.id}/answer`, 'POST', { questionId: secondQuestion.id, selected: incorrect })
      assert.equal(wrong.body.result.correct, false)
      assert.equal(wrong.body.result.points, 0)
      assert.equal(wrong.body.deadline, null)
    })

    await t.test('les délais multijoueurs restent autoritaires et les erreurs alimentent les révisions', async () => {
      const room = (await student.request('/rooms', 'POST', { chapterIds: [chapterId], difficulty: 'all', count: 1 })).body as GameState
      assert.equal((await second.request('/rooms/join', 'POST', { code: room.code })).status, 200)
      const game = (await student.request(`/games/${room.id}/start`, 'POST', {})).body as GameState
      assert.ok(game.deadline)
      await delay(1350)
      const state = (await student.request(`/games/${game.id}`)).body as GameState
      assert.equal(state.phase, 'correction')
      assert.equal(state.result!.points, 0)
      assert.equal(state.result!.correct, false)
      assert.deepEqual(state.result!.selected, [])
      const late = await student.request(`/games/${game.id}/answer`, 'POST', { questionId: game.question!.id, selected: [0] })
      assert.equal(late.status, 409)
      const progress = (await student.request('/progress')).body
      assert.ok(progress.mistakes.some((m: { questionId: string }) => m.questionId === game.question!.id))
      const retry = (await student.request('/games/solo', 'POST', { chapterIds: [chapterId], difficulty: 'all', count: 5, mistakesOnly: true })).body as GameState
      assert.equal(retry.totalQuestions, 1)
      assert.equal(retry.deadline, null)
      assert.equal(retry.question!.id, game.question!.id)
      const q = (await admin.request('/questions')).body.find((q: Question) => q.id === retry.question!.id) as Question
      assert.equal((await student.request(`/games/${retry.id}/answer`, 'POST', { questionId: q.id, selected: q.correctAnswers })).status, 200)
      assert.equal((await student.request('/progress')).body.mistakes.length, 0)
      assert.equal((await student.request('/games/solo', 'POST', { chapterIds: [chapterId], difficulty: 'all', count: 5, mistakesOnly: true })).status, 400)
    })

    await t.test('les salons synchronisent les joueurs et le serveur refuse les réponses obsolètes', async () => {
      const room = (await student.request('/rooms', 'POST', { chapterIds: [chapterId], difficulty: 'all', count: 2 })).body as GameState
      assert.equal(room.status, 'waiting')
      assert.match(room.code!, /^[A-Z2-9]{6}$/)
      assert.equal(room.question, null)
      assert.equal((await student.request(`/games/${room.id}/start`, 'POST', {})).status, 400)
      assert.equal((await second.request('/rooms/join', 'POST', { code: room.code!.toLowerCase() })).status, 200)
      assert.equal((await second.request(`/games/${room.id}/start`, 'POST', {})).status, 403)
      const started = (await student.request(`/games/${room.id}/start`, 'POST', {})).body as GameState
      const peer = (await second.request(`/games/${room.id}`)).body as GameState
      assert.equal(peer.question!.id, started.question!.id)
      assert.equal(peer.deadline, started.deadline)
      assert.equal((await contributor.request('/rooms/join', 'POST', { code: room.code })).status, 409)
      const q = (await admin.request('/questions')).body.find((q: Question) => q.id === started.question!.id) as Question
      const beforeProgress = (await student.request('/progress')).body
      const beforeBoard = (await second.request('/leaderboard')).body
      const previousPoints = beforeBoard.find((row: { userId: string }) => row.userId === studentId).points
      const answered = (await student.request(`/games/${room.id}/answer`, 'POST', { questionId: q.id, selected: q.correctAnswers })).body as GameState
      assert.equal(answered.result, null)
      assert.equal(answered.players.find(p => p.id === studentId)!.answered, true)
      const hidden = (await second.request(`/games/${room.id}`)).body as GameState
      assert.equal(hidden.result, null)
      assert.deepEqual(hidden.results, [])
      assert.equal(hidden.players.find(p => p.id === studentId)!.score, 0)
      const concealedProgress = (await student.request('/progress')).body
      assert.equal(concealedProgress.totalPoints, beforeProgress.totalPoints)
      assert.equal(concealedProgress.answered, beforeProgress.answered)
      assert.equal(concealedProgress.correct, beforeProgress.correct)
      assert.deepEqual(concealedProgress.daily, beforeProgress.daily)
      const concealedBootstrap = (await student.request('/bootstrap')).body
      assert.equal(concealedBootstrap.progress.totalPoints, beforeProgress.totalPoints)
      const concealedBoard = (await second.request('/leaderboard')).body
      assert.equal(concealedBoard.find((row: { userId: string }) => row.userId === studentId).points, previousPoints)
      const otherAnswer = await second.request(`/games/${room.id}/answer`, 'POST', { questionId: q.id, selected: q.correctAnswers })
      assert.equal(otherAnswer.body.phase, 'correction')
      assert.ok(otherAnswer.body.result.points >= 100 && otherAnswer.body.result.points <= 150)
      assert.ok(otherAnswer.body.deadline)
      assert.equal((await student.request('/progress')).body.answered, beforeProgress.answered + 1)
      await delay(110)
      const next = (await student.request(`/games/${room.id}`)).body as GameState
      assert.equal(next.questionIndex, 1)
      assert.equal(next.phase, 'question')
      assert.notEqual(next.question!.id, q.id)
      assert.equal((await student.request(`/games/${room.id}/answer`, 'POST', { questionId: q.id, selected: [0] })).status, 409)
      assert.equal((await student.request(`/games/${room.id}/next`, 'POST', {})).status, 403)
    })

    await t.test('le canal temps réel authentifie les abonnements et respecte les salons', async () => {
      const room = (await student.request('/rooms', 'POST', { chapterIds: [chapterId], difficulty: 'all', count: 1 })).body as GameState
      const controller = new AbortController()
      try {
        const response = await fetch(`${url}/api/games/${room.id}/events`, { headers: { Cookie: student.cookie }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) })
        assert.equal(response.status, 200)
        assert.match(response.headers.get('content-type')!, /text\/event-stream/)
        const reader = response.body!.getReader()
        let raw = ''
        while (!/event: state\ndata: .+\n\n/.test(raw)) { const { value } = await reader.read(); raw += new TextDecoder().decode(value) }
        const state = JSON.parse(raw.split('\n').find(line => line.startsWith('data: '))!.slice(6)) as GameState
        assert.equal(state.id, room.id)
        assert.equal(state.players[0]!.connected, true)
        assert.equal((await anonymous.request(`/games/${room.id}/events`)).status, 401)
        assert.equal((await second.request(`/games/${room.id}/events`)).status, 403)
        const obsolete = new Client(url)
        obsolete.cookie = student.cookie
        await student.login('eleve@herbier.local')
        assert.equal((await obsolete.request('/bootstrap')).status, 401)
        assert.equal((await reader.read()).done, true)
        await reader.cancel()
      } finally { controller.abort() }
    })

    await t.test('les sessions, résultats et salons survivent au redémarrage', async () => {
      const before = (await student.request('/progress')).body
      const room = (await student.request('/rooms', 'POST', { chapterIds: [chapterId], difficulty: 'all', count: 1 })).body as GameState
      const solo = (await student.request('/games/solo', 'POST', { chapterIds: [chapterId], difficulty: 'all', count: 1 })).body as GameState
      const soloRecord = runtime.games.read(solo.id)
      soloRecord.startedAt = Date.now() - 3600_000
      runtime.games.save(soloRecord)
      await runtime.close()
      runtime = createApp({ authMode: 'local', dbPath: join(directory, 'test.sqlite'), uploadsDir: join(directory, 'uploads') })
      runtime.server.listen(0, '127.0.0.1')
      await once(runtime.server, 'listening')
      const restartedAddress = runtime.server.address()
      assert.ok(restartedAddress && typeof restartedAddress !== 'string')
      for (const client of [anonymous, student, admin, contributor, second]) client.url = `http://127.0.0.1:${restartedAddress.port}`
      const after = await student.request('/progress')
      assert.equal(after.status, 200)
      assert.equal(after.body.totalPoints, before.totalPoints)
      assert.equal(after.body.answered, before.answered)
      const persisted = (await student.request(`/games/${room.id}`)).body as GameState
      assert.equal(persisted.code, room.code)
      assert.equal(persisted.status, 'waiting')
      const resumed = (await student.request(`/games/${solo.id}`)).body as GameState
      assert.equal(resumed.mode, 'solo')
      assert.equal(resumed.phase, 'question')
      assert.equal(resumed.question!.id, solo.question!.id)
      assert.equal(resumed.deadline, null)
      const q = (await admin.request('/questions')).body.find((q: Question) => q.id === resumed.question!.id) as Question
      const answered = await student.request(`/games/${solo.id}/answer`, 'POST', { questionId: q.id, selected: q.correctAnswers })
      assert.equal(answered.status, 200)
      assert.equal(answered.body.result.points, 100)
      assert.ok(answered.body.result.elapsedMs >= 3600_000)
      const logout = await student.request('/auth/logout', 'POST', {})
      assert.equal(logout.status, 200)
      assert.equal((await student.request('/bootstrap')).status, 401)
    })
  } finally {
    await runtime.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
