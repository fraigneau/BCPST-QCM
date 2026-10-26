import { createRouter, createWebHistory } from 'vue-router'
import { refreshSession, session } from './services/api'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/connexion', name: 'login', component: () => import('./views/AuthView.vue'), meta: { public: true } },
    { path: '/', name: 'home', component: () => import('./views/DashboardView.vue') },
    { path: '/practice', name: 'practice', component: () => import('./views/PracticeView.vue') },
    { path: '/game/:id', name: 'game', component: () => import('./views/GameView.vue') },
    { path: '/multiplayer', name: 'multiplayer', component: () => import('./views/MultiplayerView.vue') },
    { path: '/classements', name: 'leaderboard', component: () => import('./views/LeaderboardView.vue') },
    { path: '/progression', name: 'progress', component: () => import('./views/ProgressView.vue') },
    { path: '/questions', name: 'questions', component: () => import('./views/EditorView.vue'), meta: { roles: ['admin', 'contributor'] } },
    { path: '/admin', name: 'admin', component: () => import('./views/AdminView.vue'), meta: { roles: ['admin'] } },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
  scrollBehavior: () => ({ top: 0 }),
})

router.beforeEach(async to => {
  if (session.loading) await refreshSession()
  if (!to.meta.public && !session.user) return { name: 'login', query: { redirect: to.fullPath } }
  if (to.name === 'login' && session.user) return '/'
  const roles = to.meta.roles as string[] | undefined
  if (roles && session.user && !roles.includes(session.user.role)) return '/'
})
