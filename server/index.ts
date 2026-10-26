import express, { type NextFunction, type Request, type Response } from 'express'
import { createServer } from 'node:http'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { networkInterfaces } from 'node:os'
import { z } from 'zod'
import { openDatabase, publicUser, hashPassword, verifyPassword, readChapters, readQuestions, writeQuestion, readVisibleAnswers } from './database.ts'
import { ApiError, Games, type StoredGame } from './games.ts'
import type { Bootstrap, LeaderboardRow, Progress, Question, User } from '../shared/types.ts'
import { createSupabaseTokenVerifier, resolveAuthConfiguration, type AuthMode, type SupabaseAuthConfig, type SupabaseTokenVerifier } from './supabase-auth.ts'
import { createVerifiedSessions } from './verified-sessions.ts'

export interface AppOptions { dbPath?: string; uploadsDir?: string; questionDurationMs?: number; correctionDurationMs?: number; authMode?: AuthMode; supabaseConfig?: SupabaseAuthConfig; verifySupabaseToken?: SupabaseTokenVerifier; streamAuthRecheckMs?: number }
interface AuthIdentity { user: User; sessionToken: string; expiresAt: number; bearerToken: string | null }
interface GameStream { userId: string; role: User['role']; gameId: string; sessionToken: string; expiresAt: number; bearerToken: string | null; lastValidatedAt: number; checking: boolean; res: Response }

const questionSchema = z.object({
  chapterId: z.string().min(1).max(100), difficulty: z.enum(['easy', 'medium', 'hard']),
  prompt: z.string().trim().min(10).max(5000), options: z.array(z.string().trim().min(1).max(1000)).length(4),
  correctAnswers: z.array(z.number().int().min(0).max(3)).min(1).max(4).refine(a => new Set(a).size === a.length),
  explanation: z.string().trim().min(10).max(10000), image: z.string().max(250).nullable(), status: z.enum(['draft', 'pending']),
})
const gameSchema = z.object({ chapterIds: z.array(z.string()).max(5).default([]), difficulty: z.enum(['all', 'easy', 'medium', 'hard']).default('all'), count: z.number().int().min(1).max(30).default(10), mistakesOnly: z.boolean().optional() })
const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex')
const parisDay = (date: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)

function cookieToken(header?: string) {
  return header?.split(';').map(v => v.trim()).find(v => v.startsWith('herbier_session='))?.slice('herbier_session='.length)
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new ApiError(400, 'Données invalides. Vérifiez les champs et réessayez.')
  return parsed.data
}

export function createApp(options: AppOptions = {}) {
  const authConfig = resolveAuthConfiguration({ mode: options.authMode, config: options.supabaseConfig })
  const verifyCloudToken = authConfig.config ? options.verifySupabaseToken ?? createSupabaseTokenVerifier(authConfig.config) : null
  const verifiedSessions = verifyCloudToken ? createVerifiedSessions(verifyCloudToken) : null
  const db = openDatabase(options.dbPath ?? process.env.DATABASE_PATH ?? resolve('data/herbier.sqlite'))
  const uploadsDir = resolve(options.uploadsDir ?? process.env.UPLOADS_PATH ?? 'data/uploads')
  mkdirSync(uploadsDir, { recursive: true })
  const app = express()
  const server = createServer(app)
  const streams = new Set<GameStream>()
  const games = new Games(db, options.questionDurationMs ?? 30_000, options.correctionDurationMs ?? 5_000)
  const authAttempts = new Map<string, { count: number; resetAt: number }>()
  let closed = false

  function sessionUser(header?: string) {
    const token = cookieToken(header)
    if (!token) return null
    const row = db.prepare("SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id WHERE token=? AND expires_at>? AND users.auth_provider='local'").get(tokenHash(token), Date.now())
    return row ? publicUser(row) : null
  }

  function mirrorCloudUser(user: User) {
    const existing = db.prepare('SELECT * FROM users WHERE id=?').get(user.id)
    const collision = db.prepare('SELECT id FROM users WHERE email=? COLLATE NOCASE AND id<>?').get(user.email, user.id)
    if (collision || (existing && existing.auth_provider !== 'supabase')) throw new ApiError(409, 'Ce compte Supabase entre en conflit avec un compte local. Utilisez une autre adresse ou une base locale distincte ; aucun compte n’a été fusionné.')
    if (existing) {
      if (existing.role !== user.role) for (const stream of streams) if (stream.userId === user.id) stream.res.end()
      if (existing.name !== user.name || existing.email !== user.email || existing.role !== user.role) db.prepare("UPDATE users SET name=?,email=?,role=? WHERE id=? AND auth_provider='supabase'").run(user.name, user.email, user.role, user.id)
    } else db.prepare("INSERT INTO users(id,name,email,role,password_hash,created_at,auth_provider) VALUES (?,?,?,?,?,?,'supabase')").run(user.id, user.name, user.email, user.role, hashPassword(randomBytes(32).toString('hex')), user.createdAt)
    return user
  }

  async function authenticate(req: Request, fresh = false): Promise<AuthIdentity> {
    if (authConfig.mode === 'supabase') {
      const header = req.get('authorization')
      const match = header && /^Bearer ([^\s]+)$/i.exec(header)
      if (!match || match[1]!.length > 16384) throw new ApiError(401, 'Une session Supabase est nécessaire. Reconnectez-vous.')
      const token = match[1]!
      const identity = await verifiedSessions!.get(token, fresh)
      if (!Number.isFinite(identity.expiresAt) || identity.expiresAt <= Date.now()) throw new ApiError(401, 'Session Supabase expirée.')
      if (closed) throw new ApiError(503, 'Le serveur s’arrête.')
      return { user: mirrorCloudUser(identity.user), sessionToken: tokenHash(token), bearerToken: token, expiresAt: identity.expiresAt }
    }
    const user = sessionUser(req.headers.cookie)
    if (!user) throw new ApiError(401, 'Connectez-vous pour continuer.')
    const sessionToken = tokenHash(cookieToken(req.headers.cookie)!)
    const row = db.prepare('SELECT expires_at FROM sessions WHERE token=?').get(sessionToken)!
    return { user, sessionToken, expiresAt: Number(row.expires_at), bearerToken: null }
  }

  app.disable('x-powered-by')
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'same-origin')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    let requestPath = (req.url ?? '/').split('?')[0]!
    try { requestPath = decodeURIComponent(decodeURIComponent(requestPath)).replaceAll('\\', '/') }
    catch { res.status(400).json({ message: 'Adresse invalide.' }); return }
    if (/(^|\/)(server|data|tests|supabase|\.git|\.npm-cache|\.codex|\.agents|\.aws)(\/|$)/i.test(requestPath) || /\.(sqlite(?:-(?:wal|shm))?|db|pem|key)$/i.test(requestPath) || /(^|\/)\.env(?:\.|$)/i.test(requestPath)) {
      res.status(404).json({ message: 'Ressource introuvable.' })
      return
    }
    const origin = req.get('origin')
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? '') && origin) {
      try { if (new URL(origin).host !== req.get('host')) throw new Error() }
      catch { next(new ApiError(403, 'Origine de la requête non autorisée.')); return }
    }
    next()
  })
  app.use('/api', express.json({ limit: '3mb', strict: true }))
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next() })
  app.use('/uploads', express.static(uploadsDir, { dotfiles: 'deny', fallthrough: false, maxAge: '1y', immutable: true, setHeaders: res => { res.setHeader('Content-Security-Policy', "default-src 'none'") } }))
  app.use('/uploads', (_error: unknown, _req: Request, res: Response, _next: NextFunction) => { res.status(404).json({ message: 'Image introuvable.' }) })
  const api = express.Router()
  app.use('/api', api)

  const auth = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sensitive = /^\/(bootstrap|users|questions|uploads)(\/|\?|$)/i.test(req.url ?? '')
      const identity = await authenticate(req, sensitive)
      res.locals.user = identity.user
      res.locals.authIdentity = identity
      next()
    } catch (error) { next(error) }
  }
  const userOf = (res: Response) => res.locals.user as User
  const roles = (...allowed: User['role'][]) => (_req: Request, res: Response, next: NextFunction) => {
    if (!allowed.includes(userOf(res).role)) { next(new ApiError(403, 'Vous n’avez pas accès à cette action.')); return }
    next()
  }
  const rateAuth = (req: Request, _res: Response, next: NextFunction) => {
    const key = req.ip ?? 'unknown'
    const now = Date.now()
    let attempt = authAttempts.get(key)
    if (!attempt || now >= attempt.resetAt) { attempt = { count: 0, resetAt: now + 60_000 }; authAttempts.set(key, attempt) }
    if (++attempt.count > 20) { next(new ApiError(429, 'Trop de tentatives. Réessayez dans une minute.')); return }
    next()
  }
  function createSession(req: Request, res: Response, userId: string) {
    const old = cookieToken(req.headers.cookie)
    if (old) {
      const oldHash = tokenHash(old)
      db.prepare('DELETE FROM sessions WHERE token=?').run(oldHash)
      for (const stream of streams) if (stream.sessionToken === oldHash) stream.res.end()
    }
    const token = randomBytes(32).toString('hex')
    db.prepare('INSERT INTO sessions(token,user_id,expires_at) VALUES (?,?,?)').run(tokenHash(token), userId, Date.now() + 7 * 86400_000)
    res.cookie('herbier_session', token, { httpOnly: true, sameSite: 'strict', secure: req.secure, maxAge: 7 * 86400_000, path: '/' })
  }
  api.get('/health', (_req, res) => res.json({ status: 'ok', mode: 'local' }))
  api.get('/config', (_req, res) => res.json({ authMode: authConfig.mode }))
  api.post('/auth/login', rateAuth, (req, res) => {
    if (authConfig.mode !== 'local') throw new ApiError(409, 'La connexion utilise Supabase. Les comptes de démonstration locaux sont désactivés.')
    const input = parse(z.object({ email: z.email().max(254), password: z.string().min(1).max(128) }), req.body)
    const row = db.prepare("SELECT * FROM users WHERE email=? COLLATE NOCASE AND auth_provider='local'").get(input.email.trim())
    const fallback = '9b1c63b8cc6a74bd:8c95159755fbdc4e800111c48d2c47a558164d35dbdb69764b9c99c1e3e6ad22eb997fd34f3a97de70f2e49fd1d013bc493e6804e324ef0dc2ed681db8aafc36'
    const valid = verifyPassword(input.password, row ? String(row.password_hash) : fallback)
    if (!row || !valid) throw new ApiError(401, 'Adresse e-mail ou mot de passe incorrect.')
    createSession(req, res, String(row.id))
    res.json({ user: publicUser(row) })
  })
  api.post('/auth/register', rateAuth, (req, res) => {
    if (authConfig.mode !== 'local') throw new ApiError(409, 'L’inscription utilise Supabase. L’inscription locale est désactivée.')
    const input = parse(z.object({ name: z.string().trim().min(2).max(60), email: z.email().max(254), password: z.string().min(10).max(128) }), req.body)
    const email = input.email.trim().toLowerCase()
    if (db.prepare('SELECT id FROM users WHERE email=?').get(email)) throw new ApiError(409, 'Cette adresse e-mail possède déjà un compte.')
    const user: User = { id: randomUUID(), name: input.name, email, role: 'student', createdAt: new Date().toISOString() }
    db.prepare('INSERT INTO users(id,name,email,role,password_hash,created_at) VALUES (?,?,?,?,?,?)').run(user.id, user.name, user.email, user.role, hashPassword(input.password), user.createdAt)
    createSession(req, res, user.id)
    res.status(201).json({ user })
  })
  api.post('/auth/logout', async (req, res, next) => {
    if (authConfig.mode === 'supabase') {
      try {
        const identity = await authenticate(req)
        verifiedSessions!.invalidateUser(identity.user.id)
        for (const stream of streams) if (stream.userId === identity.user.id) stream.res.end()
        res.clearCookie('herbier_session', { path: '/', httpOnly: true, sameSite: 'strict' })
        res.json({})
      } catch (error) { next(error) }
      return
    }
    const token = cookieToken(req.headers.cookie)
    if (token) db.prepare('DELETE FROM sessions WHERE token=?').run(tokenHash(token))
    for (const stream of streams) if (stream.sessionToken === tokenHash(token ?? '')) stream.res.end()
    res.clearCookie('herbier_session', { path: '/', httpOnly: true, sameSite: 'strict' })
    res.json({})
  })
  api.use(auth)

  function progress(userId: string): Progress {
    const rows = readVisibleAnswers(db, userId)
    const totalPoints = rows.reduce((n, r) => n + Number(r.points), 0)
    const correct = rows.reduce((n, r) => n + Number(r.correct), 0)
    const finished = db.prepare("SELECT body FROM games WHERE status='finished' ORDER BY updated_at DESC").all().map(r => JSON.parse(String(r.body)) as StoredGame).filter(g => g.players.some(p => p.id === userId))
    const days = new Map<string, number>()
    const latest = new Map<string, { row: (typeof rows)[number]; count: number }>()
    for (const row of rows) {
      const day = parisDay(new Date(String(row.created_at)))
      days.set(day, (days.get(day) ?? 0) + 1)
      const prior = latest.get(String(row.question_id))
      latest.set(String(row.question_id), { row, count: (prior?.count ?? 0) + (Number(row.correct) === 0 ? 1 : 0) })
    }
    let streak = 0
    const date = new Date(`${parisDay(new Date())}T12:00:00Z`)
    if (!days.has(date.toISOString().slice(0, 10))) date.setUTCDate(date.getUTCDate() - 1)
    while (days.has(date.toISOString().slice(0, 10))) { streak++; date.setUTCDate(date.getUTCDate() - 1) }
    return {
      totalPoints, answered: rows.length, correct, accuracy: rows.length ? Math.round(correct / rows.length * 100) : 0,
      gamesPlayed: finished.length, streak,
      chapters: readChapters(db).map(c => {
        const subset = rows.filter(r => r.chapter_id === c.id)
        return { chapterId: c.id, answered: subset.length, correct: subset.reduce((n, r) => n + Number(r.correct), 0), points: subset.reduce((n, r) => n + Number(r.points), 0) }
      }),
      recentGames: finished.slice(0, 8).map(g => {
        const answers = rows.filter(r => r.game_id === g.id)
        return { id: g.id, mode: g.mode, score: answers.reduce((n, r) => n + Number(r.points), 0), total: g.questions.length, correct: answers.reduce((n, r) => n + Number(r.correct), 0), createdAt: g.createdAt }
      }),
      mistakes: [...latest].filter(([, data]) => Number(data.row.correct) === 0).map(([questionId, data]) => ({ questionId, prompt: String(data.row.prompt), chapterId: String(data.row.chapter_id), count: data.count })),
      daily: Array.from({ length: 14 }, (_, i) => { const d = new Date(`${parisDay(new Date())}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 13 + i); const day = d.toISOString().slice(0, 10); return { date: day, answered: days.get(day) ?? 0 } }),
    }
  }

  api.get('/bootstrap', (_req, res) => {
    const chapters = readChapters(db)
    const published = readQuestions(db).filter(q => q.status === 'published')
    const result: Bootstrap = { user: userOf(res), chapters, counts: Object.fromEntries(chapters.map(c => [c.id, published.filter(q => q.chapterId === c.id).length])), progress: progress(userOf(res).id) }
    res.json(result)
  })
  api.get('/chapters', (_req, res) => res.json(readChapters(db)))
  api.get('/progress', (_req, res) => res.json(progress(userOf(res).id)))
  api.get('/leaderboard', (req, res) => {
    const chapterId = req.query.chapterId ? String(req.query.chapterId) : null
    if (chapterId && !readChapters(db).some(c => c.id === chapterId)) throw new ApiError(400, 'Chapitre inconnu.')
    const answers = readVisibleAnswers(db, undefined, chapterId ?? undefined)
    const board: LeaderboardRow[] = db.prepare('SELECT id,name FROM users WHERE auth_provider=?').all(authConfig.mode).map(user => {
      const mine = answers.filter(r => r.user_id === user.id)
      return { userId: String(user.id), name: String(user.name), points: mine.reduce((n, r) => n + Number(r.points), 0), answered: mine.length, accuracy: mine.length ? Math.round(mine.reduce((n, r) => n + Number(r.correct), 0) / mine.length * 100) : 0, rank: 0 }
    }).sort((a, b) => b.points - a.points || b.accuracy - a.accuracy || a.name.localeCompare(b.name, 'fr'))
    let previousPoints = -1
    let previousAccuracy = -1
    let rank = 0
    board.forEach((row, i) => { if (row.points !== previousPoints || row.accuracy !== previousAccuracy) rank = i + 1; row.rank = rank; previousPoints = row.points; previousAccuracy = row.accuracy })
    res.json(board)
  })

  function editable(id: string, user: User) {
    const q = readQuestions(db).find(q => q.id === id)
    if (!q) throw new ApiError(404, 'Question introuvable.')
    if (user.role !== 'admin' && (q.authorId !== user.id || q.status === 'published')) throw new ApiError(403, 'Vous pouvez uniquement modifier vos questions non publiées.')
    return q
  }
  function validatedQuestion(input: unknown) {
    const q = parse(questionSchema, input)
    if (!readChapters(db).some(c => c.id === q.chapterId)) throw new ApiError(400, 'Chapitre inconnu.')
    if (new Set(q.options.map(o => o.toLowerCase())).size !== 4) throw new ApiError(400, 'Les quatre propositions doivent être différentes.')
    if (q.image && !/^\/uploads\/[a-f0-9-]+\.(png|jpg|gif|webp)$/.test(q.image) && !['/illustrations/cell.svg', '/illustrations/leaf.svg', '/illustrations/subduction.svg'].includes(q.image)) throw new ApiError(400, 'Importez l’image avant de l’associer à la question.')
    return q
  }
  api.get('/questions/export', roles('admin', 'contributor'), (_req, res) => {
    res.json(readQuestions(db).filter(q => userOf(res).role === 'admin' || q.authorId === userOf(res).id))
  })
  api.post('/questions/import', roles('admin', 'contributor'), (req, res) => {
    const body = parse(z.object({ questions: z.array(z.unknown()).min(1).max(500) }), req.body)
    const inputs = body.questions.map(input => {
      if (!input || typeof input !== 'object') throw new ApiError(400, 'Question importée invalide.')
      const value = input as Record<string, unknown>
      return validatedQuestion({ ...value, status: value.status === 'published' ? 'pending' : value.status === 'rejected' ? 'draft' : value.status })
    })
    const now = new Date().toISOString()
    db.exec('BEGIN')
    try {
      for (const q of inputs) writeQuestion(db, { ...q, id: randomUUID(), authorId: userOf(res).id, createdAt: now, updatedAt: now })
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
    res.status(201).json({ imported: inputs.length })
  })
  api.get('/questions', roles('admin', 'contributor'), (req, res) => {
    const search = String(req.query.search ?? '').toLocaleLowerCase('fr')
    res.json(readQuestions(db).filter(q => (userOf(res).role === 'admin' || q.authorId === userOf(res).id) && (!req.query.status || q.status === req.query.status) && (!req.query.chapterId || q.chapterId === req.query.chapterId) && (!search || `${q.prompt} ${q.explanation}`.toLocaleLowerCase('fr').includes(search))))
  })
  api.post('/questions', roles('admin', 'contributor'), (req, res) => {
    const input = validatedQuestion(req.body)
    const now = new Date().toISOString()
    const q: Question = { ...input, id: randomUUID(), authorId: userOf(res).id, createdAt: now, updatedAt: now }
    writeQuestion(db, q)
    res.status(201).json(q)
  })
  api.put('/questions/:id', roles('admin', 'contributor'), (req, res) => {
    const old = editable(String(req.params.id), userOf(res))
    const q: Question = { ...old, ...validatedQuestion(req.body), reviewNote: undefined, updatedAt: new Date().toISOString() }
    writeQuestion(db, q)
    res.json(q)
  })
  api.delete('/questions/:id', roles('admin', 'contributor'), (req, res) => {
    const q = editable(String(req.params.id), userOf(res))
    db.prepare('DELETE FROM questions WHERE id=?').run(q.id)
    res.json({})
  })
  api.post('/questions/:id/review', roles('admin'), (req, res) => {
    const input = parse(z.object({ status: z.enum(['published', 'rejected']), reviewNote: z.string().trim().max(2000).optional() }), req.body)
    const q = editable(String(req.params.id), userOf(res))
    if (input.status === 'rejected' && !input.reviewNote) throw new ApiError(400, 'Indiquez le motif du refus pour aider le contributeur.')
    q.status = input.status
    q.reviewNote = input.reviewNote
    q.updatedAt = new Date().toISOString()
    writeQuestion(db, q)
    res.json(q)
  })
  api.post('/uploads', roles('admin', 'contributor'), (req, res) => {
    const { dataUrl } = parse(z.object({ dataUrl: z.string().max(2_800_000) }), req.body)
    const match = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl)
    if (!match) throw new ApiError(400, 'Utilisez une image PNG, JPEG, GIF ou WebP.')
    const buffer = Buffer.from(match[2]!, 'base64')
    if (!buffer.length || buffer.length > 2 * 1024 * 1024) throw new ApiError(400, 'L’image doit faire moins de 2 Mo.')
    const type = match[1]!
    const valid = type === 'png' ? buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : type === 'jpeg' ? buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255 : type === 'gif' ? ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString()) : buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP'
    if (!valid) throw new ApiError(400, 'Le contenu de l’image ne correspond pas à son format.')
    const name = `${randomUUID()}.${type === 'jpeg' ? 'jpg' : type}`
    writeFileSync(join(uploadsDir, name), buffer, { flag: 'wx' })
    res.status(201).json({ url: `/uploads/${name}` })
  })
  api.get('/users', roles('admin'), (_req, res) => res.json(db.prepare('SELECT * FROM users WHERE auth_provider=? ORDER BY created_at DESC').all(authConfig.mode).map(publicUser)))
  api.patch('/users/:id', roles('admin'), (req, res) => {
    if (authConfig.mode === 'supabase') throw new ApiError(409, 'Les rôles Supabase se gèrent dans le projet Supabase. La modification des rôles cloud depuis cette application n’est pas encore disponible.')
    const input = parse(z.object({ role: z.enum(['admin', 'contributor', 'student']) }), req.body)
    const target = db.prepare('SELECT * FROM users WHERE id=?').get(String(req.params.id))
    if (!target) throw new ApiError(404, 'Utilisateur introuvable.')
    if (target.id === userOf(res).id && input.role !== 'admin') throw new ApiError(400, 'Vous ne pouvez pas retirer votre propre rôle administrateur.')
    if (target.role === 'admin' && input.role !== 'admin' && Number(db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'").get()!.n) <= 1) throw new ApiError(400, 'Conservez au moins un administrateur.')
    db.prepare('UPDATE users SET role=? WHERE id=?').run(input.role, String(target.id))
    res.json(publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(String(target.id))!))
  })

  const connected = (userId: string) => [...streams].some(stream => stream.userId === userId)
  const gameState = (game: StoredGame, userId: string) => games.state(game, userId, id => connected(id) || id === userId)
  function broadcast(game: StoredGame) {
    for (const stream of streams) {
      if (stream.res.writableEnded || stream.res.destroyed) continue
      if (stream.gameId !== game.id || !game.players.some(p => p.id === stream.userId)) continue
      stream.res.write(`event: state\ndata: ${JSON.stringify(gameState(game, stream.userId))}\n\n`)
    }
  }
  const configOf = (input: unknown) => {
    const config = parse(gameSchema, input)
    const chapters = readChapters(db)
    if (!config.chapterIds.length) config.chapterIds = chapters.map(c => c.id)
    if (new Set(config.chapterIds).size !== config.chapterIds.length || config.chapterIds.some(id => !chapters.some(c => c.id === id))) throw new ApiError(400, 'Sélection de chapitres invalide.')
    return config
  }
  api.post('/games/solo', (req, res) => res.status(201).json(gameState(games.create(userOf(res), 'solo', configOf(req.body)), userOf(res).id)))
  api.post('/rooms', (req, res) => res.status(201).json(gameState(games.create(userOf(res), 'multi', configOf(req.body)), userOf(res).id)))
  api.post('/rooms/join', (req, res) => {
    const { code } = parse(z.object({ code: z.string().trim().min(1).max(12) }), req.body)
    const game = games.join(code, userOf(res))
    broadcast(game)
    res.json(gameState(game, userOf(res).id))
  })
  api.get('/games/:id/events', (req, res) => {
    const user = userOf(res)
    const game = games.read(String(req.params.id))
    games.member(game, user.id)
    games.advance(game)
    const identity = res.locals.authIdentity as AuthIdentity
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()
    const stream: GameStream = { userId: user.id, role: user.role, gameId: game.id, sessionToken: identity.sessionToken, expiresAt: identity.expiresAt, bearerToken: identity.bearerToken, lastValidatedAt: Date.now(), checking: false, res }
    streams.add(stream)
    res.write('retry: 1500\n\n')
    broadcast(game)
    res.on('close', () => {
      streams.delete(stream)
      if (!closed) { try { broadcast(games.read(game.id)) } catch {} }
    })
  })
  api.get('/games/:id', (req, res) => {
    const game = games.read(String(req.params.id))
    games.member(game, userOf(res).id)
    if (games.advance(game)) broadcast(game)
    res.json(gameState(game, userOf(res).id))
  })
  api.post('/games/:id/start', (req, res) => {
    const game = games.read(String(req.params.id))
    games.start(game, userOf(res).id)
    broadcast(game)
    res.json(gameState(game, userOf(res).id))
  })
  api.post('/games/:id/answer', (req, res) => {
    const input = parse(z.object({ selected: z.array(z.number().int().min(0).max(3)).min(1).max(4).refine(a => new Set(a).size === a.length), questionId: z.string().min(1) }), req.body)
    const game = games.read(String(req.params.id))
    games.member(game, userOf(res).id)
    if (games.advance(game)) broadcast(game)
    if (game.questions[game.questionIndex]?.id !== input.questionId) throw new ApiError(409, 'Cette question est déjà terminée. La partie a été actualisée.')
    games.answer(game, userOf(res).id, input.selected)
    broadcast(game)
    res.json(gameState(game, userOf(res).id))
  })
  api.post('/games/:id/next', (req, res) => {
    const game = games.read(String(req.params.id))
    if (game.mode !== 'solo') throw new ApiError(403, 'Les questions du salon avancent automatiquement.')
    games.next(game, userOf(res).id)
    broadcast(game)
    res.json(gameState(game, userOf(res).id))
  })
  api.post('/games/:id/leave', (req, res) => {
    const game = games.read(String(req.params.id))
    games.leave(game, userOf(res).id)
    broadcast(game)
    res.json({})
  })
  api.use((_req, _res, next) => next(new ApiError(404, 'Ressource introuvable.')))
  app.use('/api', (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ApiError) { res.status(error.status).json({ message: error.message }); return }
    if (error instanceof SyntaxError) { res.status(400).json({ message: 'Le contenu JSON est invalide.' }); return }
    if ((error as { type?: string })?.type === 'entity.too.large') { res.status(413).json({ message: 'Le fichier dépasse la taille autorisée.' }); return }
    console.error(error)
    res.status(500).json({ message: 'Une erreur est survenue. Réessayez dans un instant.' })
  })

  let lastHeartbeat = Date.now()
  const timer = setInterval(() => {
    if (closed) return
    try {
      for (const game of games.active()) if (games.advance(game)) broadcast(game)
      for (const stream of streams) {
        if (stream.res.writableEnded || stream.res.destroyed) { streams.delete(stream); continue }
        if (Date.now() >= stream.expiresAt) stream.res.end()
        else {
          if (stream.bearerToken && !stream.checking && Date.now() - stream.lastValidatedAt >= (options.streamAuthRecheckMs ?? 60000)) {
            stream.checking = true
            void verifiedSessions!.get(stream.bearerToken, true).then(identity => {
              if (closed || !streams.has(stream)) return
              if (identity.user.id !== stream.userId || identity.user.role !== stream.role || identity.expiresAt <= Date.now()) { stream.res.end(); return }
              mirrorCloudUser(identity.user)
              stream.lastValidatedAt = Date.now()
            }).catch(() => { stream.res.end() }).finally(() => { stream.checking = false })
          }
          if (Date.now() - lastHeartbeat > 15_000) stream.res.write(': heartbeat\n\n')
        }
      }
      if (Date.now() - lastHeartbeat > 15_000) lastHeartbeat = Date.now()
      db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now())
      for (const [key, attempt] of authAttempts) if (Date.now() > attempt.resetAt) authAttempts.delete(key)
    } catch (error) { console.error('Game clock:', error) }
  }, 250)
  timer.unref()

  return { app, server, db, games, authMode: authConfig.mode, close: async () => {
    closed = true
    verifiedSessions?.close()
    clearInterval(timer)
    for (const stream of streams) stream.res.end()
    streams.clear()
    if (server.listening) await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
    db.close()
  } }
}

async function main() {
  if (existsSync(resolve('.env.local'))) process.loadEnvFile(resolve('.env.local'))
  const runtime = createApp()
  const production = process.argv.includes('--production') || process.env.NODE_ENV === 'production'
  if (production) {
    runtime.app.use(express.static(resolve('dist'), { index: false }))
    runtime.app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html')))
  } else {
    const { createServer: createViteServer } = await import('vite')
    const vite = await createViteServer({ server: { middlewareMode: true, hmr: { server: runtime.server }, fs: { deny: ['.env', '.env.*', '**/*.pem', '**/*.key', '**/*.sqlite*', '**/*.db', '**/server/**', '**/data/**', '**/tests/**', '**/supabase/**', '**/.git/**', '**/.npm-cache/**'] } }, appType: 'spa' })
    runtime.app.use(vite.middlewares)
  }
  const port = Number(process.env.PORT ?? 5173)
  const host = process.env.HOST ?? '0.0.0.0'
  runtime.server.listen(port, host, () => {
    console.log(`QCM BCPST disponible sur http://localhost:${port}`)
    if (host === '0.0.0.0') {
      const addresses = new Set(Object.values(networkInterfaces()).flat().filter(address => address?.family === 'IPv4' && !address.internal).map(address => address!.address))
      for (const address of addresses) console.log(`Téléphone sur le même réseau : http://${address}:${port}`)
    }
  })
  const stop = async () => { await runtime.close(); process.exit(0) }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1 })
