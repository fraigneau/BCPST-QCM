<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Leaf, ArrowRight, Eye, EyeOff } from '../components/icons'
import { session, signIn, signUp } from '../services/api'

const register = ref(false)
const name = ref('')
const email = ref('')
const identifier = ref('')
const username = ref('')
const password = ref('')
const showPassword = ref(false)
const busy = ref(false)
const error = ref('')
const confirmation = ref('')
const router = useRouter()
const route = useRoute()
async function submit(demo?: string) {
  if (busy.value || (demo && session.authMode !== 'local')) return
  if (register.value && !demo && !/^[a-z0-9][a-z0-9._-]{2,23}$/.test(username.value.trim().toLowerCase())) {
    error.value = 'Choisis un pseudo de 3 à 24 caractères : lettres sans accent, chiffres, point, tiret ou _. Commence par une lettre ou un chiffre.'
    return
  }
  busy.value = true
  error.value = ''
  confirmation.value = ''
  try {
    if (register.value && !demo) {
      username.value = username.value.trim().toLowerCase()
      const result = await signUp({ name: name.value.trim(), email: email.value.trim(), password: password.value, username: username.value })
      if (result.requiresConfirmation || !session.user) {
        confirmation.value = email.value.trim()
        password.value = ''
        return
      }
    } else await signIn(demo ? `${demo}@herbier.local` : identifier.value.trim(), demo ? 'Herbier2026!' : password.value)
    await router.push(redirectPath())
  } catch (e) { error.value = (e as Error).message }
  finally { busy.value = false }
}
function redirectPath() {
  const candidate = route.query.redirect
  if (typeof candidate !== 'string') return '/'
  try {
    const decoded = decodeURIComponent(candidate)
    if (!candidate.startsWith('/') || !decoded.startsWith('/') || decoded.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(decoded)) return '/'
    return candidate
  } catch { return '/' }
}
function switchMode() {
  if (register.value && email.value) identifier.value = email.value.trim()
  else if (!register.value && identifier.value.includes('@')) email.value = identifier.value.trim()
  register.value = confirmation.value ? false : !register.value
  confirmation.value = ''
  error.value = ''
  password.value = ''
}
</script>

<template>
  <div class="auth-page">
    <header class="auth-intro"><a class="brand" href="/connexion"><span class="brand-mark"><Leaf :size="25" /></span><span class="brand-name">QCM BCPST</span></a><p>Un quiz, un peu chaque jour.</p></header>
    <section class="auth-form-side">
      <div class="auth-form-wrap">
        <span v-if="session.authMode === 'local'" class="badge">Mode démonstration</span>
        <h1>{{ confirmation ? 'Vérifie tes e-mails' : register ? 'Créer mon compte' : 'Content de te retrouver.' }}</h1>
        <p class="muted">{{ confirmation ? 'Confirme ton adresse pour commencer.' : register ? 'Pour réviser en solo et jouer ensemble.' : 'Connecte-toi pour reprendre tes révisions.' }}</p>
        <div v-if="confirmation" class="confirmation-note" role="status">
          <h3>Vérifiez votre boîte mail</h3>
          <p>Si votre inscription est acceptée, un lien de confirmation vous sera envoyé à <strong>{{ confirmation }}</strong>. Consultez aussi vos courriers indésirables.</p>
          <button class="button secondary" @click="switchMode">Retour à la connexion<ArrowRight :size="16" /></button>
        </div>
        <template v-else>
          <form class="stack" :aria-busy="busy" @submit.prevent="submit()">
            <label v-if="register" class="field">Ton nom<input v-model="name" class="input" name="name" autocomplete="name" minlength="2" maxlength="60" :disabled="busy" required placeholder="Camille Laurent" /></label>
            <label v-if="register" class="field">Ton pseudo<input v-model="username" class="input" name="username" type="text" autocomplete="username" autocapitalize="none" :spellcheck="false" minlength="3" maxlength="24" :disabled="busy" aria-describedby="signup-username-help" required placeholder="camille.bcpst" /><small id="signup-username-help" class="username-help">3 à 24 caractères : lettres sans accent, chiffres, point, tiret ou _. Sans espace. Commence par une lettre ou un chiffre.</small></label>
            <label v-if="register" class="field">Adresse e-mail<input v-model="email" class="input" name="email" type="email" autocomplete="email" autocapitalize="none" :spellcheck="false" :disabled="busy" required placeholder="vous@exemple.fr" /></label>
            <label v-else class="field">Pseudo ou adresse e-mail<input v-model="identifier" class="input" name="username" type="text" autocomplete="username" autocapitalize="none" :spellcheck="false" :disabled="busy" required placeholder="camille.bcpst ou vous@exemple.fr" /></label>
            <label class="field">Mot de passe<span class="password-field"><input v-model="password" class="input" name="password" :type="showPassword ? 'text' : 'password'" :autocomplete="register ? 'new-password' : 'current-password'" :minlength="register ? 10 : 1" :disabled="busy" required :placeholder="register ? '10 caractères minimum' : 'Votre mot de passe'" /><button type="button" class="icon-button" :disabled="busy" :aria-label="showPassword ? 'Masquer le mot de passe' : 'Afficher le mot de passe'" @click="showPassword = !showPassword"><component :is="showPassword ? EyeOff : Eye" :size="18" /></button></span></label>
            <p v-if="error" class="form-error" role="alert">{{ error }}</p>
            <button class="button auth-submit" :disabled="busy">{{ busy ? register ? 'Création du compte…' : 'Connexion en cours…' : register ? 'Créer mon compte' : 'Se connecter' }}<ArrowRight :size="18" /></button>
          </form>
          <p class="auth-switch">{{ register ? 'Vous avez déjà un compte ?' : 'Première visite ?' }} <button :disabled="busy" @click="switchMode">{{ register ? 'Se connecter' : 'Créer un compte' }}</button></p>
        </template>
        <details v-if="session.authMode === 'local' && !confirmation" class="demo-access"><summary>Essayer avec un compte de démonstration</summary><div><button :disabled="busy" @click="submit('eleve')">Élève</button><button :disabled="busy" @click="submit('contributeur')">Contributeur</button><button :disabled="busy" @click="submit('admin')">Admin</button></div></details>
      </div>
    </section>
  </div>
</template>

<style scoped>
.auth-page { max-width: 600px; min-height: 100dvh; margin: auto; padding: calc(32px + env(safe-area-inset-top, 0px)) 24px calc(28px + env(safe-area-inset-bottom, 0px)); background: var(--bg); }
.auth-intro { padding-bottom: 36px; }
.auth-intro .brand-name { font-size: 23px; }
.auth-intro .brand-mark { width: 44px; height: 44px; }
.auth-intro>p { color: var(--muted); margin-top: 16px; font-size: 15px; }
.auth-form-wrap { max-width: 410px; margin: auto; }
.auth-form-wrap>.badge { margin-bottom: 16px; }
.auth-form-wrap>h1 { font-size: 30px; max-width: 330px; }
.auth-form-wrap>.muted { margin: 12px 0 26px; font-size: 15px; }
.password-field { position: relative; display: block; }
.password-field .input { padding-right: 52px; }
.password-field .icon-button { position: absolute; right: 4px; top: 3px; }
.auth-submit { width: 100%; min-height: 54px; margin-top: 6px; }
.auth-switch { margin: 18px 0; display: flex; justify-content: center; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 14px; color: var(--muted); }
.auth-switch button { min-height: 44px; padding: 8px 0; background: none; border: 0; font-weight: 650; color: var(--green); }
.demo-access { margin-top: 20px; border-top: 1px solid var(--line); font-size: 13px; color: var(--muted); }
.demo-access summary { min-height: 48px; padding-block: 14px; cursor: pointer; }
.demo-access>div { display: grid; gap: 8px; grid-template-columns: repeat(3, minmax(0, 1fr)); }
.demo-access button { min-height: 48px; padding: 8px; border: 1px solid var(--line); border-radius: 12px; background: #fff; font-size: 13px; }
.confirmation-note { padding: 22px; background: #e9f2eb; border-radius: 16px; }
.confirmation-note p { margin: 14px 0 22px; font-size: 15px; line-height: 1.7; overflow-wrap: anywhere; }
.confirmation-note .button { width: 100%; }
.username-help { font-size: 13px; font-weight: 400; color: var(--muted); line-height: 1.6; }
@media (max-height: 720px) { .auth-page { padding-top: calc(20px + env(safe-area-inset-top, 0px)); } .auth-intro { padding-bottom: 24px; } }
</style>
