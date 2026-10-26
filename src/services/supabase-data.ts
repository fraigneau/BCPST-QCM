import { createClient } from '@supabase/supabase-js'

export function createSupabaseDataClient(configuration: { url: string; publishableKey: string }, authorization: string, transport: typeof fetch = fetch) {
  const token = authorization.slice('Bearer '.length)
  return createClient(configuration.url, configuration.publishableKey, {
    accessToken: async () => token,
    global: { fetch: (input, init) => transport(input, { ...init, signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(10000)]) }) },
  })
}
