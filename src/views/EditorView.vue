<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Check, ChevronDown, Download, FilePlus2, ImagePlus, LoaderCircle, Pencil, Plus, Search, Send, Trash2, Upload, X } from '../components/icons'
import type { Question, QuestionInput, QuestionStatus } from '../../shared/types'
import { api, backendMode, post, session } from '../services/api'
import { notify } from '../services/feedback'

const questions = ref<Question[]>([])
const loading = ref(true)
const search = ref('')
const statusFilter = ref('all')
const chapterFilter = ref('all')
const error = ref('')
const busy = ref(false)
const transferBusy = ref(false)
const uploading = ref(false)
const showEditor = ref(false)
const editingId = ref<string | null>(null)
const deleteId = ref<string | null>(null)
const formError = ref('')
const fileInput = ref<HTMLInputElement | null>(null)
const importInput = ref<HTMLInputElement | null>(null)
const blank = (): QuestionInput => ({ chapterId: session.bootstrap?.chapters[0]?.id || '', difficulty: 'easy', prompt: '', options: ['', '', '', ''], correctAnswers: [], explanation: '', image: null, status: 'draft' })
const form = ref<QuestionInput>(blank())
const allowed = computed(() => session.user?.role === 'admin' || session.user?.role === 'contributor')
const chapters = computed(() => session.bootstrap?.chapters || [])
const statusNames: Record<QuestionStatus, string> = { draft: 'Brouillon', pending: 'À valider', published: 'Publiée', rejected: 'À retravailler' }
const difficultyNames = { easy: 'Facile', medium: 'Intermédiaire', hard: 'Difficile' }
const filtered = computed(() => questions.value.filter(question => (statusFilter.value === 'all' || question.status === statusFilter.value) && (chapterFilter.value === 'all' || question.chapterId === chapterFilter.value) && `${question.prompt} ${question.explanation}`.toLocaleLowerCase('fr').includes(search.value.toLocaleLowerCase('fr'))))
const pendingCount = computed(() => questions.value.filter(question => question.status === 'pending').length)
const publishedCount = computed(() => questions.value.filter(question => question.status === 'published').length)
function chapterName(id: string) { return chapters.value.find(chapter => chapter.id === id)?.shortName || id }
function canEdit(question: Question) { return session.user?.role === 'admin' || (question.authorId === session.user?.id && question.status !== 'published') }
async function load() {
  try { questions.value = await api<Question[]>('/questions') }
  catch (cause) { error.value = (cause as Error).message }
  finally { loading.value = false }
}
function open(question?: Question) {
  formError.value = ''
  editingId.value = question?.id || null
  form.value = question ? { chapterId: question.chapterId, difficulty: question.difficulty, prompt: question.prompt, options: [...question.options], correctAnswers: [...question.correctAnswers], explanation: question.explanation, image: question.image, status: question.status === 'draft' ? 'draft' : 'pending' } : blank()
  showEditor.value = true
}
function close() { if (!busy.value && !uploading.value) showEditor.value = false }
function toggleAnswer(index: number) { form.value.correctAnswers = form.value.correctAnswers.includes(index) ? form.value.correctAnswers.filter(answer => answer !== index) : [...form.value.correctAnswers, index] }
async function save(status: 'draft' | 'pending') {
  formError.value = ''
  if (form.value.prompt.trim().length < 10) { formError.value = 'Rédigez un énoncé d’au moins 10 caractères.'; return }
  if (form.value.options.some(option => !option.trim())) { formError.value = 'Renseignez les quatre propositions.'; return }
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
  transferBusy.value = true
  error.value = ''
  try {
    const data = await api<Question[]>('/questions/export')
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `qcm-bcpst-questions-${new Date().toISOString().slice(0, 10)}.json`
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    notify(`${data.length} questions exportées.`)
  } catch (cause) { error.value = (cause as Error).message }
  finally { transferBusy.value = false }
}
async function importQuestions(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  transferBusy.value = true
  error.value = ''
  try {
    if (file.size > 5 * 1024 * 1024) throw new Error('Le fichier doit peser moins de 5 Mo.')
    const data: unknown = JSON.parse(await file.text())
    if (!Array.isArray(data) || !data.length) throw new Error('Le fichier doit contenir une liste JSON de questions.')
    const payload = data.map(question => ({ chapterId: question.chapterId, difficulty: question.difficulty, prompt: question.prompt, options: question.options, correctAnswers: question.correctAnswers, explanation: question.explanation, image: question.image || null, status: 'draft' }))
    const result = await post<{ imported: number }>('/questions/import', { questions: payload })
    await load()
    notify(`${result.imported} questions importées en brouillon.`)
  } catch (cause) { error.value = cause instanceof SyntaxError ? 'Ce fichier ne contient pas de JSON valide.' : (cause as Error).message }
  finally { transferBusy.value = false; input.value = '' }
}
let previousFocus: HTMLElement | null = null
let previousOverflow = ''
let previousInert = false
const dialogOpen = computed(() => showEditor.value || !!deleteId.value)
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
    <header class="page-heading"><div><h1>Questions</h1><p class="muted">Crée et propose tes QCM.</p></div><button class="button" @click="open()"><Plus :size="18" />Nouvelle question</button></header>
    <div class="editor-stats"><div><span class="stat-icon"><FilePlus2 :size="20" /></span><strong>{{ questions.length }}</strong><p>questions accessibles</p></div><div><span class="stat-icon published-icon"><Check :size="20" /></span><strong>{{ publishedCount }}</strong><p>publiées dans les quiz</p></div><div><span class="stat-icon pending-icon"><Send :size="19" /></span><strong>{{ pendingCount }}</strong><p>en attente de validation</p></div></div>
    <section class="panel library-panel"><div class="library-top"><h2>La bibliothèque</h2><div class="transfer-actions"><input ref="importInput" class="hidden-input" type="file" accept="application/json,.json" @change="importQuestions"><button class="button ghost" :disabled="transferBusy" @click="importInput?.click()"><Upload :size="15" />Importer</button><button class="button ghost" :disabled="transferBusy" @click="exportQuestions"><Download :size="15" />Exporter</button></div></div><div class="library-filters"><div class="search-box"><Search :size="17" /><input v-model="search" placeholder="Rechercher une question…" aria-label="Rechercher une question"></div><select v-model="chapterFilter" class="select" aria-label="Filtrer par chapitre"><option value="all">Tous les chapitres</option><option v-for="chapter in chapters" :key="chapter.id" :value="chapter.id">{{ chapter.shortName }}</option></select><select v-model="statusFilter" class="select" aria-label="Filtrer par statut"><option value="all">Tous les statuts</option><option v-for="(label, key) in statusNames" :key="key" :value="key">{{ label }}</option></select></div><p v-if="error" class="form-error" role="alert">{{ error }}</p><div v-if="loading" class="empty-state"><LoaderCircle :size="24" class="spin" /><p>Chargement de la bibliothèque…</p></div><div v-else-if="!filtered.length" class="empty-state"><FilePlus2 :size="29" /><h3>{{ questions.length ? 'Aucun résultat pour ces filtres.' : 'Votre première question vous attend.' }}</h3><p>{{ questions.length ? 'Essayez un autre mot ou un autre chapitre.' : 'Un énoncé clair, quatre propositions et une correction expliquée.' }}</p><button v-if="!questions.length" class="button secondary" @click="open()">Créer une question</button></div><div v-else class="question-list"><article v-for="question in filtered" :key="question.id" class="question-row"><div class="question-thumbnail"><img v-if="question.image" :src="question.image" alt=""><ImagePlus v-else :size="19" :stroke-width="1.2" /></div><div class="question-main"><div class="row-labels"><span>{{ chapterName(question.chapterId) }}</span><span>·</span><span>{{ difficultyNames[question.difficulty] }}</span><span v-if="question.correctAnswers.length > 1" class="multiple-label">Réponses multiples</span></div><h3>{{ question.prompt }}</h3><p v-if="question.reviewNote" class="review-note">Retour de validation : {{ question.reviewNote }}</p></div><div class="question-status"><span class="status-pill" :class="question.status">{{ statusNames[question.status] }}</span><small>{{ new Date(question.updatedAt).toLocaleDateString('fr-FR') }}</small></div><div v-if="canEdit(question)" class="row-actions"><button class="icon-button" aria-label="Modifier la question" @click="open(question)"><Pencil :size="16" /></button><button class="icon-button delete-button" aria-label="Supprimer la question" @click="deleteId = question.id"><Trash2 :size="16" /></button></div></article></div><div class="library-footer"><span>{{ filtered.length }} question{{ filtered.length > 1 ? 's' : '' }}</span><span>Les nouvelles questions sont validées avant publication.</span></div></section>
    <Teleport to="body"><div v-if="showEditor" class="modal-backdrop" @click.self="close"><section class="editor-modal" role="dialog" aria-modal="true" aria-labelledby="editor-title"><header class="modal-header"><div><p class="eyebrow">L’atelier</p><h2 id="editor-title">{{ editingId ? 'Affiner une question' : 'Une nouvelle question' }}</h2></div><button class="icon-button" aria-label="Fermer l’éditeur" :disabled="busy || uploading" @click="close"><X :size="21" /></button></header><form @submit.prevent="save('pending')"><div class="modal-content"><div class="editor-config"><label class="field">Chapitre<select v-model="form.chapterId" class="select" required><option v-for="chapter in chapters" :key="chapter.id" :value="chapter.id">{{ chapter.name }}</option></select></label><label class="field">Difficulté<select v-model="form.difficulty" class="select"><option value="easy">Facile</option><option value="medium">Intermédiaire</option><option value="hard">Difficile</option></select></label></div><label class="field">L’énoncé<textarea v-model="form.prompt" class="input" placeholder="Posez une question claire et précise…" rows="3" minlength="10" maxlength="2000" required></textarea></label><div class="image-field"><input ref="fileInput" class="hidden-input" type="file" :accept="backendMode === 'supabase' ? 'image/png,image/jpeg,image/webp' : 'image/png,image/jpeg,image/webp,image/gif'" @change="uploadImage"><div v-if="form.image" class="image-preview"><img :src="form.image" alt="Illustration de la question"><button type="button" class="icon-button" aria-label="Retirer l’image" @click="form.image = null"><X :size="17" /></button></div><button v-else type="button" class="upload-area" :disabled="uploading" @click="fileInput?.click()"><ImagePlus :size="24" /><span><strong>{{ uploading ? 'Envoi de l’image…' : 'Ajouter une illustration' }}</strong><small>Schéma, graphique, coupe… PNG, JPEG ou WebP · 2 Mo maximum</small></span><Plus :size="18" /></button></div><fieldset class="options-fieldset"><legend>Les quatre propositions <span>Sélectionnez toutes les bonnes réponses.</span></legend><div v-for="(_, index) in form.options" :key="index" class="option-edit" :class="{ 'is-correct': form.correctAnswers.includes(index) }"><span>{{ String.fromCharCode(65 + index) }}</span><input v-model="form.options[index]" :aria-label="`Proposition ${String.fromCharCode(65 + index)}`" :placeholder="`Proposition ${String.fromCharCode(65 + index)}`" maxlength="500" required><button type="button" class="correct-toggle" :aria-pressed="form.correctAnswers.includes(index)" :aria-label="`Marquer la proposition ${String.fromCharCode(65 + index)} comme correcte`" @click="toggleAnswer(index)"><Check :size="16" /></button></div></fieldset><label class="field explanation-label">La correction pédagogique<textarea v-model="form.explanation" class="input" placeholder="Expliquez pourquoi les réponses sont justes ou fausses. C’est ici que l’on apprend." rows="4" minlength="10" maxlength="5000" required></textarea></label><p v-if="formError" class="form-error" role="alert">{{ formError }}</p><p class="review-info">La question sera visible dans les quiz après validation par l’administrateur.</p></div><footer class="modal-footer"><button type="button" class="button secondary" :disabled="busy || uploading" @click="save('draft')">Brouillon</button><button class="button" :disabled="busy || uploading"><Send :size="17" />{{ busy ? 'Enregistrement…' : 'Soumettre' }}</button></footer></form></section></div><div v-if="deleteId" class="modal-backdrop" @click.self="!busy && (deleteId = null)"><section class="confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="delete-title"><Trash2 :size="27" /><h2 id="delete-title">Supprimer cette question ?</h2><p>Elle disparaîtra de la bibliothèque. Les résultats des séances déjà jouées seront conservés.</p><div><button class="button secondary" :disabled="busy" @click="deleteId = null">Conserver</button><button class="button danger" :disabled="busy" @click="remove">{{ busy ? 'Suppression…' : 'Supprimer' }}</button></div></section></div></Teleport>
  </div>
</template>

<style scoped>

.editor-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-bottom: 24px; }
.editor-stats>div { padding: 14px 10px; background: #fff; border-radius: 14px; border: 1px solid var(--line); }
.editor-stats .stat-icon { display: none; }
.editor-stats strong { font-size: 25px; }
.editor-stats p { font-size: 12px; line-height: 1.5; color: var(--muted); margin-top: 4px; }
.library-panel { padding: 18px 16px; }
.library-top { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; margin-bottom: 16px; }
.library-top h2 { font-size: 19px; }
.transfer-actions { display: flex; gap: 4px; }
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
