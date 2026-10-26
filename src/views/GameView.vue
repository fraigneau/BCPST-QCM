<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { BookOpen, ChevronDown, ArrowLeft, ArrowRight, Check, CheckCircle2, Clock3, Copy, Crown, Flag, Lightbulb, LoaderCircle, Radio, RotateCcw, Trophy, Users, Wifi, WifiOff, X } from '../components/icons'
import QuizBoard from '../components/QuizBoard.vue'
import type { GameState } from '../../shared/types'
import { api, post, refreshSession, session, subscribeGame } from '../services/api'
import { notify } from '../services/feedback'

const route = useRoute()
const router = useRouter()
const game = ref<GameState | null>(null)
const selected = ref<number[]>([])
const busy = ref(false)
const error = ref('')
const now = ref(Date.now())
const clockOffset = ref(0)
const connected = ref(false)
const ready = ref(false)
let closeStream: (() => void) | undefined
let timer: ReturnType<typeof setInterval> | undefined
let poll: ReturnType<typeof setInterval> | undefined
let finishedRefreshed = false
let disposed = false
let loadingState = false
const id = String(route.params.id)
const me = computed(() => game.value?.players.find(player => player.id === session.user?.id))
const host = computed(() => game.value?.hostId === session.user?.id)
const remaining = computed(() => game.value?.deadline ? Math.max(0, Math.ceil((game.value.deadline - now.value - clockOffset.value) / 1000)) : 0)
const answered = computed(() => !!me.value?.answered || !!game.value?.result)
const ranking = computed(() => [...(game.value?.players || [])].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'fr')))
const correctCount = computed(() => game.value?.results.filter(result => result.correct).length || 0)
const chapter = computed(() => session.bootstrap?.chapters.find(item => item.id === game.value?.question?.chapterId))
function accept(state: GameState) {
  if (disposed) return
  if (game.value && state.serverNow < game.value.serverNow) return
  if (game.value?.question?.id !== state.question?.id) selected.value = []
  game.value = state
  clockOffset.value = state.serverNow - Date.now()
  now.value = Date.now()
  error.value = ''
  if (state.result) selected.value = [...state.result.selected]
  if (state.status === 'finished' && !finishedRefreshed) {
    finishedRefreshed = true
    sessionStorage.removeItem('herbier-active-game')
    void refreshSession()
  }
}
async function load() {
  if (disposed || loadingState) return
  loadingState = true
  try { accept(await api<GameState>(`/games/${id}`)) }
  catch (cause) { if (!disposed) error.value = (cause as Error).message }
  finally { loadingState = false; if (!disposed) ready.value = true }
}
function toggle(index: number) {
  if (answered.value || busy.value || (game.value?.mode === 'multi' && remaining.value <= 0)) return
  selected.value = selected.value.includes(index) ? selected.value.filter(value => value !== index) : [...selected.value, index]
}
async function action(name: 'answer' | 'next' | 'start') {
  if (busy.value || disposed) return
  busy.value = true
  error.value = ''
  try { accept(await post<GameState>(`/games/${id}/${name}`, name === 'answer' ? { selected: selected.value, questionId: game.value?.question?.id } : {})) }
  catch (cause) { await load(); error.value = (cause as Error).message }
  finally { busy.value = false }
}
async function copy() {
  if (!game.value?.code) return
  try { await navigator.clipboard.writeText(game.value.code); notify('Code du salon copié.') }
  catch { notify(`Code du salon : ${game.value.code}`) }
}
onMounted(async () => {
  await load()
  if (disposed || !game.value || game.value.status === 'finished') return
  sessionStorage.setItem('herbier-active-game', id)
  closeStream = subscribeGame({ gameId: id, mode: game.value.mode, onConnection: value => { connected.value = value }, onState: accept })
  if (game.value.mode === 'multi') timer = setInterval(() => { now.value = Date.now() }, 150)
  poll = setInterval(() => {
    if (!connected.value && !busy.value && document.visibilityState !== 'hidden' && game.value?.status !== 'finished') void load()
  }, 3500)
})
onBeforeUnmount(() => { disposed = true; closeStream?.(); clearInterval(timer); clearInterval(poll) })
onBeforeRouteLeave(async () => {
  if (!game.value || game.value.status === 'finished') return true
  if (!session.user) return true
  if (game.value.mode === 'multi') {
    if (!window.confirm('Quitter le salon ? Vous pourrez revenir avec son code tant que la partie est en cours.')) return false
    try { await post(`/games/${id}/leave`) } catch { }
    sessionStorage.removeItem('herbier-active-game')
  } else {
    sessionStorage.setItem('herbier-active-game', id)
  }
  return true
})
</script>

<template>
  <div class="game-page" :class="{ 'is-competitive': game?.mode === 'multi' }">
    <div v-if="!ready" class="empty-state"><LoaderCircle class="spin" :size="30" /><h2>Préparation de votre séance…</h2></div>
    <div v-else-if="!game" class="panel empty-state"><Flag :size="30" /><h2>Cette partie est indisponible.</h2><p>{{ error }}</p><RouterLink class="button" to="/practice">Préparer une nouvelle séance</RouterLink></div>
    <template v-else>
      <div class="game-topline">
        <button class="button ghost exit-game" @click="router.push(game.mode === 'solo' ? '/practice' : '/multiplayer')"><ArrowLeft :size="19" /><span>{{ game.status === 'finished' ? 'Retour' : 'Quitter' }}</span></button>
        <span class="play-mode" :class="{ competitive: game.mode === 'multi' }"><component :is="game.mode === 'solo' ? BookOpen : Radio" :size="16" />{{ game.mode === 'solo' ? 'Révision solo' : 'Défi multijoueur' }}</span>
        <div class="session-status"><span v-if="game.status === 'playing'" class="session-score"><Trophy :size="15" />{{ me?.score || 0 }}<small>pts</small></span><span v-if="!connected && game.status !== 'finished'" class="reconnecting" role="status" title="Reconnexion au serveur en cours"><WifiOff :size="16" /><span class="sr-only">Reconnexion au serveur en cours</span></span><span v-else-if="game.status === 'finished'" class="saved-status" title="Résultats enregistrés"><CheckCircle2 :size="19" /><span class="sr-only">Résultats enregistrés</span></span></div>
      </div>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <section v-if="game.status === 'waiting'" class="waiting-layout">
        <div class="panel invitation-panel"><span class="waiting-icon"><Users :size="30" /></span><p class="eyebrow">Le groupe se rassemble</p><h1>Ton salon est prêt.</h1><p class="muted">Partagez ce code avec les autres joueurs.</p><button class="invite-code" :aria-label="`Copier le code ${game.code}`" @click="copy">{{ game.code }}<Copy :size="19" /></button><p class="helper">{{ game.totalQuestions }} questions · 30 secondes par question</p><div class="host-note"><Radio :size="18" /><p>{{ host ? 'Vous êtes l’hôte. Lancez la partie quand tout le monde est prêt.' : 'L’hôte lancera la partie quand tout le monde sera prêt.' }}</p></div><button v-if="host" class="button start-game" :disabled="busy || game.players.length < 2" @click="action('start')">{{ busy ? 'Lancement…' : 'Tout le monde est là, on y va !' }}<ArrowRight :size="18" /></button><p v-if="host && game.players.length < 2" class="helper">Un deuxième joueur doit rejoindre le salon pour commencer.</p></div>
        <div class="panel waiting-players"><div class="section-heading"><h2>Dans le salon</h2><span class="badge">{{ game.players.length }} joueurs</span></div><div v-for="player in game.players" :key="player.id" class="player-row"><span class="player-avatar">{{ player.name.slice(0, 1).toUpperCase() }}</span><div><strong>{{ player.name }} <small v-if="player.id === session.user?.id">(vous)</small></strong><span>{{ player.connected ? 'Prêt à jouer' : 'Déconnecté' }}</span></div><Crown v-if="player.id === game.hostId" class="host-crown" :size="19" /><span v-else class="online-dot" :class="{ disconnected: !player.connected }"></span></div><div class="waiting-tip"><Lightbulb :size="20" /><p>La précision d’abord. Une bonne réponse vaut 100 points ; la rapidité peut en ajouter 50.</p></div></div>
      </section>
      <section v-else-if="game.status === 'finished'" class="results-layout">
        <div class="panel result-summary"><span class="result-trophy"><Trophy :size="36" :stroke-width="1.5" /></span><p class="eyebrow">Séance terminée</p><h1>{{ game.mode === 'solo' ? 'Quiz terminé !' : 'Partie terminée !' }}</h1><p class="muted">{{ game.mode === 'solo' ? 'Retrouve tes réponses et ta progression.' : 'Le classement final est prêt.' }}</p><div class="result-numbers"><div><strong>{{ me?.score || 0 }}</strong><span>points gagnés</span></div><div><strong>{{ correctCount }}<small>/{{ game.totalQuestions }}</small></strong><span>bonnes réponses</span></div><div><strong>{{ Math.round(correctCount / Math.max(1, game.totalQuestions) * 100) }}<small>%</small></strong><span>de réussite</span></div></div><div class="result-actions"><RouterLink class="button" :to="game.mode === 'solo' ? '/practice' : '/multiplayer'"><RotateCcw :size="17" />{{ game.mode === 'solo' ? 'Une nouvelle séance' : 'Rejouer ensemble' }}</RouterLink><RouterLink class="button secondary" to="/progression">Voir ma progression<ArrowRight :size="16" /></RouterLink></div></div>
        <div v-if="game.mode === 'multi'" class="panel final-ranking"><div class="section-heading"><h2>Le classement final</h2><Trophy :size="20" /></div><div v-for="(player, index) in ranking" :key="player.id" class="rank-row" :class="{ 'is-me': player.id === session.user?.id }"><span class="rank-position" :class="{ first: index === 0 }">{{ index === 0 ? '✦' : index + 1 }}</span><span class="player-avatar">{{ player.name[0]?.toUpperCase() }}</span><strong>{{ player.name }}<small v-if="player.id === session.user?.id">Vous</small></strong><b>{{ player.score }} <small>pts</small></b></div></div>
        <div class="panel recap-panel"><div class="section-heading"><h2>Votre séance, en détail</h2><span class="badge">{{ game.results.length }} réponses</span></div><div v-for="(result, index) in game.results" :key="result.questionId" class="recap-row"><span class="recap-number">{{ String(index + 1).padStart(2, '0') }}</span><component :is="result.correct ? CheckCircle2 : X" :size="18" :class="result.correct ? 'correct-ink' : 'wrong-ink'" /><div><strong>{{ result.correct ? 'Bonne réponse' : result.selected.length ? 'À revoir' : 'Temps écoulé' }}</strong><p>{{ result.explanation }}</p></div><span class="recap-points">+{{ result.points }}</span></div></div>
      </section>
      <section v-else class="play-layout" :class="{ solo: game.mode === 'solo' }">
        <QuizBoard :game="game" :chapter="chapter" :user-id="session.user?.id" :selected="selected" :busy="busy" :remaining="remaining" @choose="toggle" @submit="action('answer')" @next="action('next')" />
        <details v-if="game.mode === 'multi'" class="panel live-ranking">
          <summary class="ranking-toggle"><span>Le groupe</span><span class="live-label"><Radio :size="14" />{{ game.players.filter(player => player.answered).length }} / {{ game.players.length }} réponses</span><ChevronDown :size="17" /></summary>
          <div class="ranking-content"><div v-for="(player, index) in ranking" :key="player.id" class="live-player" :class="{ 'is-me': player.id === session.user?.id }"><span class="small-rank">{{ index + 1 }}</span><div><strong>{{ player.name }} <small v-if="player.id === session.user?.id">(vous)</small></strong><span>{{ !player.connected ? 'Déconnecté' : player.answered ? 'A répondu' : 'Réfléchit…' }}</span></div><b>{{ player.score }}</b><CheckCircle2 v-if="player.answered" class="correct-ink" :size="15" /></div></div>
        </details>
      </section>
    </template>
  </div>
</template>

<style scoped>
.game-page { max-width: 640px; margin-inline: auto; }
.game-topline { display: grid; grid-template-columns: 1fr auto 1fr; gap: 8px; align-items: center; margin-bottom: 12px; min-height: 44px; }
.exit-game { justify-self: start; min-height: 44px; padding: 8px 0; font-size: 14px; gap: 5px; }
.play-mode { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 8px 10px; border-radius: 20px; background: #e2eee4; color: #346047; font-size: 13px; font-weight: 600; white-space: nowrap; }
.play-mode.competitive { background: #e7edfc; color: #315ed2; }
.session-status { display: flex; align-items: center; justify-content: flex-end; gap: 7px; }
.session-score { display: inline-flex; align-items: center; gap: 4px; font-size: 16px; font-weight: 700; }
.session-score svg, .session-score small { display: none; }
.reconnecting { display: flex; color: #9e722e; }
.saved-status { color: var(--green); }
.game-page>.form-error { margin-block: 14px; }
.waiting-layout, .results-layout { display: flex; flex-direction: column; gap: 16px; margin-top: 20px; }
.invitation-panel { padding: 26px 20px; text-align: center; }
.waiting-icon, .result-trophy { display: inline-flex; justify-content: center; align-items: center; width: 60px; height: 60px; border-radius: 20px; color: #315ed2; background: #eaf0ff; margin-bottom: 16px; }
.invitation-panel .eyebrow, .result-summary .eyebrow { display: none; }
.invitation-panel h1 { font-size: 27px; }
.invitation-panel>.muted { font-size: 15px; margin-top: 10px; }
.invite-code { display: flex; align-items: center; justify-content: center; gap: 12px; width: 100%; margin: 22px 0 12px; padding: 20px 10px; background: #eef2ff; border: 1px dashed #a8b8e3; border-radius: 14px; color: #3154a4; font-size: clamp(26px, 7vw, 36px); letter-spacing: 5px; font-weight: 750; }
.helper { font-size: 13px; color: var(--muted); line-height: 1.6; }
.host-note { display: flex; align-items: flex-start; gap: 10px; border-top: 1px solid var(--line); margin-top: 22px; padding-top: 18px; color: var(--muted); text-align: left; }
.host-note p, .waiting-tip { font-size: 14px; line-height: 1.6; }
.start-game { width: 100%; margin: 20px 0 10px; background: #315ed2; }
.waiting-players { padding: 22px 20px; }
.player-row { display: flex; align-items: center; gap: 12px; padding: 16px 0; border-bottom: 1px solid var(--line); }
.player-avatar { display: grid; place-items: center; width: 40px; height: 40px; background: #e8eee9; border-radius: 13px; flex-shrink: 0; font-size: 15px; color: var(--green); }
.player-row>div { flex: 1; min-width: 0; }
.player-row strong { font-size: 15px; overflow-wrap: anywhere; }
.player-row small, .player-row>div>span { font-size: 13px; font-weight: 400; color: var(--muted); }
.player-row>div>span { display: block; margin-top: 3px; }
.host-crown { color: #9e762e; }
.online-dot { width: 8px; height: 8px; border-radius: 50%; background: #42895a; }
.online-dot.disconnected { background: #9da8a0; }
.waiting-tip { display: flex; gap: 10px; margin-top: 20px; color: var(--muted); }
.result-summary { padding: 28px 20px; text-align: center; }
.result-summary h1 { font-size: 28px; }
.result-summary>.muted { margin-top: 12px; font-size: 15px; }
.result-trophy { color: #98702d; background: #fbf0d9; }
.result-numbers { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin: 28px 0; }
.result-numbers strong { display: block; font-size: 28px; letter-spacing: -.8px; }
.result-numbers strong small { font-size: 16px; }
.result-numbers span { display: block; margin-top: 5px; color: var(--muted); font-size: 12px; }
.result-actions { display: flex; flex-direction: column; gap: 10px; }
.recap-panel, .final-ranking { padding: 22px 18px; }
.recap-row { display: flex; gap: 10px; align-items: flex-start; padding: 18px 0; border-top: 1px solid var(--line); }
.recap-number { display: none; }
.recap-row>div { flex: 1; min-width: 0; }
.recap-row strong { font-size: 15px; }
.recap-row p { margin-top: 8px; white-space: pre-line; font-size: 14px; line-height: 1.7; color: var(--muted); }
.recap-points { font-weight: 650; font-size: 15px; }
.correct-ink { color: var(--green); }
.wrong-ink { color: #a15f35; }
.rank-row { display: flex; align-items: center; gap: 10px; padding: 15px 0; border-top: 1px solid var(--line); }
.rank-row.is-me { background: #edf5ee; }
.rank-position { min-width: 20px; font-size: 14px; }
.rank-position.first { color: #97702d; font-size: 22px; }
.rank-row>strong { flex: 1; min-width: 0; font-size: 15px; overflow-wrap: anywhere; }
.rank-row>strong small { display: block; font-size: 12px; font-weight: 400; color: var(--muted); }
.rank-row>b { font-size: 18px; }
.rank-row>b small { font-size: 12px; font-weight: 400; }
.live-ranking { margin-top: 18px; padding: 0 16px; }
.ranking-toggle { display: flex; align-items: center; gap: 8px; min-height: 54px; font-size: 15px; font-weight: 600; cursor: pointer; list-style: none; }
.ranking-toggle::-webkit-details-marker { display: none; }
.live-label { margin-left: auto; display: inline-flex; align-items: center; gap: 5px; font-size: 13px; font-weight: 400; color: var(--muted); }
.live-ranking[open] .ranking-toggle>svg { transform: rotate(180deg); }
.live-player { display: flex; align-items: center; gap: 10px; border-top: 1px solid var(--line); padding: 15px 0; }
.small-rank { font-size: 13px; color: var(--muted); }
.live-player>div { flex: 1; min-width: 0; }
.live-player strong { font-size: 15px; }
.live-player small, .live-player>div>span { font-size: 12px; color: var(--muted); font-weight: 400; }
.live-player>div>span { display: block; }
.live-player b { font-size: 16px; }
.spin { animation: spin 1.5s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 359px) { .exit-game span { font-size: 13px; } .play-mode { font-size: 12px; padding-inline: 8px; } .reconnecting { display: none; } }
</style>
