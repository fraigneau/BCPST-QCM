import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { Chapter, Question, User } from '../shared/types.ts'
import { chapters, seedQuestions } from './seed.ts'

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex')
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`
}

export function verifyPassword(password: string, hash: string) {
  const [salt, encoded] = hash.split(':')
  if (!salt || !encoded) return false
  const actual = scryptSync(password, salt, 64)
  const expected = Buffer.from(encoded, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function openDatabase(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      role TEXT NOT NULL CHECK(role IN ('student','contributor','admin')), password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL, auth_provider TEXT NOT NULL DEFAULT 'local' CHECK(auth_provider IN ('local','supabase'))
    );
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS chapters (id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS questions (id TEXT PRIMARY KEY, author_id TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL, chapter_id TEXT NOT NULL REFERENCES chapters(id), body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS games (id TEXT PRIMARY KEY, code TEXT UNIQUE, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'waiting', updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS answers (
      game_id TEXT NOT NULL REFERENCES games(id), user_id TEXT NOT NULL REFERENCES users(id),
      question_index INTEGER NOT NULL, question_id TEXT NOT NULL, chapter_id TEXT NOT NULL,
      prompt TEXT NOT NULL, correct INTEGER NOT NULL, points INTEGER NOT NULL, body TEXT NOT NULL,
      created_at TEXT NOT NULL, PRIMARY KEY(game_id,user_id,question_index)
    );
    CREATE INDEX IF NOT EXISTS answers_user ON answers(user_id,created_at);
    CREATE INDEX IF NOT EXISTS answers_chapter ON answers(chapter_id,user_id);
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS questions_status ON questions(status,chapter_id);
  `)
  if (!db.prepare('PRAGMA table_info(users)').all().some(column => column.name === 'auth_provider')) db.exec("ALTER TABLE users ADD COLUMN auth_provider TEXT NOT NULL DEFAULT 'local' CHECK(auth_provider IN ('local','supabase'))")
  if (!db.prepare('PRAGMA table_info(games)').all().some(column => column.name === 'status')) {
    db.exec("ALTER TABLE games ADD COLUMN status TEXT NOT NULL DEFAULT 'waiting'")
    for (const row of db.prepare('SELECT id,body FROM games').all()) db.prepare('UPDATE games SET status=? WHERE id=?').run(JSON.parse(String(row.body)).status, String(row.id))
  }
  db.exec('CREATE INDEX IF NOT EXISTS games_status ON games(status,updated_at)')
  const now = new Date().toISOString()
  const insertUser = db.prepare('INSERT OR IGNORE INTO users(id,name,email,role,password_hash,created_at) VALUES (?,?,?,?,?,?)')
  for (const [id, name, email, role] of [
    ['demo-student', 'Camille Laurent', 'eleve@herbier.local', 'student'],
    ['demo-contributor', 'Alex Martin', 'contributeur@herbier.local', 'contributor'],
    ['demo-admin', 'Morgan Dubois', 'admin@herbier.local', 'admin'],
  ]) {
    if (!db.prepare('SELECT id FROM users WHERE id=?').get(id!)) insertUser.run(id!, name!, email!, role!, hashPassword('Herbier2026!'), now)
  }
  for (const chapter of chapters) db.prepare('INSERT OR IGNORE INTO chapters(id,body) VALUES (?,?)').run(chapter.id, JSON.stringify(chapter))
  if (!db.prepare("SELECT value FROM metadata WHERE key='seeded'").get()) {
    db.exec('BEGIN')
    try {
      for (const input of seedQuestions) {
        const q: Question = { ...input, id: randomUUID(), authorId: 'demo-admin', createdAt: now, updatedAt: now }
        db.prepare('INSERT INTO questions(id,author_id,status,chapter_id,body) VALUES (?,?,?,?,?)').run(q.id, q.authorId, q.status, q.chapterId, JSON.stringify(q))
      }
      db.prepare('INSERT INTO metadata(key,value) VALUES (?,?)').run('seeded', now)
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  return db
}

export function publicUser(row: Record<string, unknown>): User {
  return { id: String(row.id), name: String(row.name), email: String(row.email), role: row.role as User['role'], createdAt: String(row.created_at) }
}

export function readChapters(db: DatabaseSync): Chapter[] {
  return db.prepare('SELECT body FROM chapters ORDER BY rowid').all().map(row => JSON.parse(String(row.body)) as Chapter)
}

export function readQuestions(db: DatabaseSync): Question[] {
  return db.prepare('SELECT body FROM questions ORDER BY rowid DESC').all().map(row => JSON.parse(String(row.body)) as Question)
}

export function readVisibleAnswers(db: DatabaseSync, userId?: string, chapterId?: string) {
  const hidden = new Map<string, number>()
  for (const row of db.prepare("SELECT id,body FROM games WHERE status='playing'").all()) {
    const game = JSON.parse(String(row.body)) as { mode: string; phase: string; questionIndex: number }
    if (game.mode === 'multi' && game.phase === 'question') hidden.set(String(row.id), game.questionIndex)
  }
  return db.prepare('SELECT * FROM answers WHERE (? IS NULL OR user_id=?) AND (? IS NULL OR chapter_id=?) ORDER BY created_at,question_index,rowid').all(userId ?? null, userId ?? null, chapterId ?? null, chapterId ?? null).filter(row => hidden.get(String(row.game_id)) !== Number(row.question_index))
}

export function writeQuestion(db: DatabaseSync, q: Question) {
  db.prepare('INSERT INTO questions(id,author_id,status,chapter_id,body) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,chapter_id=excluded.chapter_id,body=excluded.body').run(q.id, q.authorId, q.status, q.chapterId, JSON.stringify(q))
}
