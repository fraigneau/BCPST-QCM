import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type ViteDevServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { createSSRApp, h, type Component } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import type { Bootstrap, GameState, Role, User } from '../shared/types.ts'

let server: ViteDevServer
type AuthMode = 'local' | 'supabase'
let session: { user: User | null; bootstrap: Bootstrap | null; loading: boolean; authMode: AuthMode; error: string | null }
const views = new Map<string, Component>()
const chapters = [{ id: 'cellulaire', name: 'Biologie cellulaire et génétique', shortName: 'Cellule & génétique', description: 'La cellule et son fonctionnement.', color: '#718b69', icon: 'Cell' }, { id: 'vegetale', name: 'Biologie végétale', shortName: 'Biologie végétale', description: 'Le fonctionnement des plantes.', color: '#a2a86c', icon: 'Leaf' }]

before(async () => {
  server = await createServer({ configFile: false, plugins: [vue()], server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error' })
  session = (await server.ssrLoadModule('/src/services/api.ts')).session
  views.set('App', (await server.ssrLoadModule('/src/App.vue')).default)
  views.set('QuizBoard', (await server.ssrLoadModule('/src/components/QuizBoard.vue')).default)
  views.set('QuestionFolders', (await server.ssrLoadModule('/src/components/QuestionFolders.vue')).default)
  for (const name of ['Auth', 'Dashboard', 'Practice', 'Multiplayer', 'Game', 'Editor', 'Admin', 'Progress', 'Leaderboard']) views.set(name, (await server.ssrLoadModule(`/src/views/${name}View.vue`)).default)
})

after(async () => { await server?.close() })

function configure(role: Role | null, authMode: AuthMode = 'local') {
  session.loading = false
  session.authMode = authMode
  session.error = null
  session.user = role ? { id: `test-${role}`, name: 'Camille Martin', email: 'camille@example.test', role, createdAt: '2026-10-01T12:00:00Z' } : null
  session.bootstrap = session.user ? { user: session.user, chapters, counts: { cellulaire: 10, vegetale: 8 }, progress: { totalPoints: 745, answered: 8, correct: 6, accuracy: 75, gamesPlayed: 2, streak: 3, chapters: [{ chapterId: 'cellulaire', answered: 4, correct: 3, points: 400 }], recentGames: [], mistakes: [], daily: [] } } : null
}

async function render(name: string, role: Role | null, url = '/', authMode: AuthMode = 'local') {
  configure(role, authMode)
  const component = views.get(name)
  assert.ok(component, `Vue ${name} disponible`)
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component }] })
  await router.push(url)
  await router.isReady()
  const app = createSSRApp({ render: () => h(RouterView) })
  app.use(router)
  const warnings: string[] = []
  app.config.warnHandler = message => { warnings.push(message) }
  const html = await renderToString(app)
  assert.equal(warnings.length, 0, warnings.join('\n'))
  assert.ok(!html.includes('[object Object]'))
  return html
}

test('la connexion se rend sans session et propose les trois profils de démonstration', async () => {
  const html = await render('Auth', null, '/connexion')
  assert.match(html, /type="text"/)
  assert.match(html, /E-mail ou nom d’utilisateur/)
  assert.match(html, /type="password"/)
  assert.match(html, /Contributeur/)
  assert.match(html, /Élève/)
  assert.match(html, /Admin/)
})

test('la connexion Supabase présente un formulaire vide sans comptes de démonstration', async () => {
  const html = await render('Auth', null, '/connexion', 'supabase')
  assert.match(html, /Se connecter/)
  assert.match(html, /autocomplete="username"/)
  assert.match(html, /autocomplete="current-password"/)
  assert.ok(!html.includes('demo-access'))
  assert.ok(!html.includes('Explorez les trois espaces'))
  assert.ok(!html.includes('herbier.local'))
  assert.ok(!html.includes('Herbier2026!'))
  assert.ok(!html.includes('Version locale'))
})

test('l’administration Supabase précise où gérer les rôles', async () => {
  const html = await render('Admin', 'admin', '/admin', 'supabase')
  assert.match(html, /Les rôles se gèrent dans Supabase pendant cette étape/)
})

test('le tableau de bord rend les statistiques et chapitres de la session', async () => {
  const html = await render('Dashboard', 'student')
  assert.match(html, /Bonjour Camille/)
  assert.match(html, /745/)
  assert.match(html, /75/)
  assert.match(html, /Biologie cellulaire et génétique/)
  assert.match(html, /18 questions/)
  assert.match(html, /href="\/multiplayer"/)
})

test('la préparation sélectionne le chapitre transmis par la route', async () => {
  const html = await render('Practice', 'student', '/practice?chapter=vegetale&mistakes=1')
  assert.match(html, /<button[^>]*aria-pressed="true"[^>]*>[^]*?Biologie végétale/)
  assert.match(html, /<input(?=[^>]*type="checkbox")(?=[^>]*checked)[^>]*>/)
  assert.match(html, /1 chapitre/)
  assert.match(html, /Jusqu’à 10 questions/)
})

test('le salon propose création, invitation et informations de réseau local', async () => {
  const html = await render('Multiplayer', 'student', '/multiplayer')
  assert.match(html, /Créer un salon/)
  assert.match(html, /Le code à 6 caractères/)
  assert.match(html, /même Wi-Fi/)
  assert.match(html, /30 s/)
})

test('la partie attend une réponse serveur avant de révéler une question', async () => {
  const html = await render('Game', 'student', '/game/test-game')
  assert.match(html, /Préparation de votre séance/)
  assert.ok(!html.includes('Valider ma réponse'))
  assert.ok(!html.includes('correctAnswers'))
})

test('les élèves ne voient ni l’éditeur ni les commandes administrateur', async () => {
  const editor = await render('Editor', 'student', '/questions')
  assert.match(editor, /Espace réservé aux contributeurs/)
  assert.ok(!editor.includes('Nouvelle question'))
  const admin = await render('Admin', 'student', '/admin')
  assert.match(admin, /uniquement à l’administrateur/)
  assert.ok(!admin.includes('Valider et publier'))
})

test('les contributeurs disposent de leur bibliothèque et pas de la modération', async () => {
  const editor = await render('Editor', 'contributor', '/questions')
  assert.match(editor, /Nouvelle question/)
  assert.match(editor, /Importer/)
  assert.match(editor, /Exporter/)
  const admin = await render('Admin', 'contributor', '/admin')
  assert.match(admin, /uniquement à l’administrateur/)
})

test('les dossiers présentent les chapitres vides et les publications en attente sans afficher les corrections', async () => {
  const question = { id: 'folder-q', chapterId: 'cellulaire', difficulty: 'easy', prompt: 'Énoncé qui ne doit pas apparaître dans les dossiers.', options: ['A','B','C','D'], correctAnswers: [0], explanation: 'Correction réservée à la question ouverte.', image: null, status: 'pending', authorId: 'test-admin', createdAt: '2026-10-01', updatedAt: '2026-10-01' }
  const html = await renderToString(createSSRApp(views.get('QuestionFolders')!, { chapters, questions: [question, { ...question, id: 'folder-published', status: 'published' }] }))
  assert.equal((html.match(/class="folder-row"/g) || []).length, 2)
  assert.match(html, /Ouvrir le dossier Biologie cellulaire et génétique, 2 questions, 1 publiée, 1 à valider/)
  assert.match(html, /Ouvrir le dossier Biologie végétale, 0 question, 0 publiée, 0 à valider/)
  assert.ok(!html.includes(question.prompt))
  assert.ok(!html.includes(question.explanation))
})

test('un lien de dossier ouvre le chapitre demandé et conserve un retour à la bibliothèque', async () => {
  const html = await render('Editor', 'admin', '/questions?chapter=vegetale')
  assert.match(html, /Biologie végétale/)
  assert.match(html, /Retour aux dossiers/)
  assert.match(html, /Rechercher dans ce dossier/)
  assert.match(html, /Exporter ce dossier/)
  assert.match(html, /Filtrer par difficulté/)
  assert.ok(!html.includes('Filtrer par chapitre'))
})

test('l’administrateur dispose de la validation et de la gestion des utilisateurs', async () => {
  const admin = await render('Admin', 'admin', '/admin')
  assert.match(admin, /Validation des questions/)
  assert.match(admin, /Utilisateurs/)
  const editor = await render('Editor', 'admin', '/questions')
  assert.match(editor, /Nouvelle question/)
})

test('la progression et les classements affichent leurs états de chargement', async () => {
  const progress = await render('Progress', 'student', '/progression')
  assert.match(progress, /Camille Martin/)
  assert.match(progress, /Chargement de votre progression/)
  const board = await render('Leaderboard', 'student', '/classements')
  assert.match(board, /Cellule &amp; génétique/)
  assert.match(board, /Chargement du classement/)
})

test('la coque de l’application rend la navigation, le profil et le tableau de bord', async () => {
  for (const role of ['student', 'admin'] as const) {
    configure(role)
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', name: 'home', component: views.get('Dashboard')! }] })
    await router.push('/')
    await router.isReady()
    const app = createSSRApp(views.get('App')!)
    app.use(router)
    const warnings: string[] = []
    app.config.warnHandler = message => { warnings.push(message) }
    const html = await renderToString(app)
    assert.equal(warnings.length, 0, warnings.join('\n'))
    assert.match(html, /<a[^>]*class="[^"]*\bbrand\b[^"]*"/)
    assert.match(html, /QCM BCPST/)
    assert.match(html, /aria-label="Navigation mobile"/)
    assert.match(html, /aria-label="Mon profil"/)
    assert.match(html, /id="main-content"/)
    assert.match(html, /Bonjour Camille/)
    const navigation = html.match(/<nav[^>]*aria-label="Navigation mobile"[^>]*>([^]*?)<\/nav>/)?.[1] ?? ''
    assert.equal((navigation.match(/<a\b/g) ?? []).length, 4)
    assert.match(navigation, /aria-current="page"/)
    assert.ok(!html.includes('class="sidebar"'))
    assert.ok(!html.includes('app-footer'))
  }
})

test('le profil mobile donne accès aux outils selon le rôle et à la déconnexion', async () => {
  for (const role of ['student', 'contributor', 'admin'] as const) {
    const html = await render('Progress', role, '/progression')
    assert.match(html, /Se déconnecter/)
    assert.equal(html.includes('href="/questions"'), role !== 'student')
    assert.equal(html.includes('href="/admin"'), role === 'admin')
  }
})

test('le profil permet de choisir son pseudo de connexion en conservant le nom affiché', async () => {
  const html = await render('Progress', 'student', '/progression')
  assert.match(html, /Camille Martin/)
  assert.match(html, /Choisir mon pseudo/)
  assert.match(html, /autocomplete="username"/)
})

function boardState(mode: 'solo' | 'multi'): GameState {
  return {
    id: 'board-test', mode, status: 'playing', phase: 'question', chapterIds: ['cellulaire'], hostId: 'test-student',
    questionIndex: 0, totalQuestions: 5, deadline: mode === 'multi' ? Date.now() + 30_000 : null, serverNow: Date.now(),
    players: [{ id: 'test-student', name: 'Camille Martin', score: 0, answered: false, connected: true }],
    question: { id: 'q-board', chapterId: 'cellulaire', difficulty: 'easy', prompt: 'Quels éléments participent à la traduction ?', options: ['Le ribosome', 'Les ARN de transfert', 'La cellulose', 'Le chloroplaste uniquement'], image: null, status: 'published', createdAt: '2026-10-21T12:00:00Z', updatedAt: '2026-10-21T12:00:00Z' },
    result: null, results: [],
  }
}

async function renderBoard(game: GameState, remaining: number, selected: number[]) {
  return renderToString(createSSRApp(views.get('QuizBoard')!, { game, remaining, selected, busy: false, userId: 'test-student', chapter: chapters[0] }))
}

test('les quatre réponses restent sélectionnables en solo avec une échéance nulle', async () => {
  const html = await renderBoard(boardState('solo'), 0, [])
  const options = html.match(/<button[^>]*class="[^"]*answer-tile[^>]*>/g) || []
  assert.equal(options.length, 4)
  assert.ok(options.every(option => !option.includes('disabled')))
  assert.match(html, /Sans chrono/)
  assert.ok(!html.includes('secondes restantes'))
})

test('le défi multijoueur bloque les choix à expiration du chrono', async () => {
  const game = boardState('multi')
  const active = await renderBoard(game, 12, [0, 1])
  assert.match(active, /12 secondes restantes/)
  assert.equal((active.match(/aria-pressed="true"/g) || []).length, 2)
  assert.match(active, /2 réponses sélectionnées/)
  const expired = await renderBoard(game, 0, [0])
  const options = expired.match(/<button[^>]*class="[^"]*answer-tile[^>]*>/g) || []
  assert.equal(options.length, 4)
  assert.ok(options.every(option => option.includes('disabled')))
})

test('la correction affiche les bonnes réponses et le passage manuel en solo', async () => {
  const game = boardState('solo')
  game.phase = 'correction'
  game.players[0]!.answered = true
  game.result = { questionId: 'q-board', selected: [0, 2], correctAnswers: [0, 1], explanation: 'Les ribosomes et les ARN de transfert participent à la traduction.', correct: false, points: 0, elapsedMs: 80_000 }
  const html = await renderBoard(game, 0, [0, 2])
  assert.equal((html.match(/Bonne réponse/g) || []).length, 2)
  assert.match(html, /À revoir/)
  assert.match(html, /Les ribosomes et les ARN de transfert/)
  assert.match(html, /Question suivante/)
  assert.ok(!html.includes('Prochaine question'))
})

test('la route de jeu réserve l’écran à la partie et masque les navigations', async () => {
  configure('student')
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/game/:id', name: 'game', component: views.get('Game')! }] })
  await router.push('/game/test-game')
  await router.isReady()
  const app = createSSRApp(views.get('App')!)
  app.use(router)
  const html = await renderToString(app)
  assert.match(html, /game-focus/)
  assert.match(html, /Préparation de votre séance/)
  assert.ok(!html.includes('aria-label="Navigation principale"'))
  assert.ok(!html.includes('aria-label="Navigation mobile"'))
  assert.ok(!html.includes('class="topbar"'))
  assert.ok(!html.includes('class="app-footer"'))
})

test('une panne de chargement de session affiche une reprise explicite sans contenu de compte', async () => {
  configure(null, 'supabase')
  session.error = 'Le service est temporairement indisponible. Réessayez.'
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: views.get('Dashboard')! }] })
  await router.push('/')
  await router.isReady()
  const app = createSSRApp(views.get('App')!)
  app.use(router)
  const html = await renderToString(app)
  assert.match(html, /Connexion interrompue/)
  assert.match(html, /Le service est temporairement indisponible/)
  assert.match(html, /Réessayer/)
  assert.match(html, /Se déconnecter/)
  assert.ok(!html.includes('Bonjour Camille'))
  assert.ok(!html.includes('aria-label="Navigation principale"'))
})
