import { createApp, watch } from 'vue'
import App from './App.vue'
import { router } from './router'
import './style.css'
import { refreshSession, session } from './services/api'

watch(() => session.user, (user, previous) => {
  if (previous && user?.id !== previous.id) void router.replace('/connexion')
  if (user && router.currentRoute.value.name === 'login') void router.replace('/')
  const roles = router.currentRoute.value.meta.roles as string[] | undefined
  if (user && roles && !roles.includes(user.role)) void router.replace('/')
})

window.addEventListener('focus', () => { if (!session.loading && session.authMode === 'supabase') void refreshSession() })

createApp(App).use(router).mount('#app')
