<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ArrowRight, Check, ChevronDown, Plus, Users } from '../components/icons'
import { chapterLabel, orderedChapters, selectedChapterIds, chapterCount } from '../../shared/curriculum'
import type { SchoolYearFilter, Difficulty, GameState } from '../../shared/types'
import { backendMode, post, session } from '../services/api'

const router = useRouter()
const code = ref('')
const selected = ref<string[]>([])
const schoolYear = ref<SchoolYearFilter>('all')
const difficulty = ref<Difficulty | 'all'>('all')
const count = ref(5)
const busy = ref('')
const error = ref('')
const chapters = computed(() => session.bootstrap?.chapters || [])
const chapterChoices = computed(() => orderedChapters(chapters.value))
const yearCounts = computed(() => schoolYear.value === 'all' ? (session.bootstrap?.challengeCounts ?? {}) : (session.bootstrap?.challengeCountsByYear?.[schoolYear.value] ?? {}))
const available = computed(() => selectedChapterIds(chapters.value, selected.value).reduce((total, id) => total + (yearCounts.value[id] ?? 0), 0))
const configuration = computed(() => `${count.value} questions · ${selected.value.length ? `${selected.value.length} chapitre${selected.value.length > 1 ? 's' : ''}` : 'Tous les chapitres'}`)
function normalizeCode(event: Event) {
  const input = event.target as HTMLInputElement
  code.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)
  input.value = code.value
}
function toggle(id: string) { selected.value = selected.value.includes(id) ? selected.value.filter(chapter => chapter !== id) : [...selected.value, id] }
async function enter(action: 'create' | 'join') {
  if (busy.value || (action === 'join' && code.value.length !== 6)) return
  busy.value = action
  error.value = ''
  try {
    const game = await post<GameState>(action === 'create' ? '/rooms' : '/rooms/join', action === 'create' ? { schoolYear: schoolYear.value, chapterIds: selected.value, difficulty: difficulty.value, count: count.value } : { code: code.value })
    sessionStorage.setItem('herbier-active-game', game.id)
    await router.push(`/game/${game.id}`)
  } catch (cause) { error.value = (cause as Error).message }
  finally { busy.value = '' }
}
</script>

<template>
  <div class="mobile-multiplayer">
    <header class="screen-heading"><h1>Défis</h1><p>Des QCS rapides : une seule bonne réponse.</p></header>
    <section class="join-card" aria-labelledby="join-heading">
      <h2 id="join-heading">Rejoindre un salon</h2>
      <form @submit.prevent="enter('join')">
        <label for="room-code">Le code à 6 caractères</label>
        <input id="room-code" :value="code" class="room-code" placeholder="ABC123" required minlength="6" maxlength="12" pattern="[A-Z0-9]{6}" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-describedby="code-help" @input="normalizeCode">
        <p id="code-help" class="field-help">Demandez le code à la personne qui a créé le salon.</p>
        <button class="join-action" :disabled="!!busy || code.length !== 6">{{ busy === 'join' ? 'Connexion…' : 'Rejoindre' }}<ArrowRight :size="20" /></button>
      </form>
    </section>
    <p v-if="error" role="alert" class="screen-error">{{ error }}</p>
    <div class="game-rules" aria-label="Règles du défi"><span><strong>30 s</strong> par question</span><span><strong>150 pts</strong> maximum</span></div>
    <section class="create-card" aria-labelledby="create-heading">
      <div class="create-heading"><span class="group-icon"><Users :size="22" /></span><div><h2 id="create-heading">Créer un salon</h2><p>Vous recevrez un code à partager.</p></div></div>
      <form @submit.prevent="enter('create')">
        <details class="room-settings">
          <summary><span>Paramètres<small>{{ configuration }}</small></span><ChevronDown :size="19" /></summary>
          <div class="settings-content">
            <label>Année BCPST<select v-model="schoolYear" class="select" aria-label="Année BCPST"><option value="all">Toutes les années</option><option value="BCPST1">BCPST1</option><option value="BCPST2">BCPST2</option></select></label><p class="field-help">Les questions communes sont incluses dans chaque année.</p><fieldset><legend>Chapitres</legend><div class="chapter-choices"><button type="button" :class="{ chosen: !selected.length }" :aria-pressed="!selected.length" @click="selected = []">Tous<Check v-if="!selected.length" :size="16" /></button><button v-for="chapter in chapterChoices" :key="chapter.id" type="button" :class="{ chosen: selected.includes(chapter.id) }" :aria-pressed="selected.includes(chapter.id)" @click="toggle(chapter.id)">{{ chapterLabel(chapters, chapter.id) }} · {{ chapterCount(chapters, yearCounts, chapter.id) }} QCS<Check v-if="selected.includes(chapter.id)" :size="16" /></button></div></fieldset>
            <div class="setting-fields"><label>Difficulté<select v-model="difficulty"><option value="all">Tous les niveaux</option><option value="easy">Facile</option><option value="medium">Intermédiaire</option><option value="hard">Difficile</option></select></label><label>Questions<select v-model="count"><option :value="5">5 questions</option><option :value="10">10 questions</option><option :value="15">15 questions</option></select></label></div>
          </div>
        </details>
        <p v-if="!available" class="field-help" role="status">Aucun QCS de défi publié dans ces chapitres. Un administrateur doit valider des variantes rapides.</p>
        <button class="create-action" :disabled="!!busy || !available"><Plus :size="20" />{{ busy === 'create' ? 'Création…' : 'Créer mon salon' }}</button>
      </form>
    </section>
    <details class="connection-help"><summary>Comment jouer sur plusieurs téléphones ?<ChevronDown :size="18" /></summary><p>{{ backendMode === 'supabase' ? 'Chaque joueur se connecte avec son compte sur son téléphone. Partagez le code du salon : une connexion Internet suffit.' : 'Chaque joueur utilise un compte différent. En mode local, ouvrez l’adresse réseau de cet ordinateur sur chaque téléphone, avec le même Wi-Fi. L’ordinateur doit rester allumé pendant la partie.' }}</p></details>
  </div>
</template>

<style scoped>
.mobile-multiplayer{display:flex;flex-direction:column;gap:20px;min-width:0;color:#17382e;font-size:16px}.screen-heading h1{font-family:inherit;font-size:28px;font-weight:700;line-height:1.2;letter-spacing:-.8px;margin:0 0 7px}.screen-heading p{margin:0;color:#5a7065;font-size:15px;line-height:1.5}.join-card,.create-card{background:#fff;border:1px solid #dfe8e2;border-radius:20px;padding:22px 20px}.mobile-multiplayer h2{font-family:inherit;font-size:19px;line-height:1.3;letter-spacing:-.35px;margin:0 0 21px}.join-card label{display:block;font-size:14px;font-weight:600;margin-bottom:10px}.room-code{width:100%;min-width:0;box-sizing:border-box;border:1.5px solid #ccdcd2;border-radius:13px;background:#f8faf9;color:#17382e;padding:20px 8px;text-align:center;font-family:inherit;font-size:clamp(26px,8vw,36px);font-weight:700;letter-spacing:.22em;line-height:1.3;min-height:86px}.room-code::placeholder{color:#a7b7af}.field-help{font-size:13px;color:#5a7065;line-height:1.5;margin:11px 0 20px}.join-action,.create-action{display:flex;align-items:center;justify-content:center;gap:12px;width:100%;min-height:52px;border-radius:12px;font-family:inherit;font-size:16px;font-weight:600;line-height:1.3;padding:13px 16px;cursor:pointer}.join-action{background:#315ed2;border:1px solid #315ed2;color:#fff}.create-action{background:#fff;border:1.5px solid #21664b;color:#21664b;margin-top:17px}.mobile-multiplayer button:disabled{opacity:.45;cursor:not-allowed}.mobile-multiplayer :is(input,select,button,summary):focus-visible{outline:3px solid #7797e7;outline-offset:3px}.game-rules{display:flex;justify-content:center;gap:26px;margin:-4px 0 0;font-size:13px;color:#5a7065}.game-rules strong{color:#315ed2;font-weight:700}.create-heading{display:flex;align-items:center;gap:13px;margin-bottom:19px}.group-icon{display:grid;place-items:center;flex-shrink:0;width:46px;height:46px;border-radius:14px;background:#eef5f0;color:#21664b}.create-heading h2{margin:0 0 4px}.create-heading p{margin:0;font-size:14px;color:#5a7065;line-height:1.4}.room-settings{border-top:1px solid #dfe8e2;border-bottom:1px solid #dfe8e2}.room-settings summary,.connection-help summary{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:55px;list-style:none;cursor:pointer;font-size:15px;font-weight:600}.mobile-multiplayer summary::-webkit-details-marker{display:none}.room-settings summary>span{padding:13px 0}.room-settings small{display:block;font-size:13px;font-weight:400;color:#5a7065;margin-top:5px}.room-settings[open] summary>svg,.connection-help[open] summary>svg{transform:rotate(180deg)}.settings-content{padding:4px 0 19px}.settings-content fieldset{border:0;padding:0;margin:0 0 21px}.settings-content legend{font-size:14px;font-weight:600;margin:0 0 11px}.chapter-choices{display:flex;flex-wrap:wrap;gap:8px}.chapter-choices button{display:flex;align-items:center;gap:8px;min-height:44px;max-width:100%;padding:9px 12px;border:1px solid #dfe8e2;border-radius:11px;background:#fff;color:#52695c;font-family:inherit;font-size:13px;font-weight:500;cursor:pointer}.chapter-choices button.chosen{background:#eaf3ed;border-color:#21664b;color:#21664b}.setting-fields{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px}.setting-fields label{min-width:0;font-size:13px;font-weight:600}.setting-fields select{display:block;width:100%;min-height:48px;box-sizing:border-box;margin-top:8px;border:1px solid #dfe8e2;border-radius:10px;background:#fff;color:#17382e;font-family:inherit;font-size:16px;padding:9px 7px}.connection-help{padding:0 4px}.connection-help summary{font-size:13px;line-height:1.5;color:#52695c;min-height:44px}.connection-help summary>svg{flex-shrink:0}.connection-help p{font-size:14px;line-height:1.7;color:#52695c;margin:4px 0 12px}.screen-error{border:1px solid #e6c8c5;background:#fff4f2;border-radius:12px;padding:13px 15px;margin:0;color:#943c34;font-size:14px;line-height:1.5}@media(min-width:480px){.join-card,.create-card{padding:25px}.room-code{font-size:36px}}
</style>
