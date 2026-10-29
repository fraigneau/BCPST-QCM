<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowRight, Check, Leaf, RotateCcw } from '../components/icons'
import ChapterIcon from '../components/ChapterIcon.vue'
import { chapterLabel, orderedChapters, selectedChapterIds, chapterCount } from '../../shared/curriculum'
import type { SchoolYearFilter, Difficulty, GameState } from '../../shared/types'
import { api, post, session } from '../services/api'

const router = useRouter()
const route = useRoute()
const selected = ref<string[]>(route.query.chapter ? [String(route.query.chapter)] : [])
const schoolYear = ref<SchoolYearFilter>('all')
const difficulty = ref<Difficulty | 'all'>('all')
const count = ref(10)
const mistakesOnly = ref(route.query.mistakes === 'true' || route.query.mistakes === '1')
const busy = ref(false)
const error = ref('')
const resumable = ref<GameState | null>(null)
const chapters = computed(() => session.bootstrap?.chapters || [])
const chapterChoices = computed(() => orderedChapters(chapters.value))
const yearCounts = computed(() => schoolYear.value === 'all' ? (session.bootstrap?.counts ?? {}) : (session.bootstrap?.countsByYear?.[schoolYear.value] ?? {}))
const available = computed(() => selectedChapterIds(chapters.value, selected.value).reduce((total, id) => total + (yearCounts.value[id] ?? 0), 0))
const levels: { value: Difficulty | 'all'; label: string }[] = [{ value: 'all', label: 'Tous les niveaux' }, { value: 'easy', label: 'Facile' }, { value: 'medium', label: 'Intermédiaire' }, { value: 'hard', label: 'Difficile' }]
const selectionLabel = computed(() => selected.value.length ? `${selected.value.length} chapitre${selected.value.length > 1 ? 's' : ''}` : 'Tous les chapitres')

function toggle(id: string) {
  selected.value = selected.value.includes(id) ? selected.value.filter(value => value !== id) : [...selected.value, id]
}
async function start() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const game = await post<GameState>('/games/solo', { schoolYear: schoolYear.value, chapterIds: selected.value, difficulty: difficulty.value, count: count.value, mistakesOnly: mistakesOnly.value })
    sessionStorage.setItem('herbier-active-game', game.id)
    await router.push(`/game/${game.id}`)
  } catch (cause) { error.value = (cause as Error).message }
  finally { busy.value = false }
}
onMounted(async () => {
  const activeId = sessionStorage.getItem('herbier-active-game')
  if (!activeId) return
  try {
    const state = await api<GameState>(`/games/${activeId}`)
    if (state.mode === 'solo' && state.status !== 'finished') resumable.value = state
    else if (state.status === 'finished' && sessionStorage.getItem('herbier-active-game') === activeId) sessionStorage.removeItem('herbier-active-game')
  } catch {
    if (sessionStorage.getItem('herbier-active-game') === activeId) sessionStorage.removeItem('herbier-active-game')
  }
})
</script>

<template>
  <div class="mobile-practice">
    <header class="practice-heading"><h1>Révision solo</h1><p>Des QCM pour comprendre le chapitre. Prenez votre temps.</p><span class="practice-untimed"><Leaf :size="16" />Sans chrono</span></header>

    <RouterLink v-if="resumable" class="practice-resume" :to="`/game/${resumable.id}`"><RotateCcw :size="22" /><span><strong>Reprendre ma révision</strong><small>Question {{ resumable.questionIndex + 1 }} sur {{ resumable.totalQuestions }}</small></span><ArrowRight :size="20" /></RouterLink>

    <form id="solo-setup" class="practice-form" @submit.prevent="start">
      <fieldset class="practice-block"><legend>Année BCPST</legend><select v-model="schoolYear" class="select" aria-label="Année BCPST" :disabled="busy"><option value="all">Toutes les années</option><option value="BCPST1">BCPST1</option><option value="BCPST2">BCPST2</option></select><p class="muted">Les questions communes sont incluses dans chaque année.</p></fieldset>
      <fieldset class="practice-block chapter-picker">
        <legend>Les chapitres</legend>
        <button class="all-chapters" :class="{ chosen: !selected.length }" :aria-pressed="!selected.length" type="button" :disabled="busy" @click="selected = []"><span>Tous les chapitres</span><Check v-if="!selected.length" :size="19" /><span v-else class="selection-ring"></span></button>
        <div class="practice-chapter-grid">
          <button v-for="chapter in chapterChoices" :key="chapter.id" class="practice-chapter" :class="{ chosen: selected.includes(chapter.id) }" :aria-pressed="selected.includes(chapter.id)" type="button" :disabled="busy" @click="toggle(chapter.id)">
            <span class="chapter-button-top"><span class="chapter-icon" :style="{ color: chapter.color }"><ChapterIcon :id="chapter.id" :size="25" /></span><span class="selection-ring"><Check v-if="selected.includes(chapter.id)" :size="13" /></span></span>
            <strong>{{ chapterLabel(chapters, chapter.id) }}</strong><small>{{ chapterCount(chapters, yearCounts, chapter.id) }} questions</small>
          </button>
        </div>
      </fieldset>

      <fieldset class="practice-block difficulty-picker"><legend>Difficulté</legend><div class="difficulty-segments"><label v-for="level in levels" :key="level.value"><input v-model="difficulty" type="radio" name="difficulty" :value="level.value" :disabled="busy"><span>{{ level.label }}</span></label></div></fieldset>

      <fieldset class="practice-block count-picker"><legend>Nombre de questions</legend><div class="count-segments"><label v-for="value in [5, 10, 15]" :key="value"><input v-model="count" type="radio" name="count" :value="value" :disabled="busy"><span>{{ value }}</span></label></div></fieldset>

      <label class="practice-errors"><span class="errors-symbol"><RotateCcw :size="21" /></span><span class="errors-copy"><strong>Revoir mes erreurs</strong><small>Seulement les notions à retravailler.</small></span><input v-model="mistakesOnly" type="checkbox" :disabled="busy"><span class="errors-switch" aria-hidden="true"></span></label>

      <div class="practice-summary"><p><strong>{{ selectionLabel }}</strong><span>Jusqu’à {{ count }} questions</span></p><p>100 points par bonne réponse. Une correction expliquée après chaque question.</p></div>
      <p v-if="error" class="practice-error" role="alert">{{ error }}</p>
      <p v-if="!available && !mistakesOnly" class="practice-error" role="status">Aucune question disponible dans ces chapitres. Choisissez un autre thème.</p>

      <div class="practice-launch"><div><span>{{ mistakesOnly ? 'Révision de mes erreurs' : selectionLabel }}</span><strong>{{ count }} questions · Sans chrono</strong></div><button type="submit" :disabled="busy || (!mistakesOnly && !available)">{{ busy ? 'Préparation…' : 'Commencer' }}<ArrowRight :size="20" /></button></div>
    </form>
  </div>
</template>

<style scoped>
.mobile-practice{color:#17382e;font-size:16px;padding-bottom:142px}.practice-heading{margin:4px 0 25px}.practice-heading h1{font-size:27px;font-weight:700;letter-spacing:-.65px;line-height:1.25}.practice-heading>p{font-size:15px;color:#687e73;line-height:1.6;margin-top:8px}.practice-untimed{display:inline-flex;align-items:center;gap:6px;background:#e5efe7;color:#21664b;border-radius:7px;padding:6px 9px;font-size:13px;font-weight:550;margin-top:12px}.practice-resume{display:flex;align-items:center;gap:12px;background:#eaf2ec;border:1px solid #cbded0;padding:15px;border-radius:13px;margin-bottom:24px;color:#21664b;min-height:76px}.practice-resume>span{flex:1;min-width:0}.practice-resume strong{display:block;font-size:15px;line-height:1.4;font-weight:650}.practice-resume small{display:block;font-size:13px;color:#647e6e;margin-top:4px;line-height:1.4}.practice-resume>svg{flex-shrink:0}.practice-form{display:grid;gap:25px}.practice-block{border:0;padding:0;margin:0;min-width:0}.practice-block legend{font-size:17px;line-height:1.4;font-weight:650;letter-spacing:-.25px;margin-bottom:13px;padding:0}.all-chapters{display:flex;align-items:center;justify-content:space-between;width:100%;background:#fff;border:1px solid #dfe8e2;border-radius:12px;padding:13px 15px;min-height:50px;font-size:15px;font-weight:550;color:#496459;margin-bottom:10px;text-align:left}.all-chapters.chosen{border-color:#21664b;color:#21664b;background:#ebf3ed}.selection-ring{width:19px;height:19px;border:1px solid #cbd8cf;border-radius:50%;display:grid;place-items:center;flex-shrink:0}.practice-chapter-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.practice-chapter{display:flex;flex-direction:column;align-items:stretch;padding:14px;border:1px solid #dfe8e2;background:#fff;border-radius:13px;text-align:left;min-height:139px;min-width:0;color:#17382e}.chapter-button-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;gap:12px}.chapter-icon{display:grid;place-items:center;width:29px;height:29px}.practice-chapter strong{font-size:14px;line-height:1.4;font-weight:600;overflow-wrap:anywhere;margin-top:auto}.practice-chapter small{font-size:13px;color:#71847a;margin-top:5px;line-height:1.4}.practice-chapter.chosen{border-color:#21664b;background:#edf5ef;box-shadow:inset 0 0 0 1px #21664b}.chosen .selection-ring{background:#21664b;color:white;border-color:#21664b}.difficulty-segments{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.difficulty-segments label,.count-segments label{position:relative;display:block;cursor:pointer;min-width:0}.difficulty-segments input,.count-segments input{position:absolute;inset:0;opacity:0;width:100%;height:100%;margin:0;cursor:pointer}.difficulty-segments span,.count-segments span{display:grid;place-items:center;border:1px solid #dfe8e2;background:#fff;min-height:49px;padding:12px 9px;border-radius:10px;color:#5f7569;font-size:14px;font-weight:500;text-align:center;line-height:1.4}.difficulty-segments input:checked+span,.count-segments input:checked+span{border-color:#21664b;background:#eaf2ec;box-shadow:inset 0 0 0 1px #21664b;color:#21664b;font-weight:650}.difficulty-segments input:focus-visible+span,.count-segments input:focus-visible+span{outline:3px solid #87ac96;outline-offset:3px}.difficulty-segments input:disabled+span,.count-segments input:disabled+span{opacity:.6;cursor:wait}.count-segments{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px}.count-segments span{font-size:17px;min-height:51px;font-variant-numeric:tabular-nums}.practice-errors{display:flex;align-items:center;gap:11px;padding:17px 14px;border:1px solid #dfe8e2;background:#fff;border-radius:13px;position:relative;cursor:pointer}.errors-symbol{display:grid;place-items:center;flex-shrink:0;width:31px;height:36px;color:#6f8a78}.errors-copy{flex:1;min-width:0}.errors-copy strong{display:block;font-size:15px;line-height:1.4;font-weight:600}.errors-copy small{display:block;font-size:13px;color:#71847a;margin-top:5px;line-height:1.5}.practice-errors>input{position:absolute;width:45px;height:29px;right:14px;opacity:0;margin:0;cursor:pointer}.errors-switch{width:43px;height:26px;border-radius:20px;background:#dbe4dd;position:relative;flex-shrink:0;pointer-events:none}.errors-switch:after{content:'';position:absolute;width:20px;height:20px;background:#fff;border-radius:50%;left:3px;top:3px;box-shadow:0 1px 3px #17382e18;transition:transform .15s}.practice-errors>input:checked+.errors-switch{background:#21664b}.practice-errors>input:checked+.errors-switch:after{transform:translateX(17px)}.practice-errors>input:focus-visible+.errors-switch{outline:3px solid #87ac96;outline-offset:4px}.practice-summary{font-size:14px;color:#6a8174;line-height:1.7;padding:0 2px}.practice-summary p:first-child{display:flex;justify-content:space-between;gap:12px;font-size:13px;margin-bottom:8px;flex-wrap:wrap}.practice-summary strong{font-weight:600;color:#496456}.practice-error{background:#fff1ed;color:#a14938;border:1px solid #efcec4;border-radius:10px;padding:13px 15px;font-size:14px;line-height:1.6}.practice-launch{position:fixed;z-index:20;bottom:var(--app-bottom-nav-height,calc(68px + env(safe-area-inset-bottom,0px)));left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:14px;width:100%;max-width:600px;padding:13px max(16px,env(safe-area-inset-right,0px)) 13px max(16px,env(safe-area-inset-left,0px));border-top:1px solid #dfe8e2;background:#f3f6f4f5;backdrop-filter:blur(14px);box-shadow:0 -5px 15px #17382e05}.practice-launch>div{flex:1;display:grid;gap:5px;min-width:0}.practice-launch>div>span{font-size:13px;color:#74867b;line-height:1.4;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.practice-launch>div>strong{font-size:14px;font-weight:600;color:#315340;line-height:1.4}.practice-launch button{display:flex;align-items:center;justify-content:center;gap:11px;background:#21664b;color:#fff;border:1px solid #21664b;border-radius:12px;min-height:53px;min-width:145px;padding:14px 18px;font-size:16px;font-weight:600;line-height:1.3;flex-shrink:0}.practice-launch button:disabled{background:#a4b8ab;border-color:#a4b8ab;color:#f7faf8;opacity:1}.mobile-practice button:focus-visible,.practice-resume:focus-visible{outline:3px solid #87ac96;outline-offset:3px}.mobile-practice button:not(:disabled):active{filter:brightness(.96)}@media(min-width:480px){.practice-heading h1{font-size:30px}.practice-chapter{padding:17px;min-height:145px}.practice-chapter strong{font-size:15px}.practice-launch{padding-inline:22px}.practice-launch button{min-width:170px}}@media(max-width:359px){.practice-chapter{padding:12px}.practice-chapter strong{font-size:14px}.practice-launch{gap:10px;padding-inline:12px}.practice-launch button{min-width:129px;padding-inline:13px;font-size:15px}.practice-launch>div>strong{font-size:13px}.practice-launch>div>span{font-size:13px}.errors-symbol{display:none}}
</style>
