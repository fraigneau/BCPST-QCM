export type BackendMode = 'local' | 'supabase'

export function readBackendMode(environment: { VITE_BACKEND?: string; PROD?: boolean; MODE?: string }): BackendMode {
  const configured = environment.VITE_BACKEND?.trim()
  if (!configured) return environment.PROD || environment.MODE === 'cloud' ? 'supabase' : 'local'
  if (configured !== 'local' && configured !== 'supabase') throw new Error('VITE_BACKEND doit être local ou supabase.')
  return configured
}
