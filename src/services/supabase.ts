import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { readSupabaseConfiguration } from './supabase-config'
import { createSupabaseDataClient } from './supabase-data'

let client: SupabaseClient | undefined

export function getSupabaseDataClient(authorization: string): SupabaseClient {
  const configuration = readSupabaseConfiguration(import.meta.env)
  return createSupabaseDataClient(configuration, authorization)
}

export function getSupabase(): SupabaseClient {
  if (!client) {
    const configuration = readSupabaseConfiguration(import.meta.env)
    client = createClient(configuration.url, configuration.publishableKey, {
      auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(10000)]) }) },
    })
  }
  return client
}
