<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Check, CheckCheck, ChevronDown, Clock3, FileCheck2, LoaderCircle, Search, ShieldCheck, Users, X } from '../components/icons'
import type { Question, Role, User } from '../../shared/types'
import { api, backendMode, post, refreshSession, session } from '../services/api'
import { notify } from '../services/feedback'

const users = ref<User[]>([])
const questions = ref<Question[]>([])
const tab = ref<'review' | 'users'>('review')
const loading = ref(true)
const busy = ref('')
const error = ref('')
const search = ref('')
const roleFilter = ref('all')
const expanded = ref<string | null>(null)
const reviewNotes = ref<Record<string, string>>({})
const rejecting = ref<string | null>(null)
const roleNames: Record<Role, string> = { admin: 'Administrateur', contributor: 'Contributeur', student: 'Élève' }
const pending = computed(() => questions.value.filter(question => question.status === 'pending'))
const filteredUsers = computed(() => users.value.filter(user => (roleFilter.value === 'all' || user.role === roleFilter.value) && `${user.name} ${user.email}`.toLocaleLowerCase('fr').includes(search.value.toLocaleLowerCase('fr'))))
const allowed = computed(() => session.user?.role === 'admin')
const canManageRoles = computed(() => backendMode === 'supabase' || session.authMode === 'local')
function author(id: string) { return users.value.find(user => user.id === id)?.name || 'Contributeur' }
function chapterName(id: string) { return session.bootstrap?.chapters.find(chapter => chapter.id === id)?.shortName || id }
async function load() {
  const results = await Promise.allSettled([api<User[]>('/users'), api<Question[]>('/questions')])
  if (results[0].status === 'fulfilled') users.value = results[0].value
  else error.value = results[0].reason.message
  if (results[1].status === 'fulfilled') questions.value = results[1].value
  else error.value = results[1].reason.message
  loading.value = false
}
async function review(question: Question, status: 'published' | 'rejected') {
  if (status === 'rejected' && !reviewNotes.value[question.id]?.trim()) { error.value = 'Ajoutez un retour pour aider le contributeur à améliorer sa question.'; return }
  busy.value = question.id
  error.value = ''
  try {
    await post(`/questions/${question.id}/review`, { status, reviewNote: reviewNotes.value[question.id] || '' })
    notify(status === 'published' ? 'Question validée et publiée dans les quiz.' : 'Question renvoyée au contributeur avec votre retour.')
    rejecting.value = null
    await load()
    await refreshSession()
  } catch (cause) { error.value = (cause as Error).message }
  finally { busy.value = '' }
}
async function changeRole(user: User, event: Event) {
  if (!canManageRoles.value) return
  const select = event.target as HTMLSelectElement
  const nextRole = select.value as Role
  if (nextRole === user.role) return
  busy.value = user.id
  error.value = ''
  try {
    await api(`/users/${user.id}`, { method: 'PATCH', body: JSON.stringify({ role: nextRole }) })
    user.role = nextRole
    notify(`Le rôle de ${user.name} a été mis à jour.`)
    if (user.id === session.user?.id) await refreshSession()
  } catch (cause) { select.value = user.role; error.value = (cause as Error).message }
  finally { busy.value = '' }
}
onMounted(() => { if (allowed.value) void load() })
</script>

<template>
  <div v-if="!allowed" class="panel empty-state"><ShieldCheck :size="32" /><h1>Espace d’administration</h1><p>Cette page est accessible uniquement à l’administrateur.</p><RouterLink class="button" to="/">Retour à l’accueil</RouterLink></div>
  <div v-else>
    <header class="page-heading"><div><h1>Administration</h1><p class="muted">Valide les questions et retrouve les membres.</p></div><span class="admin-label"><ShieldCheck :size="16" />Administration</span></header>
    <div class="admin-stats"><div><span class="stat-icon amber"><FileCheck2 :size="22" /></span><div><strong>{{ pending.length }}</strong><p>questions à valider</p></div></div><div><span class="stat-icon"><Users :size="22" /></span><div><strong>{{ users.length }}</strong><p>membres de la communauté</p></div></div><div><span class="stat-icon olive"><CheckCheck :size="22" /></span><div><strong>{{ questions.filter(question => question.status === 'published').length }}</strong><p>questions publiées</p></div></div></div>
    <div class="admin-tabs" role="tablist" aria-label="Administration"><button id="review-tab" role="tab" :aria-selected="tab === 'review'" aria-controls="review-panel" :class="{ active: tab === 'review' }" @click="tab = 'review'"><FileCheck2 :size="17" />Validation des questions<span v-if="pending.length">{{ pending.length }}</span></button><button id="users-tab" role="tab" :aria-selected="tab === 'users'" aria-controls="users-panel" :class="{ active: tab === 'users' }" @click="tab = 'users'"><Users :size="17" />Utilisateurs</button></div>
    <p v-if="!canManageRoles" class="cloud-roles-note">Les rôles se gèrent dans Supabase pendant cette étape.</p>
    <p v-if="error" class="form-error admin-error" role="alert">{{ error }}</p>
    <div v-if="loading" class="panel empty-state"><LoaderCircle class="spin" :size="26" /><p>Chargement de l’espace d’administration…</p></div>
    <section v-else-if="tab === 'review'" id="review-panel" role="tabpanel" aria-labelledby="review-tab"><div v-if="!pending.length" class="panel review-empty"><span><CheckCheck :size="32" /></span><p class="eyebrow">Tout est à jour</p><h2>La bibliothèque est entre de bonnes mains.</h2><p>Aucune question en attente. Les prochaines contributions apparaîtront ici.</p><RouterLink class="button secondary" to="/questions">Explorer la bibliothèque</RouterLink></div><article v-for="question in pending" :key="question.id" class="panel review-card"><header><div><div class="review-metadata"><span>{{ chapterName(question.chapterId) }}</span><span>·</span><span>{{ { easy: 'Facile', medium: 'Intermédiaire', hard: 'Difficile' }[question.difficulty] }}</span><span class="status-pending"><Clock3 :size="11" />À valider</span></div><h2>{{ question.prompt }}</h2><p class="author-line">Proposée par <strong>{{ author(question.authorId) }}</strong> · {{ new Date(question.updatedAt).toLocaleDateString('fr-FR') }}</p></div></header><button class="preview-toggle" :aria-expanded="expanded === question.id" @click="expanded = expanded === question.id ? null : question.id">{{ expanded === question.id ? 'Réduire la question' : 'Examiner les réponses et la correction' }}<ChevronDown :size="15" :class="{ rotated: expanded === question.id }" /></button><div v-if="expanded === question.id" class="review-content"><img v-if="question.image" :src="question.image" class="review-image" alt="Illustration proposée pour la question"><div class="review-answers"><div v-for="(option, index) in question.options" :key="index" :class="{ correct: question.correctAnswers.includes(index) }"><span>{{ String.fromCharCode(65 + index) }}</span><p>{{ option }}</p><Check v-if="question.correctAnswers.includes(index)" :size="16" /></div></div><div class="review-explanation"><span class="eyebrow">Correction pédagogique</span><p>{{ question.explanation }}</p></div></div><div v-if="rejecting === question.id" class="return-form"><label class="field" :for="`review-note-${question.id}`">Votre retour au contributeur<textarea :id="`review-note-${question.id}`" v-model="reviewNotes[question.id]" class="input" rows="3" placeholder="Précisez ce qui doit être corrigé ou complété…" maxlength="1000"></textarea></label><div><button class="button ghost" :disabled="!!busy" @click="rejecting = null">Annuler</button><button class="button secondary" :disabled="!!busy" @click="review(question, 'rejected')">{{ busy === question.id ? 'Envoi…' : 'Renvoyer pour modification' }}</button></div></div><footer v-else class="review-footer"><p>Une validation rend cette question accessible à tous les joueurs.</p><div><button class="button ghost return-button" :disabled="!!busy" @click="rejecting = question.id">Demander une modification</button><button class="button" :disabled="!!busy" @click="review(question, 'published')"><Check :size="17" />{{ busy === question.id ? 'Publication…' : 'Valider et publier' }}</button></div></footer></article></section>
    <section v-else id="users-panel" class="panel users-panel" role="tabpanel" aria-labelledby="users-tab"><div class="users-heading"><h2>Les membres</h2><span class="badge">{{ users.length }} comptes</span></div><div class="user-filters"><div class="search-box"><Search :size="17" /><input v-model="search" aria-label="Rechercher un membre" placeholder="Rechercher un nom ou un e-mail…"></div><select v-model="roleFilter" class="select" aria-label="Filtrer par rôle"><option value="all">Tous les rôles</option><option v-for="(name, role) in roleNames" :key="role" :value="role">{{ name }}</option></select></div><div class="user-list"><div v-for="user in filteredUsers" :key="user.id" class="user-row"><span class="user-avatar" :class="user.role">{{ user.name[0]?.toUpperCase() }}</span><div class="user-name"><strong>{{ user.name }} <small v-if="user.id === session.user?.id">Vous</small></strong><span>{{ user.email }}</span></div><span class="user-date">Depuis le {{ new Date(user.createdAt).toLocaleDateString('fr-FR') }}</span><select v-if="canManageRoles" class="select role-select" :value="user.role" :disabled="!!busy" :aria-label="`Rôle de ${user.name}`" @change="changeRole(user, $event)"><option v-for="(name, role) in roleNames" :key="role" :value="role">{{ name }}</option></select><span v-else class="badge role-readonly">{{ roleNames[user.role] }}</span></div><div v-if="!filteredUsers.length" class="empty-state"><p>Aucun membre ne correspond à votre recherche.</p></div></div><div class="permissions-note"><ShieldCheck :size="19" /><p>Les élèves jouent, les contributeurs proposent, les administrateurs valident. Les droits sont contrôlés par le serveur à chaque action.</p></div></section>
  </div>
</template>

<style scoped>

.admin-label { display: none; }
.admin-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-bottom: 22px; }
.admin-stats>div { padding: 14px 10px; background: #fff; border: 1px solid var(--line); border-radius: 14px; }
.admin-stats .stat-icon { display: none; }
.admin-stats strong { font-size: 25px; }
.admin-stats p { margin-top: 4px; font-size: 12px; color: var(--muted); line-height: 1.5; }
.admin-tabs { display: grid; grid-template-columns: 1.3fr 1fr; gap: 6px; padding: 5px; background: #e6ede7; border-radius: 14px; margin-bottom: 20px; }
.admin-tabs button { min-height: 54px; display: flex; justify-content: center; align-items: center; gap: 6px; padding: 10px 8px; border: 0; border-radius: 10px; background: transparent; font-size: 14px; font-weight: 600; }
.admin-tabs button.active { background: #fff; color: var(--green); }
.admin-tabs button>svg { display: none; }
.cloud-roles-note, .permissions-note { color: var(--muted); font-size: 13px; line-height: 1.6; margin: 16px 0; }
.admin-error { margin-bottom: 16px; }
.review-empty { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 16px; padding: 30px 22px; }
.review-empty .eyebrow { display: none; }
.review-empty>span { color: var(--green); }
.review-empty h2 { font-size: 22px; }
.review-empty>p { font-size: 15px; color: var(--muted); line-height: 1.6; }
.review-card { margin-bottom: 16px; padding: 20px; }
.review-metadata { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; color: var(--muted); font-size: 12px; }
.status-pending { display: inline-flex; align-items: center; gap: 4px; background: #fff1ce; color: #7c611b; padding: 4px 7px; border-radius: 6px; }
.review-card h2 { font-size: 18px; line-height: 1.5; margin-top: 12px; }
.author-line { color: var(--muted); margin-top: 9px; font-size: 13px; line-height: 1.5; }
.preview-toggle { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 52px; width: 100%; margin-top: 14px; padding: 10px 0; text-align: left; font-size: 14px; color: var(--green); background: none; border: 0; }
.rotated { transform: rotate(180deg); }
.review-image { max-height: 230px; margin: 16px auto; border-radius: 12px; }
.review-answers { display: grid; gap: 10px; }
.review-answers>div { display: flex; align-items: center; gap: 10px; border: 1px solid var(--line); border-radius: 12px; padding: 12px; font-size: 15px; }
.review-answers>div>span { color: var(--muted); }
.review-answers p { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.review-answers .correct { background: #edf6ee; border-color: #b8d6bd; }
.review-explanation { padding: 18px 0; font-size: 15px; line-height: 1.7; white-space: pre-line; }
.review-footer { border-top: 1px solid var(--line); padding-top: 16px; margin-top: 10px; }
.review-footer p { font-size: 13px; color: var(--muted); line-height: 1.6; }
.review-footer>div, .return-form>div { display: flex; flex-direction: column-reverse; gap: 8px; margin-top: 16px; }
.review-footer .button { width: 100%; }
.return-form { padding-top: 16px; }
.users-panel { padding: 18px 16px; }
.users-heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 18px; }
.user-filters { display: grid; gap: 10px; margin-bottom: 14px; }
.search-box { display: flex; align-items: center; gap: 10px; padding-inline: 12px; border: 1px solid #cad8ce; border-radius: 12px; }
.search-box input { min-width: 0; width: 100%; min-height: 50px; background: transparent; border: 0; font-size: 16px; color: var(--ink); }
.user-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 18px 0; border-top: 1px solid var(--line); }
.user-avatar { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; background: #e9f1e9; color: var(--green); font-size: 14px; }
.user-name { flex: 1; min-width: 0; }
.user-name strong { font-size: 15px; font-weight: 650; }
.user-name p, .user-name span, .user-name small { display: block; font-size: 13px; color: var(--muted); overflow-wrap: anywhere; }
.user-date { display: none; }
.role-select, .role-readonly { font-size: 14px; margin-left: 50px; }
.role-select { min-height: 46px; width: calc(100% - 50px); border: 1px solid var(--line); border-radius: 10px; padding: 10px; color: var(--ink); background: #fff; font-size: 16px; }
.role-readonly { color: var(--muted); }
.spin { animation: spin 1.5s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

</style>
