import type { DatabaseSync } from 'node:sqlite'
import { randomInt, randomUUID } from 'node:crypto'
import type { AnswerResult, Difficulty, GameState, Question, User } from '../shared/types.ts'
import { readQuestions, readVisibleAnswers } from './database.ts'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

export interface StoredGame {
  id: string
  mode: 'solo' | 'multi'
  code?: string
  status: GameState['status']
  phase: GameState['phase']
  chapterIds: string[]
  hostId: string
  players: { id: string; name: string }[]
  questions: Question[]
  questionIndex: number
  startedAt: number | null
  deadline: number | null
  correctionUntil: number | null
  createdAt: string
}

export class Games {
  private db: DatabaseSync
  readonly duration: number
  readonly correctionDuration: number
  constructor(db: DatabaseSync, duration = 30_000, correctionDuration = 5_000) { this.db = db; this.duration = duration; this.correctionDuration = correctionDuration }

  read(id: string): StoredGame {
    const row = this.db.prepare('SELECT body FROM games WHERE id=?').get(id)
    if (!row) throw new ApiError(404, 'Partie introuvable.')
    const game = JSON.parse(String(row.body)) as StoredGame
    if (game.mode === 'solo' && (game.deadline !== null || game.correctionUntil !== null)) {
      game.deadline = null
      game.correctionUntil = null
      this.save(game)
    }
    return game
  }

  save(game: StoredGame) {
    this.db.prepare('INSERT INTO games(id,code,body,status,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,status=excluded.status,updated_at=excluded.updated_at').run(game.id, game.code ?? null, JSON.stringify(game), game.status, Date.now())
  }

  member(game: StoredGame, userId: string) {
    if (!game.players.some(p => p.id === userId)) throw new ApiError(403, 'Vous ne participez pas à cette partie.')
  }

  create(user: User, mode: 'solo' | 'multi', config: { chapterIds: string[]; difficulty: 'all' | Difficulty; count: number; mistakesOnly?: boolean }) {
    let pool = readQuestions(this.db).filter(q => q.status === 'published' && config.chapterIds.includes(q.chapterId) && (config.difficulty === 'all' || q.difficulty === config.difficulty))
    if (config.mistakesOnly) {
      const latest = new Map<string, boolean>()
      for (const answer of readVisibleAnswers(this.db, user.id)) latest.set(String(answer.question_id), Number(answer.correct) === 0)
      const ids = new Set([...latest].filter(([, wrong]) => wrong).map(([id]) => id))
      pool = pool.filter(q => ids.has(q.id))
    }
    if (!pool.length) throw new ApiError(400, 'Aucune question disponible pour cette sélection.')
    for (let i = pool.length - 1; i > 0; i--) {
      const j = randomInt(i + 1)
      ;[pool[i], pool[j]] = [pool[j]!, pool[i]!]
    }
    const game: StoredGame = {
      id: randomUUID(), mode, status: mode === 'solo' ? 'playing' : 'waiting', phase: 'question',
      chapterIds: config.chapterIds, hostId: user.id, players: [{ id: user.id, name: user.name }],
      questions: pool.slice(0, config.count), questionIndex: 0, startedAt: null, deadline: null,
      correctionUntil: null, createdAt: new Date().toISOString(),
    }
    if (mode === 'multi') {
      do { game.code = Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[randomInt(32)]).join('') }
      while (this.db.prepare('SELECT id FROM games WHERE code=?').get(game.code))
    } else this.beginQuestion(game)
    this.save(game)
    return game
  }

  join(code: string, user: User) {
    const row = this.db.prepare('SELECT id FROM games WHERE code=?').get(code.toUpperCase())
    if (!row) throw new ApiError(404, 'Ce code de salon est introuvable.')
    const game = this.read(String(row.id))
    if (game.players.some(p => p.id === user.id)) return game
    if (game.status !== 'waiting') throw new ApiError(409, 'Cette partie a déjà commencé.')
    if (game.players.length >= 12) throw new ApiError(409, 'Le salon est complet (12 joueurs).')
    game.players.push({ id: user.id, name: user.name })
    this.save(game)
    return game
  }

  start(game: StoredGame, userId: string) {
    this.member(game, userId)
    if (game.hostId !== userId) throw new ApiError(403, 'Seul l’hôte peut lancer la partie.')
    if (game.status !== 'waiting') throw new ApiError(409, 'La partie a déjà commencé.')
    if (game.players.length < 2) throw new ApiError(400, 'Invitez au moins un autre joueur pour commencer.')
    game.status = 'playing'
    this.beginQuestion(game)
    this.save(game)
  }

  beginQuestion(game: StoredGame) {
    game.phase = 'question'
    game.startedAt = Date.now()
    game.deadline = game.mode === 'multi' ? game.startedAt + this.duration : null
    game.correctionUntil = null
  }

  answerRows(gameId: string, userId?: string) {
    const rows = userId
      ? this.db.prepare('SELECT user_id,question_index,body FROM answers WHERE game_id=? AND user_id=? ORDER BY question_index').all(gameId, userId)
      : this.db.prepare('SELECT user_id,question_index,body FROM answers WHERE game_id=? ORDER BY question_index').all(gameId)
    return rows.map(r => ({ userId: String(r.user_id), index: Number(r.question_index), result: JSON.parse(String(r.body)) as AnswerResult }))
  }

  record(game: StoredGame, userId: string, selected: number[], now: number, timeout = false) {
    const q = game.questions[game.questionIndex]!
    const elapsedMs = timeout ? this.duration : Math.max(0, now - game.startedAt!)
    const expected = [...q.correctAnswers].sort()
    const actual = [...selected].sort()
    const correct = !timeout && expected.length === actual.length && expected.every((v, i) => v === actual[i])
    const bonus = game.mode === 'multi' ? Math.floor(50 * Math.max(0, 1 - elapsedMs / this.duration)) : 0
    const result: AnswerResult = { questionId: q.id, selected, correctAnswers: q.correctAnswers, explanation: q.explanation, correct, points: correct ? 100 + bonus : 0, elapsedMs }
    this.db.prepare('INSERT INTO answers(game_id,user_id,question_index,question_id,chapter_id,prompt,correct,points,body,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(game.id, userId, game.questionIndex, q.id, q.chapterId, q.prompt, correct ? 1 : 0, result.points, JSON.stringify(result), new Date(now).toISOString())
    return result
  }

  answer(game: StoredGame, userId: string, selected: number[]) {
    this.member(game, userId)
    if (this.answerRows(game.id, userId).some(r => r.index === game.questionIndex)) throw new ApiError(409, 'Votre réponse a déjà été enregistrée.')
    if (game.status !== 'playing' || game.phase !== 'question' || (game.mode === 'multi' && Date.now() >= game.deadline!)) throw new ApiError(409, 'Le délai de réponse est écoulé.')
    this.record(game, userId, selected, Date.now())
    const answered = this.answerRows(game.id).filter(r => r.index === game.questionIndex).length
    if (answered === game.players.length) this.correction(game)
    this.save(game)
  }

  correction(game: StoredGame) {
    game.phase = 'correction'
    game.correctionUntil = game.mode === 'multi' ? Date.now() + this.correctionDuration : null
  }

  advance(game: StoredGame) {
    if (game.mode === 'solo' || game.status !== 'playing') return false
    const now = Date.now()
    let changed = false
    if (game.phase === 'question' && now >= game.deadline!) {
      const rows = this.answerRows(game.id).filter(r => r.index === game.questionIndex)
      for (const player of game.players) if (!rows.some(r => r.userId === player.id)) this.record(game, player.id, [], now, true)
      this.correction(game)
      changed = true
    }
    if (game.mode === 'multi' && game.phase === 'correction' && now >= game.correctionUntil!) {
      this.next(game, game.hostId)
      changed = true
    }
    if (changed) this.save(game)
    return changed
  }

  next(game: StoredGame, userId: string) {
    this.member(game, userId)
    if (game.hostId !== userId) throw new ApiError(403, 'Seul l’hôte peut continuer.')
    if (game.status !== 'playing' || game.phase !== 'correction') throw new ApiError(409, 'La correction n’est pas encore disponible.')
    if (game.questionIndex + 1 >= game.questions.length) {
      game.status = 'finished'
      game.deadline = null
      game.correctionUntil = null
    } else {
      game.questionIndex++
      this.beginQuestion(game)
    }
    this.save(game)
  }

  leave(game: StoredGame, userId: string) {
    this.member(game, userId)
    if (game.status !== 'waiting') return
    game.players = game.players.filter(p => p.id !== userId)
    if (!game.players.length) game.status = 'finished'
    else if (game.hostId === userId) game.hostId = game.players[0]!.id
    this.save(game)
  }

  state(game: StoredGame, userId: string, connected: (id: string) => boolean = () => true): GameState {
    this.member(game, userId)
    const rows = this.answerRows(game.id)
    const mine = rows.filter(r => r.userId === userId)
    const q = game.status === 'waiting' || game.status === 'finished' ? null : game.questions[game.questionIndex]!
    const question = q ? { id: q.id, chapterId: q.chapterId, difficulty: q.difficulty, prompt: q.prompt, options: q.options, image: q.image, status: q.status, createdAt: q.createdAt, updatedAt: q.updatedAt } : null
    const current = mine.find(r => r.index === game.questionIndex)?.result ?? null
    const reveal = game.mode === 'solo' || game.phase === 'correction' || game.status === 'finished'
    return {
      id: game.id, mode: game.mode, code: game.code, status: game.status, phase: game.phase,
      chapterIds: game.chapterIds, hostId: game.hostId, questionIndex: game.questionIndex, totalQuestions: game.questions.length,
      question, deadline: game.mode === 'solo' ? null : game.phase === 'correction' ? game.correctionUntil : game.deadline, serverNow: Date.now(),
      players: game.players.map(p => ({ ...p, score: rows.filter(r => r.userId === p.id).reduce((n, r) => n + (game.mode === 'multi' && game.phase === 'question' && r.index === game.questionIndex ? 0 : r.result.points), 0), answered: rows.some(r => r.userId === p.id && r.index === game.questionIndex), connected: connected(p.id) })),
      result: reveal ? current : null,
      results: mine.filter(r => reveal || r.index < game.questionIndex).map(r => r.result),
    }
  }

  active() {
    return this.db.prepare("SELECT body FROM games WHERE status='playing' AND json_extract(body,'$.mode')='multi'").all().map(r => JSON.parse(String(r.body)) as StoredGame)
  }
}
