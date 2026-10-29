import type { SupabaseClient } from '@supabase/supabase-js'

type CloudClient = Pick<SupabaseClient, 'rpc' | 'storage'>
type RpcRoute = { fn: 'qcm_game' | 'qcm_content' | 'qcm_set_username'; action: string; payload: Record<string, unknown> }

export function cloudRoute(path: string, method: string, body: Record<string, unknown> = {}): RpcRoute {
  const url = new URL(path, 'https://qcm.invalid')
  const pathname = url.pathname.replace(/^\/api/, '')
  const payload = { ...Object.fromEntries(url.searchParams), ...body }
  if (method === 'PATCH' && pathname === '/profile/username') return { fn: 'qcm_set_username', action: 'set_username', payload: { candidate: body.username } }
  const fixed: Record<string, [RpcRoute['fn'], string]> = {
    'POST /chapters': ['qcm_content', 'create_chapter'],
    'GET /bootstrap': ['qcm_content', 'bootstrap'], 'GET /chapters': ['qcm_content', 'chapters'],
    'GET /progress': ['qcm_game', 'progress'], 'GET /leaderboard': ['qcm_game', 'leaderboard'],
    'GET /questions': ['qcm_content', 'questions'], 'GET /questions/export': ['qcm_content', 'export'],
    'POST /questions/import': ['qcm_content', 'import'], 'POST /questions': ['qcm_content', 'create_question'],
    'GET /users': ['qcm_content', 'users'], 'POST /games/solo': ['qcm_game', 'solo'],
    'POST /rooms': ['qcm_game', 'create_room'], 'POST /rooms/join': ['qcm_game', 'join_room'],
  }
  const match = fixed[`${method} ${pathname}`]
  if (match) return { fn: match[0], action: match[1], payload }
  const question = /^\/questions\/([^/]+)(?:\/(review))?$/.exec(pathname)
  if (question && ((method === 'PUT' && !question[2]) || (method === 'DELETE' && !question[2]) || (method === 'POST' && question[2]))) return { fn: 'qcm_content', action: question[2] ? 'review' : method === 'PUT' ? 'update_question' : 'delete_question', payload: { ...payload, questionId: decodeURIComponent(question[1]!) } }
  const chapter = /^\/chapters\/([^/]+)$/.exec(pathname)
  if (chapter && method === 'PATCH') return { fn: 'qcm_content', action: 'update_chapter', payload: { ...payload, chapterId: decodeURIComponent(chapter[1]!) } }
  const user = /^\/users\/([^/]+)$/.exec(pathname)
  if (user && method === 'PATCH') return { fn: 'qcm_content', action: 'update_user', payload: { ...payload, userId: decodeURIComponent(user[1]!) } }
  const game = /^\/games\/([^/]+)(?:\/(start|answer|next|leave))?$/.exec(pathname)
  if (game && ((method === 'GET' && !game[2]) || (method === 'POST' && game[2]))) return { fn: 'qcm_game', action: game[2] ?? 'state', payload: { ...payload, gameId: decodeURIComponent(game[1]!) } }
  throw new Error('Cette action n’est pas disponible.')
}

export function cloudStatus(error: { code?: string; status?: number }): number {
  if (['PGRST301', 'PGRST302', 'PGRST303'].includes(error.code ?? '')) return 401
  if (error.code === '42501') return 403
  if (error.code === 'P0002') return 404
  if (['23505', '55000'].includes(error.code ?? '')) return 409
  if (error.code?.startsWith('22') || ['23514', '23502', '23503'].includes(error.code ?? '')) return 400
  return error.status && error.status >= 400 ? error.status : 503
}

type ImageContext = { client: CloudClient; images: Map<string, { url: string; until: number }>; imagePaths: Map<string, string> }

export function createCloudTransport(getClient: (authorization: string) => CloudClient): typeof fetch {
  let current: { authorization: string; context: ImageContext } | undefined
  function contextFor(authorization: string): ImageContext {
    if (current?.authorization !== authorization) current = { authorization, context: { client: getClient(authorization), images: new Map(), imagePaths: new Map() } }
    return current.context
  }
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

  async function hydrate<T>(data: T, context: ImageContext): Promise<T> {
    const { images, imagePaths, client } = context
    const paths = new Set<string>()
    function visit(value: unknown, replace: boolean) {
      if (!value || typeof value !== 'object') return
      if (Array.isArray(value)) { value.forEach(item => visit(item, replace)); return }
      const record = value as Record<string, unknown>
      for (const [key, item] of Object.entries(record)) {
        if (key === 'image' && typeof item === 'string' && !item.startsWith('/')) {
          const cached = images.get(item)
          if (replace && cached) record[key] = cached.url
          else if (!cached || cached.until <= Date.now()) paths.add(item)
        } else visit(item, replace)
      }
    }
    visit(data, false)
    if (paths.size) {
      const { data: signed, error } = await client.storage.from('question-images').createSignedUrls([...paths], 3600)
      if (error) throw new Error('Impossible de charger les images de cette question.')
      for (const item of signed ?? []) {
        if (!item.path || !item.signedUrl || item.error) throw new Error('Une image est inaccessible.')
        const old = images.get(item.path)
        if (old) imagePaths.delete(old.url)
        images.set(item.path, { url: item.signedUrl, until: Date.now() + 3300000 })
        imagePaths.set(item.signedUrl, item.path)
      }
      if (images.size > 500) for (const [path, item] of images) if (item.until <= Date.now()) { images.delete(path); imagePaths.delete(item.url) }
    }
    visit(data, true)
    return data
  }

  function normalizeImage(value: unknown, context: ImageContext): unknown {
    if (!value || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map(item => normalizeImage(item, context))
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'image' && typeof item === 'string' ? imagePath(item, context) : normalizeImage(item, context)]))
  }

  function imagePath(value: string, context: ImageContext): string {
    const cached = context.imagePaths.get(value)
    if (cached) return cached
    try {
      const url = new URL(value)
      const prefix = '/storage/v1/object/sign/question-images/'
      if (url.protocol === 'https:' && url.hostname.endsWith('.supabase.co') && url.pathname.startsWith(prefix)) return decodeURIComponent(url.pathname.slice(prefix.length))
    } catch { }
    return value
  }

  async function upload(body: Record<string, unknown>, context: ImageContext, authorization: string) {
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(body.dataUrl ?? ''))
    if (!match) return json({ message: 'Utilise une image PNG, JPEG ou WebP.' }, 400)
    const binary = atob(match[2]!)
    if (!binary.length || binary.length > 2097152) return json({ message: 'L’image doit faire moins de 2 Mo.' }, 400)
    let userId: unknown
    try { userId = JSON.parse(atob(authorization.split('.')[1]!.replaceAll('-', '+').replaceAll('_', '/'))).sub } catch { }
    if (typeof userId !== 'string' || !/^[0-9a-f-]{36}$/i.test(userId)) return json({ message: 'Reconnecte-toi pour ajouter une image.' }, 401)
    const path = `${userId}/${crypto.randomUUID()}.${match[1] === 'jpeg' ? 'jpg' : match[1]}`
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
    const { error } = await context.client.storage.from('question-images').upload(path, bytes, { contentType: `image/${match[1]}`, upsert: false })
    if (error) return json({ message: 'Impossible d’importer cette image.' }, cloudStatus(error))
    return json(await hydrate({ url: '', image: path }, context).then(item => ({ url: item.image })))
  }

  return async (input, options = {}) => {
    try {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const method = (options.method ?? 'GET').toUpperCase()
      if (path === '/api/config') return json({ authMode: 'supabase' })
      if (path === '/api/auth/logout') return json({})
      const authorization = new Headers(options.headers ?? (input instanceof Request ? input.headers : undefined)).get('Authorization') ?? ''
      if (!/^Bearer \S+$/.test(authorization)) return json({ message: 'Connecte-toi pour continuer.' }, 401)
      const context = contextFor(authorization)
      const body = options.body ? JSON.parse(String(options.body)) as Record<string, unknown> : {}
      if (path === '/api/uploads' && method === 'POST') return await upload(body, context, authorization)
      const route = cloudRoute(path, method, normalizeImage(body, context) as Record<string, unknown>)
      let call = context.client.rpc(route.fn, route.fn === 'qcm_set_username' ? route.payload : { action: route.action, payload: route.payload })
      if (options.signal) call = call.abortSignal(options.signal)
      const { data, error } = await call
      if (error) {
        const status = cloudStatus(error)
        if (route.fn === 'qcm_set_username' && error.code === '23505') return json({ message: 'Ce pseudo est déjà utilisé. Choisis-en un autre.' }, 409)
        return json({ message: ['PGRST202', '42883'].includes(error.code) ? 'La base Supabase doit être mise à jour avant de jouer.' : status >= 500 ? 'Supabase est momentanément indisponible. Réessaie.' : error.message }, status)
      }
      return json(route.action === 'export' ? data : await hydrate(data, context))
    } catch (error) {
      return json({ message: error instanceof Error ? error.message : 'Impossible de contacter Supabase.' }, 503)
    }
  }
}
