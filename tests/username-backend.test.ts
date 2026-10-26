import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { createApp } from '../server/index.ts'
import { openDatabase } from '../server/database.ts'

test('un compte local se connecte avec son pseudo ou son e-mail, conserve son rôle et son pseudo après redémarrage', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qcm-username-'))
  const options = { authMode: 'local' as const, dbPath: join(directory, 'test.sqlite'), uploadsDir: join(directory, 'uploads') }
  let runtime = createApp(options)
  let base = ''
  let cookie = ''
  async function start() {
    runtime.server.listen(0, '127.0.0.1')
    await once(runtime.server, 'listening')
    const address = runtime.server.address()
    assert.ok(address && typeof address !== 'string')
    base = `http://127.0.0.1:${address.port}/api`
  }
  async function send(path: string, body?: unknown, method = 'POST') {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const nextCookie = response.headers.get('set-cookie')
    if (nextCookie) cookie = nextCookie.split(';')[0]!
    return { status: response.status, body: await response.json() }
  }
  try {
    await start()
    const created = await send('/auth/register', { name: 'Yann', username: '  YaNN ', email: 'yann@example.test', password: 'FixtureOnly2026!', role: 'admin' })
    assert.equal(created.status, 201)
    assert.equal(created.body.user.username, 'yann')
    assert.equal(created.body.user.role, 'student')
    const id = created.body.user.id
    assert.equal((await send('/auth/register', { name: 'Autre Yann', username: 'YANN', email: 'other@example.test', password: 'FixtureOnly2026!' })).status, 409)
    for (const identifier of [' YANN ', 'YANN@EXAMPLE.TEST']) {
      const login = await send('/auth/login', { identifier, password: 'FixtureOnly2026!' })
      assert.equal(login.status, 200)
      assert.equal(login.body.user.id, id)
    }
    const wrong = await send('/auth/login', { identifier: 'yann', password: 'wrong' })
    const unknown = await send('/auth/login', { identifier: 'unknown-person', password: 'wrong' })
    assert.equal(wrong.status, 401)
    assert.deepEqual(wrong, unknown)
    assert.equal((await send('/profile/username', { username: 'admin' }, 'PATCH')).status, 409)
    assert.equal((await send('/profile/username', { username: 'bad@email.test' }, 'PATCH')).status, 400)
    assert.equal((await send('/profile/username', { username: 'yann.bcpst', role: 'admin' }, 'PATCH')).status, 400)
    const changed = await send('/profile/username', { username: ' Yann.BCPST ' }, 'PATCH')
    assert.equal(changed.status, 200)
    assert.equal(changed.body.id, id)
    assert.equal(changed.body.username, 'yann.bcpst')
    assert.equal(changed.body.role, 'student')
    assert.equal((await send('/auth/login', { identifier: 'yann', password: 'FixtureOnly2026!' })).status, 401)
    await runtime.close()
    runtime = createApp(options)
    await start()
    const restored = await send('/auth/login', { identifier: 'YANN.BCPST', password: 'FixtureOnly2026!' })
    assert.equal(restored.status, 200)
    assert.equal(restored.body.user.id, id)
    assert.equal(restored.body.user.username, 'yann.bcpst')
    assert.equal((await send('/auth/login', { email: 'yann@example.test', password: 'FixtureOnly2026!' })).status, 200)
  } finally { await runtime.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('la migration SQLite attribue des pseudos distincts aux anciens noms identiques sans changer leurs rôles', () => {
  const directory = mkdtempSync(join(tmpdir(), 'qcm-username-migration-'))
  const path = join(directory, 'legacy.sqlite')
  const old = new DatabaseSync(path)
  old.exec('CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,email TEXT UNIQUE,role TEXT,password_hash TEXT,created_at TEXT)')
  for (const [id, role] of [['a', 'student'], ['b', 'admin']]) old.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)').run(id!, 'Yann', `${id}@example.test`, role!, 'unused', '2026-10-01')
  old.close()
  const migrated = openDatabase(path)
  try {
    const users = migrated.prepare("SELECT id,username,role FROM users WHERE id IN ('a','b') ORDER BY id").all()
    assert.deepEqual(users.map(user => [user.username, user.role]), [['yann', 'student'], ['yann_2', 'admin']])
    assert.throws(() => migrated.prepare("UPDATE users SET username='YANN' WHERE id='b'").run(), /UNIQUE/)
  } finally { migrated.close(); rmSync(directory, { recursive: true, force: true }) }
})
