export interface SupabaseEnvironment {
  VITE_SUPABASE_URL?: string
  VITE_SUPABASE_PUBLISHABLE_KEY?: string
}

export interface SupabaseConfiguration {
  url: string
  publishableKey: string
}

export function readSupabaseConfiguration(environment: SupabaseEnvironment): SupabaseConfiguration {
  const rawUrl = environment.VITE_SUPABASE_URL?.trim()
  const publishableKey = environment.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()

  if (!rawUrl || !publishableKey) throw new Error('Renseignez VITE_SUPABASE_URL et VITE_SUPABASE_PUBLISHABLE_KEY dans .env.local, puis redémarrez le serveur.')
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey)) throw new Error('Utilisez la clé publique Supabase commençant par sb_publishable_. Les clés secrètes ne sont pas acceptées dans le frontend.')

  let url: URL
  try { url = new URL(rawUrl) }
  catch { throw new Error('VITE_SUPABASE_URL doit contenir l’URL du projet Supabase.') }

  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('L’URL Supabase doit utiliser HTTPS, ou HTTP pour une instance locale.')
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Utilisez uniquement l’URL du projet, sans chemin, identifiants ni paramètres.')

  return { url: url.origin, publishableKey }
}
