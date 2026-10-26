import type { GameState } from '../../shared/types.ts'

export function subscribeCloudGame(options: { mode: 'solo' | 'multi'; load: () => Promise<GameState>; generation: () => number; onState: (state: GameState) => void; onConnection: (connected: boolean) => void }) {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const generation = options.generation()
  const active = () => !stopped && generation === options.generation()
  async function update() {
    if (!active()) return
    try {
      if (typeof document !== 'undefined' && document.hidden) { timer = setTimeout(update, 3000); return }
      const game = await options.load()
      if (!active()) return
      options.onConnection(true)
      options.onState(game)
      if (game.status === 'finished') return
    } catch { if (active()) options.onConnection(false) }
    if (active()) timer = setTimeout(update, 1000)
  }
  options.onConnection(true)
  if (options.mode === 'multi') timer = setTimeout(update, 1000)
  return () => { stopped = true; clearTimeout(timer) }
}
