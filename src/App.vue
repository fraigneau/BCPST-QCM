<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowLeft, BookOpen, Leaf, Trophy, Users, X } from './components/icons'
import { refreshSession, session, signOut } from './services/api'
import { notice, notify } from './services/feedback'

const route = useRoute()
const router = useRouter()
const retrying = ref(false)
const loggingOut = ref(false)
const gameFocus = computed(() => route.name === 'game')
const initials = computed(() => session.user?.name.split(' ').map(word => word[0]).slice(0, 2).join('') || '')
const backLabel = computed(() => ({ practice: 'Accueil', questions: 'Moi', admin: 'Moi' })[route.name as 'practice' | 'questions' | 'admin'])
const tabs = [
  { to: '/', label: 'Accueil', icon: BookOpen, name: 'home' },
  { to: '/multiplayer', label: 'Défis', icon: Users, name: 'multiplayer' },
  { to: '/classements', label: 'Classement', icon: Trophy, name: 'leaderboard' },
  { to: '/progression', label: 'Moi', name: 'progress' },
]
function activeTab(name: string) {
  return route.name === name || (name === 'home' && route.name === 'practice') || (name === 'progress' && ['questions', 'admin'].includes(String(route.name)))
}
async function logout() {
  loggingOut.value = true
  try { await signOut(); await router.replace('/connexion') }
  catch (error) { notify((error as Error).message) }
  finally { loggingOut.value = false }
}
async function retrySession() {
  retrying.value = true
  try { await refreshSession() }
  finally { retrying.value = false }
}
</script>

<template>
  <div v-if="session.loading" class="initial-loading"><Leaf :size="36" /><p>Ouverture de ton espace…</p></div>
  <main v-else-if="session.error" class="initial-loading session-error">
    <Leaf :size="36" /><h1>Connexion interrompue</h1><p class="form-error" role="alert">{{ session.error }}</p>
    <button class="button" :disabled="retrying || loggingOut" @click="retrySession">{{ retrying ? 'Nouvelle tentative…' : 'Réessayer' }}</button>
    <button v-if="session.user || session.authMode === 'supabase'" class="button secondary" :disabled="retrying || loggingOut" @click="logout">{{ loggingOut ? 'Déconnexion…' : 'Se déconnecter' }}</button>
  </main>
  <template v-else-if="route.meta.public"><RouterView /></template>
  <div v-else class="app-shell" :class="{ 'game-focus': gameFocus }">
    <a href="#main-content" class="skip-link">Aller au contenu</a>
    <header v-if="!gameFocus" class="app-header">
      <button v-if="backLabel" class="header-back" @click="router.push(route.name === 'practice' ? '/' : '/progression')"><ArrowLeft :size="21" /><span>{{ backLabel }}</span></button>
      <RouterLink v-else to="/" class="brand" aria-label="QCM BCPST, accueil"><span class="brand-mark"><Leaf :size="23" /></span><span class="brand-name">QCM BCPST</span></RouterLink>
      <RouterLink to="/progression" class="profile-shortcut" aria-label="Mon profil">{{ initials }}</RouterLink>
    </header>
    <main id="main-content" class="main-content"><RouterView :key="route.path" /></main>
    <nav v-if="!gameFocus" class="bottom-nav" aria-label="Navigation mobile">
      <RouterLink v-for="tab in tabs" :key="tab.to" :to="tab.to" :class="{ active: activeTab(tab.name) }" :aria-current="activeTab(tab.name) ? 'page' : undefined">
        <span class="tab-icon"><component :is="tab.icon" v-if="tab.icon" :size="23" /><svg v-else width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="8" r="4" /><path d="M4 22v-3a8 8 0 0 1 16 0v3" /></svg></span>
        <span>{{ tab.label }}</span>
      </RouterLink>
    </nav>
  </div>
  <Transition name="toast"><div v-if="notice" class="toast-message" role="status">{{ notice }}<button class="icon-button" aria-label="Fermer la notification" @click="notice = ''"><X :size="18" /></button></div></Transition>
</template>
