<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { Upload, X } from './icons'
import type { Chapter, SchoolYear, Difficulty } from '../../shared/types'
import { chapterLabel, orderedChapters, schoolYears } from '../../shared/curriculum'
import type { QuestionImportPlan } from '../services/question-import'
import { post, sessionGeneration } from '../services/api'
import { RequestError } from '../services/session-service'
import { notify } from '../services/feedback'

const props = defineProps<{ chapters: Chapter[]; activeChapterId?: string; activeSchoolYear?: SchoolYear; disabled?: boolean }>()
const emit = defineEmits<{ imported: [] }>()
const input = ref<HTMLInputElement | null>(null)
const dialog = ref<HTMLDialogElement | null>(null)
const plan = ref<QuestionImportPlan | null>(null)
const filename = ref('')
const selected = ref<number[]>([])
const mapping = ref<Record<string, string>>({})
const schoolYear = ref<SchoolYear>('both')
const difficulty = ref<Difficulty>('medium')
const skippedAccepted = ref(false)
const busy = ref(false)
const progress = ref('')
const error = ref('')
const uncertain = ref(false)
let disposed = false
let generation = 0
const rejected = computed(() => plan.value?.rows.filter(row => row.error).length ?? 0)
const categories = computed(() => [...new Set(plan.value?.rows.filter(row => row.question && !row.error).map(row => row.category) ?? [])])
const selectedRows = computed(() => plan.value?.rows.filter(row => selected.value.includes(row.index)) ?? [])
const ready = computed(() => !!plan.value && selectedRows.value.length > 0 && (!rejected.value || skippedAccepted.value) && !busy.value && !uncertain.value && (plan.value.format !== 'moodle' || selectedRows.value.every(row => props.chapters.some(chapter => chapter.id === mapping.value[row.category]))))
const label = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLocaleLowerCase('fr')
function ensureCurrent() { if (disposed || generation !== sessionGeneration()) throw new Error('La session a changé. Ferme cet aperçu et sélectionne le fichier à nouveau.') }
function close() { if (!busy.value) { dialog.value?.close(); plan.value = null; error.value = '' } }
function toggle(index: number) { selected.value = selected.value.includes(index) ? selected.value.filter(item => item !== index) : [...selected.value, index] }
async function readFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file || busy.value) return
  generation = sessionGeneration()
  busy.value = true
  error.value = ''
  uncertain.value = false
  plan.value = null
  filename.value = file.name
  progress.value = 'Lecture du fichier…'
  if (!dialog.value?.open) dialog.value?.showModal()
  try {
    if (file.size > 5 * 1024 * 1024) throw new Error('Le fichier doit peser moins de 5 Mo.')
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()) }
    catch { throw new Error('Le fichier doit être enregistré en UTF-8. Exporte-le à nouveau depuis son application.') }
    const { parseQuestionImport } = await import('../services/question-import')
    ensureCurrent()
    const result = parseQuestionImport(text, props.chapters)
    plan.value = result
    selected.value = result.rows.filter(row => row.question && !row.error).map(row => row.index)
    skippedAccepted.value = false
    difficulty.value = 'medium'
    schoolYear.value = props.activeSchoolYear ?? 'both'
    mapping.value = Object.fromEntries(categories.value.map(category => {
      const last = category.split('/').filter(Boolean).at(-1) ?? ''
      const matches = props.chapters.filter(chapter => last && (label(chapter.name) === label(last) || label(chapter.shortName) === label(last)))
      return [category, props.activeChapterId ?? (matches.length === 1 ? matches[0]!.id : '')]
    }))
  } catch (cause) { error.value = (cause as Error).message }
  finally {
    busy.value = false
    progress.value = ''
    if (input.value) input.value.value = ''
  }
}
async function confirm() {
  if (!ready.value || !plan.value) return
  busy.value = true
  error.value = ''
  let submitted = false
  try {
    ensureCurrent()
    const { importPayload } = await import('../services/question-import')
    importPayload(plan.value, selected.value, mapping.value, difficulty.value, props.chapters, schoolYear.value)
    const images = selectedRows.value.filter(row => row.imageDataUrl && !row.uploadedImage)
    for (const [index, row] of images.entries()) {
      ensureCurrent()
      progress.value = `Envoi de l’illustration ${index + 1} sur ${images.length}…`
      const result = await post<{ url: string }>('/uploads', { dataUrl: row.imageDataUrl })
      ensureCurrent()
      row.uploadedImage = result.url
    }
    ensureCurrent()
    const questions = importPayload(plan.value, selected.value, mapping.value, difficulty.value, props.chapters, schoolYear.value)
    progress.value = 'Enregistrement des brouillons…'
    submitted = true
    const result = await post<{ imported: number }>('/questions/import', { questions })
    ensureCurrent()
    notify(`${result.imported} questions importées en brouillon.`)
    busy.value = false
    close()
    emit('imported')
  } catch (cause) {
    uncertain.value = submitted && (!(cause instanceof RequestError) || cause.status >= 500)
    error.value = uncertain.value ? 'Le résultat de l’enregistrement est incertain. Ferme cet aperçu et vérifie la bibliothèque avant de relancer un import pour éviter les doublons.' : (cause as Error).message
  } finally { busy.value = false; progress.value = '' }
}
onBeforeRouteLeave(() => { if (busy.value) return false; close(); return true })
onBeforeUnmount(() => { disposed = true })
</script>

<template>
  <input ref="input" type="file" accept="application/json,application/xml,text/xml,.json,.xml" class="import-input" @change="readFile">
  <button class="button ghost" :disabled="disabled || busy || !chapters.length" :title="!chapters.length ? 'Un chapitre doit être créé avant l’import.' : undefined" @click="input?.click()"><Upload :size="15" />{{ busy ? 'Lecture…' : 'Importer JSON / XML' }}</button>
  <Teleport to="body">
    <dialog ref="dialog" class="import-dialog" aria-labelledby="import-title" @cancel.prevent="close">
      <header><div><h2 id="import-title">Vérifier l’import</h2><p class="muted filename">{{ filename }}</p></div><button class="icon-button" aria-label="Fermer l’aperçu d’import" :disabled="busy" @click="close"><X :size="20" /></button></header>
      <div class="import-content">
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        <template v-if="plan">
          <p class="import-summary">{{ selected.length }} question{{ selected.length > 1 ? 's' : '' }} sélectionnée{{ selected.length > 1 ? 's' : '' }} sur {{ plan.rows.length }} · {{ rejected }} incompatible{{ rejected > 1 ? 's' : '' }}</p>
          <p class="muted">Les questions seront enregistrées en brouillon, sans publication automatique.</p>
          <template v-if="plan.format === 'moodle'">
            <p class="import-notice">XML Moodle / Pronote : import en QCM solo. La mise en page est convertie en texte. Le barème du jeu remplace les pondérations d’origine : toutes les bonnes réponses sont exigées, sans points partiels. Les variantes de défi se préparent ensuite depuis les questions solo.</p>
            <label class="field">Année BCPST<select v-model="schoolYear" class="select" :disabled="busy"><option v-for="year in schoolYears" :key="year.value" :value="year.value">{{ year.label }}</option></select></label><label class="field">Niveau à attribuer<select v-model="difficulty" class="select" :disabled="busy"><option value="easy">Facile</option><option value="medium">Intermédiaire</option><option value="hard">Difficile</option></select></label>
            <fieldset class="category-mapping"><legend>Chapitres de destination</legend><label v-for="category in categories" :key="category" class="field">{{ category || 'Sans catégorie dans le fichier' }}<select v-model="mapping[category]" class="select" :disabled="busy" :aria-label="`Chapitre pour ${category || 'Sans catégorie'}`"><option value="" disabled>Choisir un chapitre</option><option v-for="chapter in orderedChapters(chapters)" :key="chapter.id" :value="chapter.id">{{ chapterLabel(chapters, chapter.id) }}</option></select></label></fieldset>
          </template>
          <p v-else class="import-notice">JSON natif : chapitres et liens entre QCM solo et variantes sont conservés. Les illustrations référencées doivent déjà être accessibles dans cette banque.</p>
          <ul class="import-rows">
            <li v-for="row in plan.rows" :key="row.index" :class="{ rejected: row.error }">
              <div class="row-heading"><input type="checkbox" :checked="selected.includes(row.index)" :disabled="busy || !!row.error" :aria-label="`Importer la question ${row.index}`" @change="toggle(row.index)"><strong>{{ row.index }}. {{ row.title }}</strong></div>
              <p v-if="row.category" class="muted">{{ row.category }}</p>
              <p v-if="row.error" class="row-error">{{ row.error }}</p>
              <ul v-if="row.warnings.length" class="row-warnings"><li v-for="warning in row.warnings" :key="warning">{{ warning }}</li></ul>
              <details v-if="row.question && !row.error"><summary>Voir la question et les réponses</summary><p class="question-text">{{ row.question.prompt }}</p><img v-if="row.imageDataUrl" :src="row.imageDataUrl" alt="Illustration intégrée à importer" class="import-image"><ol type="A"><li v-for="(option, index) in row.question.options" :key="index">{{ option }}<strong v-if="row.question.correctAnswers.includes(index)"> — Bonne réponse</strong></li></ol><p class="question-text">{{ row.question.explanation }}</p></details>
            </li>
          </ul>
          <label v-if="rejected" class="skip-confirm"><input v-model="skippedAccepted" type="checkbox" :disabled="busy">Importer ma sélection en laissant de côté les {{ rejected }} question{{ rejected > 1 ? 's' : '' }} incompatible{{ rejected > 1 ? 's' : '' }}.</label>
          <p v-if="!selected.length" role="status">Aucune question sélectionnée. Consulte les motifs ci-dessus ou choisis un autre fichier.</p>
        </template>
        <p v-if="busy" role="status">{{ progress }}</p>
      </div>
      <footer><button class="button secondary" :disabled="busy" @click="close">{{ plan ? 'Annuler' : 'Fermer' }}</button><button v-if="plan" class="button" :disabled="!ready" @click="confirm">{{ busy ? 'Import en cours…' : `Importer ${selected.length} brouillon${selected.length > 1 ? 's' : ''}` }}</button></footer>
    </dialog>
  </Teleport>
</template>

<style scoped>
.import-input { display: none; }
.import-dialog { width: min(720px, calc(100vw - 24px)); max-height: calc(100dvh - 32px); margin: auto; padding: 0; border: 1px solid var(--line); border-radius: 18px; color: var(--ink); background: #fff; }
.import-dialog[open] { display: flex; flex-direction: column; }
.import-dialog::backdrop { background: #17382e80; }
header, footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 18px; flex-shrink: 0; }
header { border-bottom: 1px solid var(--line); } footer { border-top: 1px solid var(--line); }
h2 { font-size: 21px; } .filename { font-size: 13px; overflow-wrap: anywhere; }
.import-content { padding: 18px; overflow-y: auto; display: grid; gap: 16px; min-height: 0; font-size: 14px; line-height: 1.6; }
.import-summary { font-weight: 650; } .import-notice { padding: 12px; border-radius: 10px; background: #edf5ef; }
.category-mapping { border: 0; padding: 0; margin: 0; display: grid; gap: 12px; min-width: 0; }
.category-mapping legend { font-weight: 600; margin-bottom: 8px; }
.field, .select { min-width: 0; max-width: 100%; } .field { overflow-wrap: anywhere; }
.import-rows { list-style: none; padding: 0; margin: 0; } .import-rows>li { padding: 16px 0; border-top: 1px solid var(--line); overflow-wrap: anywhere; }
.row-heading { display: flex; gap: 10px; align-items: flex-start; } input[type=checkbox] { margin-top: 5px; flex-shrink: 0; width: 18px; height: 18px; }
.row-error { color: #974a36; } .row-warnings { color: #77551b; padding-left: 20px; }
summary { cursor: pointer; color: var(--green); padding: 8px 0; } details ol { padding-left: 24px; }
.question-text { white-space: pre-wrap; margin: 8px 0; } .import-image { display: block; max-width: 100%; max-height: 200px; object-fit: contain; }
.skip-confirm { display: flex; gap: 10px; align-items: flex-start; }
@media(max-width: 440px) { footer { flex-wrap: wrap; } footer .button { flex: 1; } }
</style>
