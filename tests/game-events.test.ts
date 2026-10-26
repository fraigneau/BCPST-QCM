import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEventDecoder, subscribeGameEvents } from '../src/services/game-events.ts'

test('le flux SSE conserve les événements fractionnés, CRLF, commentaires et données multilignes', () => {
  const events: { event: string; data: string }[] = []
  const decode = createEventDecoder((event, data) => events.push({ event, data }))
  for (const chunk of ['retry: 1500\r\n: heartbeat\r\n\r\neve', 'nt: state\r\ndata: {"name":"Él', 'ève"}\r', '\n\r\nevent: message\ndata: première\ndata: seconde\n\n']) decode(chunk)
  assert.deepEqual(events, [{ event: 'state', data: '{"name":"Élève"}' }, { event: 'message', data: 'première\nseconde' }])
})

test('le flux SSE transmet Bearer hors URL et accepte un caractère UTF8 coupé entre deux paquets', async () => {
  const bytes = new TextEncoder().encode('event: state\ndata: {"id":"élève"}\n\n')
  const cut = bytes.indexOf(195) + 1
  const seen: unknown[] = []
  let finish!: () => void
  const received = new Promise<void>(resolve => { finish = resolve })
  const close = subscribeGameEvents({
    gameId: 'salon-test', headers: async () => new Headers({ Authorization: 'Bearer valid-token' }), generation: () => 1,
    onConnection: () => {}, onState: state => { seen.push(state); finish() },
    fetch: async (url, init) => {
      assert.equal(url, '/api/games/salon-test/events')
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer valid-token')
      const body = new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, cut)); controller.enqueue(bytes.slice(cut)); controller.close() } })
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
    },
  })
  try { await received; assert.deepEqual(seen, [{ id: 'élève' }]) }
  finally { close() }
})

test('changer de session pendant l’ouverture du flux ignore les événements de l’ancien compte', async () => {
  let generation = 1
  let resolveResponse!: (response: Response) => void
  let resolveStarted!: () => void
  const started = new Promise<void>(resolve => { resolveStarted = resolve })
  const states: unknown[] = []
  const close = subscribeGameEvents({ gameId: 'test', headers: async () => new Headers(), generation: () => generation,
    onConnection: () => {}, onState: state => states.push(state),
    fetch: () => { resolveStarted(); return new Promise<Response>(resolve => { resolveResponse = resolve }) },
  })
  await started
  generation++
  resolveResponse(new Response('event: state\ndata: {"id":"old"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }))
  await new Promise(resolve => setTimeout(resolve, 0))
  close()
  assert.deepEqual(states, [])
})
