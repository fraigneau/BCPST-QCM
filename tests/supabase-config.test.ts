import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readSupabaseConfiguration } from '../src/services/supabase-config.ts'

test('la configuration Supabase accepte une URL de projet HTTPS et une clé publique', () => {
  assert.deepEqual(readSupabaseConfiguration({ VITE_SUPABASE_URL: ' https://example.supabase.co/ ', VITE_SUPABASE_PUBLISHABLE_KEY: ' sb_publishable_example ' }), { url: 'https://example.supabase.co', publishableKey: 'sb_publishable_example' })
})

test('la configuration Supabase refuse une clé secrète et une URL contenant des identifiants', () => {
  assert.throws(() => readSupabaseConfiguration({ VITE_SUPABASE_URL: 'https://example.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_example' }), /clé publique/)
  assert.throws(() => readSupabaseConfiguration({ VITE_SUPABASE_URL: 'https://user:password@example.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example' }), /identifiants/)
})

test('la configuration Supabase réserve HTTP aux instances locales et détecte les paramètres manquants', () => {
  assert.throws(() => readSupabaseConfiguration({}), /Renseignez/)
  assert.throws(() => readSupabaseConfiguration({ VITE_SUPABASE_URL: 'http://example.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example' }), /HTTPS/)
  assert.equal(readSupabaseConfiguration({ VITE_SUPABASE_URL: 'http://127.0.0.1:54321', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example' }).url, 'http://127.0.0.1:54321')
})
