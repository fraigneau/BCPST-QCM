import { reactive } from 'vue'
import { getSupabase, getSupabaseDataClient } from './supabase'
import { createSessionService, type SessionState } from './session-service'
import { readBackendMode } from './backend-mode'
import { createCloudTransport } from './cloud-transport'
import { subscribeGameEvents } from './game-events'
import { subscribeCloudGame } from './cloud-game'
import type { GameState } from '../../shared/types'

export const session = reactive<SessionState>({ user: null, bootstrap: null, loading: true, authMode: 'local', error: null })
export const backendMode = readBackendMode(import.meta.env)
const transport = backendMode === 'supabase' ? createCloudTransport(getSupabaseDataClient) : (...args: Parameters<typeof fetch>) => fetch(...args)

const service = createSessionService(session, {
  fetch: transport,
  getClient: getSupabase,
  clearActiveGame: () => { if (typeof window !== 'undefined') window.sessionStorage.removeItem('herbier-active-game') },
})

export async function api<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  return service.request<T>(path, options)
}

export function post<T = unknown>(path: string, body: unknown = {}): Promise<T> {
  return api<T>(path, { method: 'POST', body: JSON.stringify(body) })
}

export const refreshSession = service.refreshSession
export const signIn = service.signIn
export const signUp = service.signUp
export const signOut = service.signOut
export const authenticationHeaders = service.headers
export const sessionGeneration = service.generation

export function subscribeGame(options: { gameId: string; mode: 'solo' | 'multi'; onState: (state: GameState) => void; onConnection: (connected: boolean) => void }) {
  return backendMode === 'supabase'
    ? subscribeCloudGame({ ...options, generation: service.generation, load: () => api<GameState>(`/games/${options.gameId}`) })
    : subscribeGameEvents({ ...options, headers: service.headers, generation: service.generation })
}

if (import.meta.hot) import.meta.hot.dispose(service.dispose)
