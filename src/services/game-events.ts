import type { GameState } from '../../shared/types.ts'

export function createEventDecoder(onEvent: (event: string, data: string) => void) {
  let pending = ''
  let event = 'message'
  let data: string[] = []
  return (chunk: string) => {
    pending += chunk
    if (pending.length > 2_000_000) throw new Error('Flux de partie invalide.')
    let newline: number
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline).replace(/\r$/, '')
      pending = pending.slice(newline + 1)
      if (!line) {
        if (data.length) onEvent(event, data.join('\n'))
        event = 'message'
        data = []
      } else if (!line.startsWith(':')) {
        const separator = line.indexOf(':')
        const field = separator < 0 ? line : line.slice(0, separator)
        const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '')
        if (field === 'event') event = value
        if (field === 'data') data.push(value)
      }
    }
  }
}

export function subscribeGameEvents(options: {
  gameId: string
  headers: () => Promise<Headers>
  generation: () => number
  onState: (state: GameState) => void
  onConnection: (connected: boolean) => void
  fetch?: typeof fetch
}) {
  const controller = new AbortController()
  const initialGeneration = options.generation()
  const active = () => !controller.signal.aborted && options.generation() === initialGeneration
  const fetcher = options.fetch ?? fetch
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let resolveRetry: (() => void) | undefined

  async function connect() {
    while (active()) {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      try {
        const headers = await options.headers()
        if (!active()) break
        headers.set('Accept', 'text/event-stream')
        const response = await fetcher(`/api/games/${encodeURIComponent(options.gameId)}/events`, { headers, signal: controller.signal, credentials: 'same-origin', cache: 'no-store' })
        if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Connexion au salon interrompue.')
        if (!active()) { await response.body.cancel(); break }
        options.onConnection(true)
        reader = response.body.getReader()
        const decoder = new TextDecoder()
        const accept = createEventDecoder((event, data) => {
          if (event === 'state' && active()) options.onState(JSON.parse(data) as GameState)
        })
        while (active()) {
          const { done, value } = await reader.read()
          if (done) break
          accept(decoder.decode(value, { stream: true }))
        }
      } catch {
      } finally {
        await reader?.cancel().catch(() => {})
        reader?.releaseLock()
        if (!controller.signal.aborted) options.onConnection(false)
      }
      if (active()) await new Promise<void>(resolve => { resolveRetry = resolve; retryTimer = setTimeout(resolve, 1500) })
    }
  }
  void connect()
  return () => { controller.abort(); clearTimeout(retryTimer); resolveRetry?.() }
}
