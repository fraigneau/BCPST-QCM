import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolveConfig } from 'vite'

test('le build Pages charge sa configuration publique sans .env.local et refuse une configuration invalide', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'qcm-pages-env-'))
  const previousNodeEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  const previous = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith('VITE_')))
  for (const name of Object.keys(previous)) delete process.env[name]
  t.after(() => {
    for (const name of Object.keys(process.env)) if (name.startsWith('VITE_')) delete process.env[name]
    Object.assign(process.env, previous)
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
    rmSync(directory, { recursive: true, force: true })
  })
  const options = { configFile: resolve('vite.config.ts'), envDir: directory, mode: 'production', logLevel: 'silent' as const }
  await assert.rejects(resolveConfig(options, 'build', 'production'), /VITE_SUPABASE_URL/)
  writeFileSync(join(directory, '.env.production'), readFileSync('.env.production'))
  const production = await resolveConfig(options, 'build', 'production')
  assert.equal(production.env.VITE_BACKEND, 'supabase')
  assert.equal(production.env.VITE_SUPABASE_URL, 'https://bogagjweldkzbgdvpxsw.supabase.co')
  assert.match(production.env.VITE_SUPABASE_PUBLISHABLE_KEY, /^sb_publishable_/)
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_override'
  assert.equal((await resolveConfig(options, 'build', 'production')).env.VITE_SUPABASE_PUBLISHABLE_KEY, 'sb_publishable_override')
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY = 'sb_secret_forbidden'
  await assert.rejects(resolveConfig(options, 'build', 'production'), /clé publique/)
  process.env.VITE_BACKEND = 'invalid'
  await assert.rejects(resolveConfig(options, 'build', 'production'), /VITE_BACKEND/)
})
