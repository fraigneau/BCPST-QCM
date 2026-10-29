<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router'
import { ArrowLeft, ArrowRight, Check, Download, FilePlus2, ImagePlus, LoaderCircle, Pencil, Plus, Search, Send, Trash2, X } from '../components/icons'
import QuestionFolders from '../components/QuestionFolders.vue'
import QuestionImport from '../components/QuestionImport.vue'
import type { Chapter, Question, QuestionInput, QuestionStatus, QuestionUsage } from '../../shared/types'
import { api, backendMode, post, refreshSession, session } from '../services/api'
import { notify } from '../services/feedback'
import { filterLibraryQuestions } from '../services/question-library'

const route = useRoute()
const router = useRouter()

const questions = ref<Question[]>([])
const loading = ref(true)
const search = ref('')
const usageFilter = ref<QuestionUsage | 'all'>('all')
const chapterEditor = ref(false)
const editingChapter = ref<string | null>(null)
const chapterNameInput = ref('')
const chapterDescription = ref('')
const savingChapter = ref(false)
const chapterError = ref('')
const statusFilter = ref('all')
const difficultyFilter = ref('all')
const chapterFilter = computed(() => route.query.chapter === 'all' ? 'all' : session.bootstrap?.chapters.some(chapter => chapter.id === route.query.chapter) ? String(route.query.chapter) : 'folders')
const activeChapter = computed(() => session.bootstrap?.chapters.find(chapter => chapter.id === chapterFilter.value))
const browsingFolders = computed(() => chapterFilter.value === 'folders' && !search.value.trim())
const error = ref('')
const busy = ref(false)
const transferBusy = ref(false)
const uploading = ref(false)
const showEditor = ref(false)
const editingId = ref<string | null>(null)
const deleteId = ref<string | null>(null)
const formError = ref('')
const fileInput = ref<HTMLInputElement | null>(null)
const blank = (): QuestionInput => ({ usage: 'solo', sourceQuestionId: null, chapterId: activeChapter.value?.id || session.bootstrap?.chapters[0]?.id || '', difficulty: 'easy', prompt: '', options: ['', '', '', ''], correctAnswers: [], explanation: '', image: null, status: 'draft' })
const form = ref<QuestionInput>(blank())
const allowed = computed(() => session.user?.role === 'admin' || session.user?.role === 'contributor')
const chapters = computed(() => session.bootstrap?.chapters || [])
const statusNames: Record<QuestionStatus, string> = { draft: 'Brouillon', pending: 'À valider', published: 'Publiée', rejected: 'À retravailler' }
const difficultyNames = { easy: 'Facile', medium: 'Intermédiaire', hard: 'Difficile' }
const filters = computed(() => ({ usage: usageFilter.value === 'all' ? undefined : usageFilter.value, chapterId: activeChapter.value?.id, status: statusFilter.value === 'all' ? undefined : statusFilter.value, difficulty: difficultyFilter.value === 'all' ? undefined : difficultyFilter.value, search: search.value }))
const filtered = computed(() => filterLibraryQuestions(questions.value, filters.value))
const sourceQuestions = computed(() => questions.value.filter(question => (question.usage ?? 'solo') === 'solo' && question.chapterId === form.value.chapterId && question.id !== editingId.value))
const pendingCount = computed(() => questions.value.filter(question => question.status === 'pending').length)
const publishedCount = computed(() => questions.value.filter(question => question.status === 'published').length)
watch(() => form.value.usage, usage => { if (usage === 'solo') form.value.sourceQuestionId = null; else if (form.value.correctAnswers.length > 1) form.value.correctAnswers = [] })
watch(() => form.value.chapterId, () => { if (!sourceQuestions.value.some(q => q.id === form.value.sourceQuestionId)) form.value.sourceQuestionId = null })
watch(chapterFilter, () => { usageFilter.value = 'all'; search.value = ''; statusFilter.value = 'all'; difficultyFilter.value = 'all' })
watch(browsingFolders, browsing => { if (browsing) { usageFilter.value = 'all'; statusFilter.value = 'all'; difficultyFilter.value = 'all' } })
function chapterName(id: string) { return chapters.value.find(chapter => chapter.id === id)?.shortName || id }
function canEdit(question: Question) { return session.user?.role === 'admin' || (question.authorId === session.user?.id && question.status !== 'published') }
async function load() {
  loading.value = true
  error.value = ''
  try { questions.value = await api<Question[]>('/questions') }
  catch (cause) { error.value = (cause as Error).message }
  finally { loading.value = false }
}
async function openFolder(chapterId?: string) {
  usageFilter.value = 'all'
  search.value = ''
  statusFilter.value = 'all'
  difficultyFilter.value = 'all'
  await router.push({ path: '/questions', query: chapterId ? { chapter: chapterId } : {} })
  await nextTick()
  document.getElementById('library-title')?.focus()
}
function open(question?: Question) {
  formError.value = ''
  editingId.value = question?.id || null
  form.value = question ? { usage: question.usage ?? 'solo', sourceQuestionId: question.sourceQuestionId ?? null, chapterId: question.chapterId, difficulty: question.difficulty, prompt: question.prompt, options: [...question.options], correctAnswers: [...question.correctAnswers], explanation: question.explanation, image: question.image, status: question.status === 'draft' ? 'draft' : 'pending' } : blank()
  showEditor.value = true
}
function createVariant(question: Question) {
  open()
  form.value = { ...blank(), usage: 'challenge', sourceQuestionId: question.id, chapterId: question.chapterId, difficulty: question.difficulty, prompt: question.prompt, options: [...question.options], explanation: question.explanation, image: question.image }
}
function editChapter(chapter?: Chapter) {
  editingChapter.value = chapter?.id ?? null
  chapterNameInput.value = chapter?.name ?? ''
  chapterDescription.value = chapter?.description ?? ''
  chapterError.value = ''
  chapterEditor.value = true
}
async function saveChapter() {
  if (savingChapter.value) return
  savingChapter.value = true
  chapterError.value = ''
  try {
    const input = { name: chapterNameInput.value.trim(), description: chapterDescription.value.trim() }
    const chapter = editingChapter.value
      ? await api<Chapter>(`/chapters/${editingChapter.value}`, { method: 'PATCH', body: JSON.stringify(input) })
      : await post<Chapter>('/chapters', input)
    await refreshSession()
    chapterEditor.value = false
    await openFolder(chapter.id)
    notify(editingChapter.value ? 'Chapitre renommé.' : 'Chapitre créé.')
  } catch (cause) { chapterError.value = (cause as Error).message }
  finally { savingChapter.value = false }
}
function close() { if (!busy.value && !uploading.value) showEditor.value = false }
function toggleAnswer(index: number) { if (form.value.usage === 'challenge') { form.value.correctAnswers = [index]; return } form.value.correctAnswers = form.value.correctAnswers.includes(index) ? form.value.correctAnswers.filter(answer => answer !== index) : [...form.value.correctAnswers, index] }
async function save(status: 'draft' | 'pending') {
  formError.value = ''
  if (form.value.prompt.trim().length < 10) { formError.value = 'Rédigez un énoncé d’au moins 10 caractères.'; return }
  if (form.value.options.some(option => !option.trim())) { formError.value = 'Renseignez les quatre propositions.'; return }
  if (form.value.usage === 'challenge' && (!form.value.sourceQuestionId || form.value.correctAnswers.length !== 1)) { formError.value = 'Choisis une question solo source et une seule bonne réponse pour le défi.'; return }
  if (!form.value.correctAnswers.length) { formError.value = 'Indiquez au moins une bonne réponse.'; return }
  if (form.value.explanation.trim().length < 10) { formError.value = 'Ajoutez une correction d’au moins 10 caractères.'; return }
  busy.value = true
  try {
    const input = { ...form.value, status }
    if (editingId.value) await api(`/questions/${editingId.value}`, { method: 'PUT', body: JSON.stringify(input) })
    else await post('/questions', input)
    showEditor.value = false
    notify(status === 'draft' ? 'Brouillon enregistré.' : 'Question soumise à la validation.')
    await load()
    await refreshSession()
  } catch (cause) { formError.value = (cause as Error).message }
  finally { busy.value = false }
}
async function remove() {
  if (!deleteId.value) return
  busy.value = true
  try { await api(`/questions/${deleteId.value}`, { method: 'DELETE' }); deleteId.value = null; await load(); notify('Question supprimée.') }
  catch (cause) { error.value = (cause as Error).message }
  finally { busy.value = false }
}
async function uploadImage(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  formError.value = ''
  if (!(backendMode === 'supabase' ? ['image/png', 'image/jpeg', 'image/webp'] : ['image/png', 'image/jpeg', 'image/webp', 'image/gif']).includes(file.type)) { formError.value = 'Choisissez une image PNG, JPEG ou WebP.'; return }
  if (file.size > 2 * 1024 * 1024) { formError.value = 'L’image doit peser moins de 2 Mo.'; return }
  uploading.value = true
  try {
    const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('Impossible de lire cette image.')); reader.readAsDataURL(file) })
    const result = await post<{ url: string }>('/uploads', { dataUrl })
    form.value.image = result.url
  } catch (cause) { formError.value = (cause as Error).message }
  finally { uploading.value = false; input.value = '' }
}
async function exportQuestions() {
  const selection = { ...filters.value }
  transferBusy.value = true
  error.value = ''
  try {
    const data = filterLibraryQuestions(await api<Question[]>('/questions/export'), selection)
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `qcm-bcpst-${selection.chapterId || 'questions'}-${new Date().toISOString().slice(0, 10)}.json`
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    notify(`${data.length} questions exportées.`)
  } catch (cause) { error.value = (cause as Error).message }
  finally { transferBusy.value = false }
}
async function imported() {
  await load()
  try { await refreshSession() } catch (cause) { error.value = (cause as Error).message }
}
let previousFocus: HTMLElement | null = null
let previousOverflow = ''
let previousInert = false
const dialogOpen = computed(() => showEditor.value || !!deleteId.value)
function dismissDialogOnNavigation() {
  if (!dialogOpen.value) return true
  if (!busy.value && !uploading.value) { showEditor.value = false; deleteId.value = null }
  return false
}
onBeforeRouteUpdate(dismissDialogOnNavigation)
onBeforeRouteLeave(dismissDialogOnNavigation)
watch(dialogOpen, async opened => {
  const root = document.getElementById('app')
  if (opened) {
    previousFocus = document.activeElement as HTMLElement | null
    previousOverflow = document.body.style.overflow
    previousInert = root?.inert ?? false
    document.body.style.overflow = 'hidden'
    if (root) root.inert = true
    await nextTick()
    document.querySelector<HTMLElement>('[aria-modal="true"] button:not([disabled]), [aria-modal="true"] input')?.focus()
  } else {
    document.body.style.overflow = previousOverflow
    if (root) root.inert = previousInert
    previousFocus?.focus()
  }
})
function escape(event: KeyboardEvent) {
  if (!dialogOpen.value) return
  if (event.key === 'Escape') { close(); if (!busy.value) deleteId.value = null }
  if (event.key === 'Tab') {
    const items = Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"] button:not([disabled]), [aria-modal="true"] input:not([type="file"]), [aria-modal="true"] select, [aria-modal="true"] textarea'))
    const first = items[0], last = items.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
}
onMounted(() => { if (allowed.value) void load(); window.addEventListener('keydown', escape) })
onBeforeUnmount(() => {
  window.removeEventListener('keydown', escape)
  if (dialogOpen.value) { document.body.style.overflow = previousOverflow; const root = document.getElementById('app'); if (root) root.inert = previousInert }
})
</script>

<template>
  <div v-if="!allowed" class="panel empty-state"><h1>Espace réservé aux contributeurs</h1><p>Votre compte élève vous permet de réviser et de participer aux parties.</p><RouterLink class="button" to="/practice">Réviser</RouterLink></div>
  <div v-else class="editor-page">
    <header class="page-heading"><div><h1>Questions</h1><p class="muted">Tes chapitres, leurs QCM solo et leurs variantes pour les défis.</p></div><div class="chapter-actions"><button v-if="session.user?.role === 'admin'" class="button secondary" @click="editChapter()"><Plus :size="18" />Nouveau chapitre</button><button class="button" :disabled="!chapters.length" @click="open()"><Plus :size="18" />Nouvelle question</button></div></header>
    <form v-if="chapterEditor && session.user?.role === 'admin'" class="panel chapter-form" @submit.prevent="saveChapter">
      <h2>{{ editingChapter ? 'Renommer le chapitre' : 'Nouveau chapitre' }}</h2>
      <label class="field">Nom du chapitre<input v-model="chapterNameInput" class="input" placeholder="Chapitre 1 — Les cellules" minlength="2" maxlength="60" :disabled="savingChapter" required></label>
      <label class="field">Description (facultative)<textarea v-model="chapterDescription" class="input" rows="2" maxlength="1000" :disabled="savingChapter"></textarea></label>
      <p v-if="chapterError" class="form-error" role="alert">{{ chapterError }}</p>
      <div class="chapter-actions"><button class="button" :disabled="savingChapter">{{ savingChapter ? 'Enregistrement…' : 'Enregistrer' }}</button><button type="button" class="button ghost" :disabled="savingChapter" @click="chapterEditor = false">Annuler</button></div>
    </form>
    <div class="editor-stats"><div><span class="stat-icon"><FilePlus2 :size="20" /></span><strong>{{ questions.length }}</strong><p>questions accessibles</p></div><div><span class="stat-icon published-icon"><Check :size="20" /></span><strong>{{ publishedCount }}</strong><p>publiées dans les quiz</p></div><div><span class="stat-icon pending-icon"><Send :size="19" /></span><strong>{{ pendingCount }}</strong><p>en attente de validation</p></div></div>
    <section class="panel library-panel" aria-label="Bibliothèque de questions">
      <div class="library-top">
        <div class="library-location">
          <button v-if="!browsingFolders" class="button ghost folder-back" aria-label="Retour aux chapitres" @click="openFolder()"><ArrowLeft :size="18" />Chapitres</button>
          <h2 id="library-title" tabindex="-1">{{ browsingFolders ? 'Les chapitres' : activeChapter?.name || (chapterFilter === 'folders' ? 'Résultats dans tous les chapitres' : 'Toutes les questions') }}</h2>
          <p class="muted library-description">{{ browsingFolders ? 'Ouvre un chapitre pour gérer ses QCM solo et ses QCS de défi.' : activeChapter ? activeChapter.description : 'Retrouve les questions de toute la bibliothèque.' }}</p>
        </div>
        <div class="transfer-actions">
          <QuestionImport :chapters="chapters" :active-chapter-id="activeChapter?.id" :disabled="transferBusy || loading" @imported="imported" />
          <button class="button ghost" :disabled="transferBusy || loading || !filtered.length" @click="exportQuestions"><Download :size="15" />{{ activeChapter ? 'Exporter ce chapitre' : 'Exporter' }}</button>
          <button v-if="activeChapter && session.user?.role === 'admin'" class="button ghost" @click="editChapter(activeChapter)"><Pencil :size="15" />Renommer</button>
        </div>
      </div>
      <div class="library-filters">
        <div class="search-box"><Search :size="17" /><input v-model="search" :placeholder="activeChapter ? 'Rechercher dans ce chapitre…' : 'Rechercher dans tous les chapitres…'" aria-label="Rechercher une question"><button v-if="search" class="icon-button" aria-label="Effacer la recherche" @click="search = ''"><X :size="17" /></button></div>
        <template v-if="!browsingFolders">
          <select v-model="usageFilter" class="select" aria-label="Filtrer par mode"><option value="all">Solo et défis</option><option value="solo">QCM solo</option><option value="challenge">QCS de défi</option></select>
          <select v-model="statusFilter" class="select" aria-label="Filtrer par statut"><option value="all">Tous les statuts</option><option v-for="(label, key) in statusNames" :key="key" :value="key">{{ label }}</option></select>
          <select v-model="difficultyFilter" class="select" aria-label="Filtrer par difficulté"><option value="all">Tous les niveaux</option><option v-for="(label, key) in difficultyNames" :key="key" :value="key">{{ label }}</option></select>
        </template>
      </div>
      <details class="import-help"><summary>Quel fichier peut-on importer ?</summary><p>Un export JSON de cette application ou un XML Moodle / Pronote compatible Moodle, jusqu’à 500 questions et 5 Mo. L’aperçu permet de choisir les chapitres et signale les questions incompatibles. Les QCM XML doivent avoir quatre propositions ; une illustration PNG, JPEG ou WebP intégrée est acceptée. Les imports restent en brouillon. Pour le JSON, exporte ensemble les sources solo et leurs variantes.</p></details>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <div v-if="loading" class="empty-state"><LoaderCircle :size="24" class="spin" /><p>Chargement de la bibliothèque…</p></div>
      <div v-else-if="error" class="empty-state"><button class="button secondary" @click="load">Réessayer</button></div>
      <template v-else-if="browsingFolders">
        <QuestionFolders :chapters="chapters" :questions="questions" @open="openFolder" />
        <button class="all-questions" @click="openFolder('all')"><span>Voir toutes les questions <small>{{ questions.length }}</small></span><ArrowRight :size="18" /></button>
      </template>
      <div v-else-if="!filtered.length" class="empty-state">
        <FilePlus2 :size="29" /><h3>{{ search || usageFilter !== 'all' || statusFilter !== 'all' || difficultyFilter !== 'all' ? 'Aucune question pour ces filtres.' : activeChapter ? 'Ce chapitre attend sa première question.' : 'La bibliothèque attend sa première question.' }}</h3>
        <p>{{ search || usageFilter !== 'all' || statusFilter !== 'all' || difficultyFilter !== 'all' ? 'Essaie un autre mot ou modifie les filtres.' : activeChapter ? 'Crée une question directement dans ce chapitre.' : 'Crée une question et choisis son chapitre.' }}</p>
        <button class="button secondary" @click="open()">Créer une question</button>
      </div>
      <div v-else class="question-list">
        <article v-for="question in filtered" :key="question.id" class="question-row">
          <div class="question-thumbnail"><img v-if="question.image" :src="question.image" alt=""><ImagePlus v-else :size="19" :stroke-width="1.2" /></div>
          <div class="question-main"><div class="row-labels"><span>{{ chapterName(question.chapterId) }}</span><span>·</span><span>{{ difficultyNames[question.difficulty] }}</span><span class="mode-label">{{ question.usage === 'challenge' ? 'QCS défi' : 'QCM solo' }}</span><span v-if="question.correctAnswers.length > 1" class="multiple-label">Réponses multiples</span></div><h3>{{ question.prompt }}</h3><p v-if="question.sourceQuestionId" class="muted variant-source">Variante de : {{ questions.find(source => source.id === question.sourceQuestionId)?.prompt || 'Question solo' }}</p><p v-if="question.reviewNote" class="review-note">Retour de validation : {{ question.reviewNote }}</p></div>
          <div class="question-status"><span class="status-pill" :class="question.status">{{ statusNames[question.status] }}</span><small>{{ new Date(question.updatedAt).toLocaleDateString('fr-FR') }}</small></div>
          <div class="row-actions"><button v-if="(question.usage ?? 'solo') === 'solo'" class="button ghost variant-action" @click="createVariant(question)"><Plus :size="15" />QCS défi</button><template v-if="canEdit(question)"><button class="icon-button" aria-label="Modifier la question" @click="open(question)"><Pencil :size="16" /></button><button class="icon-button delete-button" aria-label="Supprimer la question" @click="deleteId = question.id"><Trash2 :size="16" /></button></template></div>
        </article>
      </div>
      <div class="library-footer"><span>{{ browsingFolders ? chapters.length + ' chapitres · ' : '' }}{{ browsingFolders ? questions.length : filtered.length }} question{{ (browsingFolders ? questions.length : filtered.length) > 1 ? 's' : '' }}</span><span>Les nouvelles questions sont validées avant publication.</span></div>
    </section>
    <Teleport to="body"><div v-if="showEditor" class="modal-backdrop" @click.self="close"><section class="editor-modal" role="dialog" aria-modal="true" aria-labelledby="editor-title"><header class="modal-header"><div><p class="eyebrow">L’atelier</p><h2 id="editor-title">{{ editingId ? 'Affiner une question' : 'Une nouvelle question' }}</h2></div><button class="icon-button" aria-label="Fermer l’éditeur" :disabled="busy || uploading" @click="close"><X :size="21" /></button></header><form @submit.prevent="save('pending')"><div class="modal-content"><label class="field">Utilisation<select v-model="form.usage" class="select"><option value="solo">QCM solo — comprendre et réviser</option><option value="challenge">QCS défi — réflexes et rapidité</option></select></label><p v-if="form.usage === 'challenge'" class="review-info">Reformule l’énoncé pour une réponse rapide, avec une seule bonne réponse. La variante sera validée séparément.</p><div class="editor-config"><label class="field">Chapitre<select v-model="form.chapterId" class="select" required><option v-for="chapter in chapters" :key="chapter.id" :value="chapter.id">{{ chapter.name }}</option></select></label><label class="field">Difficulté<select v-model="form.difficulty" class="select"><option value="easy">Facile</option><option value="medium">Intermédiaire</option><option value="hard">Difficile</option></select></label></div><label v-if="form.usage === 'challenge'" class="field">Question solo source<select v-model="form.sourceQuestionId" class="select" required><option :value="null" disabled>Choisir dans ce chapitre</option><option v-for="source in sourceQuestions" :key="source.id" :value="source.id">{{ source.prompt }}</option></select></label><label class="field">L’énoncé<textarea v-model="form.prompt" class="input" placeholder="Posez une question claire et précise…" rows="3" minlength="10" maxlength="2000" required></textarea></label><div class="image-field"><input ref="fileInput" class="hidden-input" type="file" :accept="backendMode === 'supabase' ? 'image/png,image/jpeg,image/webp' : 'image/png,image/jpeg,image/webp,image/gif'" @change="uploadImage"><div v-if="form.image" class="image-preview"><img :src="form.image" alt="Illustration de la question"><button type="button" class="icon-button" aria-label="Retirer l’image" @click="form.image = null"><X :size="17" /></button></div><button v-else type="button" class="upload-area" :disabled="uploading" @click="fileInput?.click()"><ImagePlus :size="24" /><span><strong>{{ uploading ? 'Envoi de l’image…' : 'Ajouter une illustration' }}</strong><small>Schéma, graphique, coupe… PNG, JPEG ou WebP · 2 Mo maximum</small></span><Plus :size="18" /></button></div><fieldset class="options-fieldset"><legend>Les quatre propositions <span>{{ form.usage === 'challenge' ? 'Sélectionne une seule bonne réponse.' : 'Sélectionne toutes les bonnes réponses.' }}</span></legend><div v-for="(_, index) in form.options" :key="index" class="option-edit" :class="{ 'is-correct': form.correctAnswers.includes(index) }"><span>{{ String.fromCharCode(65 + index) }}</span><input v-model="form.options[index]" :aria-label="`Proposition ${String.fromCharCode(65 + index)}`" :placeholder="`Proposition ${String.fromCharCode(65 + index)}`" maxlength="500" required><button type="button" class="correct-toggle" :aria-pressed="form.correctAnswers.includes(index)" :aria-label="`Marquer la proposition ${String.fromCharCode(65 + index)} comme correcte`" @click="toggleAnswer(index)"><Check :size="16" /></button></div></fieldset><label class="field explanation-label">La correction pédagogique<textarea v-model="form.explanation" class="input" placeholder="Expliquez pourquoi les réponses sont justes ou fausses. C’est ici que l’on apprend." rows="4" minlength="10" maxlength="5000" required></textarea></label><p v-if="formError" class="form-error" role="alert">{{ formError }}</p><p class="review-info">La question sera visible dans les quiz après validation par l’administrateur.</p></div><footer class="modal-footer"><button type="button" class="button secondary" :disabled="busy || uploading" @click="save('draft')">Brouillon</button><button class="button" :disabled="busy || uploading"><Send :size="17" />{{ busy ? 'Enregistrement…' : 'Soumettre' }}</button></footer></form></section></div><div v-if="deleteId" class="modal-backdrop" @click.self="!busy && (deleteId = null)"><section class="confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="delete-title"><Trash2 :size="27" /><h2 id="delete-title">Supprimer cette question ?</h2><p>Elle disparaîtra de la bibliothèque. Les résultats des séances déjà jouées seront conservés.</p><div><button class="button secondary" :disabled="busy" @click="deleteId = null">Conserver</button><button class="button danger" :disabled="busy" @click="remove">{{ busy ? 'Suppression…' : 'Supprimer' }}</button></div></section></div></Teleport>
  </div>
</template>

<style scoped>

.chapter-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.chapter-form { display: grid; gap: 14px; margin-bottom: 20px; padding: 20px; }
.import-help { margin: 12px 0; font-size: 13px; color: var(--muted); line-height: 1.6; }
.import-help summary { cursor: pointer; }
.variant-source { font-size: 12px; margin-top: 5px; }
.mode-label { color: var(--green); }
.variant-action { font-size: 12px; white-space: nowrap; }
.editor-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-bottom: 24px; }
.editor-stats>div { padding: 14px 10px; background: #fff; border-radius: 14px; border: 1px solid var(--line); }
.editor-stats .stat-icon { display: none; }
.editor-stats strong { font-size: 25px; }
.editor-stats p { font-size: 12px; line-height: 1.5; color: var(--muted); margin-top: 4px; }
.library-panel { padding: 18px 16px; }
.library-top { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; margin-bottom: 16px; }
.library-top h2 { font-size: 19px; }
.library-location { min-width: 0; width: 100%; }
.library-location h2 { overflow-wrap: anywhere; line-height: 1.4; }
.library-description { font-size: 14px; line-height: 1.6; margin-top: 6px; }
.folder-back { padding: 8px 0; margin-bottom: 8px; }
.all-questions { display: flex; justify-content: space-between; align-items: center; gap: 12px; min-height: 56px; width: 100%; padding: 16px 2px; background: none; border: 0; color: var(--green); text-align: left; font-size: 15px; }
.all-questions small { color: var(--muted); margin-left: 6px; }
.transfer-actions { display: flex; gap: 4px; flex-wrap: wrap; max-width: 100%; }
.transfer-actions .button { padding: 10px; min-height: 44px; font-size: 13px; }
.library-filters { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-bottom: 22px; }
.search-box { display: flex; gap: 10px; align-items: center; grid-column: 1/-1; border: 1px solid #cad8ce; padding-inline: 12px; border-radius: 12px; background: #fff; }
.search-box input { min-width: 0; width: 100%; min-height: 48px; border: 0; background: transparent; font-size: 16px; color: var(--ink); }
.search-box:focus-within { outline: 2px solid #538fca; }
.library-filters .select { padding-inline: 10px; font-size: 16px; }
.question-row { display: grid; grid-template-columns: 1fr auto; gap: 12px; padding: 20px 0; border-top: 1px solid var(--line); }
.question-thumbnail { display: none; }
.question-main { grid-column: 1/-1; min-width: 0; }
.row-labels { display: flex; flex-wrap: wrap; gap: 6px; color: var(--muted); font-size: 12px; }
.multiple-label { display: none; }
.question-main h3 { font-size: 16px; font-weight: 620; line-height: 1.5; margin-top: 8px; }
.review-note { margin-top: 8px; font-size: 13px; color: #8c5a26; }
.question-status { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.question-status small { font-size: 12px; color: var(--muted); }
.status-pill { border-radius: 7px; padding: 5px 8px; font-size: 12px; }
.status-pill.draft { background: #edf0ed; color: #5d6f65; }
.status-pill.pending { background: #fff1ce; color: #7c611b; }
.status-pill.published { background: #e3f0e7; color: #316349; }
.status-pill.rejected { background: #fbe8e2; color: #974a36; }
.row-actions { display: flex; }
.delete-button { color: #a95046; }
.library-footer { display: grid; gap: 8px; border-top: 1px solid var(--line); padding-top: 16px; color: var(--muted); font-size: 12px; }
.modal-backdrop { position: fixed; inset: 0; z-index: 90; display: flex; align-items: center; justify-content: center; background: #17382e80; overscroll-behavior: contain; }
.editor-modal { display: flex; flex-direction: column; width: 100%; max-width: 600px; height: 100dvh; background: #fff; }
.modal-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: calc(16px + env(safe-area-inset-top, 0px)) 20px 16px; border-bottom: 1px solid var(--line); }
.modal-header .eyebrow { display: none; }
.modal-header h2 { font-size: 22px; }
.editor-modal>form { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.modal-content { padding: 22px 20px; display: flex; flex-direction: column; gap: 24px; overflow-y: auto; overscroll-behavior: contain; min-height: 0; flex: 1; }
.editor-config { display: grid; grid-template-columns: 1fr; gap: 18px; }
.upload-area { display: flex; width: 100%; align-items: center; gap: 12px; padding: 18px 14px; text-align: left; border: 1px dashed #9cb8a6; border-radius: 14px; background: #f2f7f3; }
.upload-area>span { flex: 1; min-width: 0; }
.upload-area strong { display: block; font-size: 15px; font-weight: 600; }
.upload-area small { display: block; margin-top: 5px; font-size: 12px; color: var(--muted); line-height: 1.6; }
.image-preview { position: relative; background: var(--bg); border-radius: 14px; padding: 14px; }
.image-preview img { max-height: 200px; margin: auto; }
.image-preview .icon-button { position: absolute; right: 4px; top: 4px; background: #fff; border: 1px solid var(--line); }
.options-fieldset { min-width: 0; padding: 0; margin: 0; border: 0; display: flex; flex-direction: column; gap: 10px; }
.options-fieldset legend { font-size: 15px; font-weight: 600; margin-bottom: 14px; }
.options-fieldset legend span { display: block; margin-top: 5px; font-size: 13px; font-weight: 400; color: var(--muted); }
.option-edit { display: flex; align-items: center; gap: 8px; min-height: 58px; padding: 5px 6px 5px 12px; border: 1px solid #cad8ce; border-radius: 12px; }
.option-edit>span { font-size: 13px; font-weight: 650; color: var(--muted); }
.option-edit>input { flex: 1; min-width: 0; width: 100%; border: 0; padding: 9px 0; font-size: 16px; color: var(--ink); background: transparent; }
.correct-toggle { display: grid; place-items: center; width: 44px; height: 44px; border: 1px solid var(--line); background: #f5f7f5; border-radius: 11px; color: #7a8b80; flex-shrink: 0; }
.is-correct { border-color: #438a60; background: #eff7f0; }
.is-correct .correct-toggle { background: var(--green); color: #fff; }
.review-info { font-size: 13px; color: var(--muted); line-height: 1.6; }
.modal-footer { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding: 14px 20px calc(14px + env(safe-area-inset-bottom, 0px)); border-top: 1px solid var(--line); background: #fff; }
.confirm-modal { width: calc(100% - 32px); max-width: 420px; border-radius: 20px; background: #fff; padding: 26px; }
.confirm-modal>svg { color: #a95046; }
.confirm-modal h2 { font-size: 23px; margin-top: 16px; }
.confirm-modal p { margin-top: 14px; color: var(--muted); line-height: 1.6; font-size: 15px; }
.confirm-modal>div { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 24px; }
.spin { animation: spin 1.5s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (min-width: 640px) { .editor-modal { height: min(900px, calc(100dvh - 40px)); border-radius: 20px; overflow: hidden; } .editor-config { grid-template-columns: 1.5fr 1fr; } }

</style>
