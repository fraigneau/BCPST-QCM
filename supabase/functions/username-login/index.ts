import { createClient } from 'npm:@supabase/supabase-js@2.118.0'
import { corsHeaders } from 'npm:@supabase/supabase-js@2.118.0/cors'
import { createAttemptLimiter, createUsernameLoginHandler } from './handler.ts'

const defaultOrigins = ['https://bcpst-qcm.pages.dev', 'http://localhost:5173', 'http://localhost:4173', 'http://127.0.0.1:5173', 'http://127.0.0.1:4173']
const allowedOrigins = Deno.env.get('ALLOWED_ORIGINS')?.split(',').map(origin => origin.trim()).filter(Boolean) ?? defaultOrigins
const attemptAllowed = createAttemptLimiter()

Deno.serve(async request => {
  const url = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const signal = AbortSignal.timeout(12000)
  const configuration = {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (input: RequestInfo | URL, options?: RequestInit) => fetch(input, { ...options, signal: AbortSignal.any([signal, ...(options?.signal ? [options.signal] : [])]) }) },
  }
  const client = (key: string | undefined) => {
    try { return url && key ? createClient(url, key, configuration) : null }
    catch { return null }
  }
  const admin = client(serviceKey)
  const auth = client(anonKey)
  return createUsernameLoginHandler({
    allowedOrigins,
    corsHeaders,
    attemptAllowed,
    async findProfile(username) {
      if (!admin || !auth) throw new Error('configuration')
      const { data, error } = await admin.from('profiles').select('id,disabled_at').eq('username', username).maybeSingle()
      if (error) throw new Error('profiles')
      return data ? { id: data.id, disabled: data.disabled_at !== null } : null
    },
    async findEmail(userId) {
      if (!admin) throw new Error('configuration')
      const { data, error } = await admin.auth.admin.getUserById(userId)
      if (error && error.status !== 404) throw new Error('user')
      return data?.user?.email ?? null
    },
    async signIn(email, password) {
      if (!auth) throw new Error('configuration')
      const { data, error } = await auth.auth.signInWithPassword({ email, password })
      if (error) return { status: error.status === 429 ? 429 : !error.status || error.status >= 500 ? 503 : 401 }
      return data.session ? { tokens: { access_token: data.session.access_token, refresh_token: data.session.refresh_token } } : { status: 401 }
    },
  })(request)
})
