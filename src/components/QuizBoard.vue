<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { ArrowRight, Check, CheckCircle2, Clock3, Lightbulb, X } from './icons'
import type { Chapter, GameState } from '../../shared/types'

const props = defineProps<{
  game: GameState
  chapter?: Chapter
  userId?: string
  selected: number[]
  busy: boolean
  remaining: number
}>()

const emit = defineEmits<{
  choose: [index: number]
  submit: []
  next: []
}>()

const correction = ref<HTMLElement | null>(null)
const competitive = computed(() => props.game.mode === 'multi')
const me = computed(() => props.game.players.find(player => player.id === props.userId))
const answered = computed(() => !!me.value?.answered || !!props.game.result)
const locked = computed(() => answered.value || props.busy || props.game.phase === 'correction' || (competitive.value && props.remaining <= 0))
const difficultyNames = { easy: 'Facile', medium: 'Intermédiaire', hard: 'Difficile' }

watch(() => props.game.question?.id, (id, previous) => {
  if (id && previous && id !== previous) window.scrollTo({ top: 0, behavior: 'auto' })
})

watch(() => props.game.result, async (result, previous) => {
  if (!result || previous) return
  await nextTick()
  correction.value?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' })
})
</script>

<template>
  <div class="quiz-board" :class="{ competitive }">
    <div class="round-progress">
      <span class="round-count">Question <strong>{{ game.questionIndex + 1 }}</strong><span> / {{ game.totalQuestions }}</span></span>
      <div class="round-track" role="progressbar" aria-label="Avancement du quiz" :aria-valuenow="game.questionIndex + 1" :aria-valuemax="game.totalQuestions" :aria-valuemin="0">
        <span :style="{ width: `${(game.questionIndex + 1) / game.totalQuestions * 100}%` }"></span>
      </div>
      <span v-if="competitive" class="round-timer" :class="{ urgent: remaining <= 5 && game.phase === 'question' }" :aria-label="`${remaining} secondes restantes`"><Clock3 :size="17" />{{ remaining }}<small>s</small></span>
      <span v-else class="untimed-label">Sans chrono</span>
    </div>

    <section v-if="game.question" class="question-stage" aria-labelledby="quiz-question">
      <div class="question-content">
        <div class="question-meta"><span :style="{ color: chapter?.color }">{{ chapter?.shortName }}</span><span class="difficulty-tag">{{ difficultyNames[game.question.difficulty] }}</span></div>
        <h1 id="quiz-question">{{ game.question.prompt }}</h1>
        <figure v-if="game.question.image" class="question-document"><img :src="game.question.image" alt="Document associé à la question" /></figure>
      </div>

      <div class="answer-tray">
        <p id="answer-help" class="answer-help">{{ competitive ? 'Choisis tes réponses, puis valide.' : 'Une ou plusieurs réponses peuvent être exactes.' }}</p>
        <div class="answer-grid" role="group" aria-labelledby="quiz-question" aria-describedby="answer-help">
          <button
            v-for="(option, index) in game.question.options"
            :key="index"
            type="button"
            class="answer-tile"
            :class="{
              [`tile-${index}`]: true,
              selected: selected.includes(index),
              correct: game.result?.correctAnswers.includes(index),
              incorrect: game.result && selected.includes(index) && !game.result.correctAnswers.includes(index),
              muted: game.result && !selected.includes(index) && !game.result.correctAnswers.includes(index),
            }"
            :aria-pressed="selected.includes(index)"
            :disabled="locked"
            @click="emit('choose', index)"
          >
            <span class="tile-top"><span class="tile-letter">{{ String.fromCharCode(65 + index) }}</span><span class="tile-check"><Check v-if="game.result?.correctAnswers.includes(index) || (!game.result && selected.includes(index))" :size="17" /><X v-else-if="game.result && selected.includes(index)" :size="17" /></span></span>
            <span class="tile-text">{{ option }}</span>
            <span class="tile-feedback">{{ game.result?.correctAnswers.includes(index) ? 'Bonne réponse' : game.result && selected.includes(index) ? 'À revoir' : selected.includes(index) ? 'Sélectionnée' : '' }}</span>
          </button>
        </div>

        <div v-if="!answered && game.phase === 'question'" class="answer-submit">
          <button class="button confirm-answer" :disabled="!selected.length || busy || (competitive && remaining <= 0)" @click="emit('submit')">{{ busy ? 'Envoi…' : 'Valider ma réponse' }}<ArrowRight :size="19" /></button>
          <p aria-live="polite">{{ selected.length ? `${selected.length} réponse${selected.length > 1 ? 's' : ''} sélectionnée${selected.length > 1 ? 's' : ''}` : competitive ? '100 points + un bonus de rapidité.' : 'Prends ton temps, chaque réponse compte.' }}</p>
        </div>
        <div v-else-if="!game.result" class="answer-recorded" role="status"><CheckCircle2 :size="21" /><span>{{ answered ? 'C’est enregistré ! Les autres jouent encore…' : 'Temps écoulé. La correction arrive…' }}</span></div>
      </div>
    </section>

    <section v-if="game.result" ref="correction" class="round-correction" :class="{ 'needs-review': !game.result.correct }" aria-live="polite" aria-labelledby="correction-title">
      <div class="correction-title"><span class="correction-symbol"><component :is="game.result.correct ? Check : Lightbulb" :size="24" /></span><div><p>{{ game.result.correct ? 'Bien joué !' : 'On retient pour la prochaine fois' }}</p><h2 id="correction-title">{{ game.result.correct ? 'Tu as tout bon.' : game.result.selected.length ? 'Prenons le temps de comprendre.' : 'Le temps s’est écoulé.' }}</h2></div><span class="round-points">+{{ game.result.points }}<small>points</small></span></div>
      <p class="correction-explanation">{{ game.result.explanation }}</p>
      <button v-if="!competitive" class="button next-question" :disabled="busy" @click="emit('next')">{{ busy ? 'Chargement…' : game.questionIndex + 1 === game.totalQuestions ? 'Voir mes résultats' : 'Question suivante' }}<ArrowRight :size="19" /></button>
      <p v-else class="next-round"><Clock3 :size="16" />{{ game.questionIndex + 1 === game.totalQuestions ? 'Classement final' : 'Prochaine question' }} dans {{ remaining }} s</p>
    </section>
  </div>
</template>

<style scoped>
.quiz-board {
  --tile-size: clamp(136px, 22svh, 218px);
  width: 100%;
  max-width: 660px;
  margin-inline: auto;
}
.round-progress { display: flex; align-items: center; gap: 16px; min-height: 38px; margin-bottom: 18px; }
.round-count { color: #66766c; font-size: 12px; white-space: nowrap; }
.round-count strong { color: #224b38; font-size: 18px; margin-left: 4px; }
.round-count > span { color: #8c988e; }
.round-track { height: 5px; background: #e2e8df; border-radius: 6px; flex: 1; overflow: hidden; }
.round-track > span { display: block; height: 100%; background: #648c5f; border-radius: inherit; transition: width .2s; }
.untimed-label { color: #71856d; font-size: 11px; white-space: nowrap; }
.round-timer { display: flex; align-items: center; justify-content: center; gap: 6px; min-width: 73px; padding: 7px 10px; border: 1px solid #cad8ef; border-radius: 10px; background: #eef3fc; color: #345b99; font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; }
.round-timer small { font-size: 11px; font-weight: 500; }
.round-timer.urgent { color: #ad382e; background: #fdf0ed; border-color: #e8b5ab; }
.question-stage { display: flex; flex-direction: column; min-height: calc(100svh - 150px); }
.question-content { display: flex; flex-direction: column; justify-content: center; align-items: center; flex: 1; padding: 14px 4px 28px; text-align: center; }
.question-meta { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 9px; margin-bottom: 15px; font-size: 11px; font-weight: 600; }
.difficulty-tag { background: #edf1e8; border: 1px solid #e2e8dc; color: #7b8a6b; font-size: 10px; padding: 3px 8px; border-radius: 6px; font-weight: 500; }
.question-content h1 { width: 100%; max-width: 600px; color: #203c32; font-size: clamp(22px, 4.8vw, 30px); line-height: 1.35; letter-spacing: -.7px; font-weight: 650; overflow-wrap: anywhere; }
.question-document { display: flex; align-items: center; justify-content: center; margin: 20px 0 0; padding: 12px; width: 100%; max-width: 420px; background: #fff; border: 1px solid #e0e7dc; border-radius: 14px; }
.question-document img { max-height: 175px; width: auto; max-width: 100%; object-fit: contain; }
.answer-tray { width: 100%; margin-top: auto; }
.answer-help { margin-bottom: 12px; text-align: center; font-size: 11px; color: #778577; }
.answer-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; width: 100%; max-width: calc(var(--tile-size) * 2 + 12px); margin-inline: auto; }
.answer-tile { --tile-bg: #dfebfa; --tile-ink: #285581; --tile-border: #b9cfe9; position: relative; display: grid; grid-template-rows: auto 1fr auto; align-items: stretch; gap: 8px; width: 100%; min-width: 0; min-height: min(var(--tile-size), calc((100vw - 44px) / 2)); padding: 15px; border: 2px solid transparent; border-radius: 19px; background: var(--tile-bg); color: var(--tile-ink); text-align: center; touch-action: manipulation; transition: border-color .15s, background-color .15s, box-shadow .15s; }
.tile-1 { --tile-bg: #ebe4f8; --tile-ink: #65478b; --tile-border: #cbb5e7; }
.tile-2 { --tile-bg: #f7edcc; --tile-ink: #80621f; --tile-border: #dbc77f; }
.tile-3 { --tile-bg: #dcefe7; --tile-ink: #2d6854; --tile-border: #aacfbf; }
.answer-tile:not(:disabled):hover { border-color: var(--tile-border); }
.answer-tile:not(:disabled):active { transform: scale(.98); }
.answer-tile:focus-visible { outline: 3px solid #193d33; outline-offset: 3px; }
.answer-tile:disabled { opacity: 1; cursor: default; }
.tile-top { display: flex; justify-content: space-between; align-items: center; }
.tile-letter { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 8px; background: #ffffff66; color: inherit; font-size: 12px; font-weight: 750; }
.tile-check { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border: 1.5px solid currentColor; border-radius: 50%; opacity: .45; }
.tile-text { display: flex; align-items: center; justify-content: center; flex: 1; font-size: clamp(14px, 3.7vw, 17px); font-weight: 650; line-height: 1.4; letter-spacing: -.15px; overflow-wrap: anywhere; }
.tile-feedback { min-height: 16px; font-size: 11px; font-weight: 600; opacity: .8; }
.answer-tile.selected { border-color: var(--tile-ink); box-shadow: inset 0 0 0 1px var(--tile-ink); }
.selected .tile-check { background: var(--tile-ink); color: var(--tile-bg); border-color: var(--tile-ink); opacity: 1; }
.answer-tile.correct { background: #dcefdc; border-color: #458052; color: #275b35; box-shadow: none; }
.answer-tile.correct .tile-check { color: #fff; background: #458052; border-color: #458052; opacity: 1; }
.answer-tile.incorrect { background: #fae5df; border-color: #bc6a52; color: #8e4432; box-shadow: none; }
.answer-tile.incorrect .tile-check { color: #fff; background: #bc6a52; border-color: #bc6a52; opacity: 1; }
.answer-tile.muted { background: #edf0eb; color: #8d9887; border-color: transparent; box-shadow: none; }
.answer-submit { width: 100%; max-width: calc(var(--tile-size) * 2 + 12px); margin: 15px auto 0; }
.confirm-answer { width: 100%; min-height: 52px; padding: 14px 18px; justify-content: space-between; border-radius: 13px; font-size: 14px; }
.confirm-answer:disabled { background: #e2e8de; color: #82917b; opacity: 1; cursor: default; }
.answer-submit > p { margin-top: 9px; color: #7b8876; text-align: center; font-size: 10px; }
.answer-recorded { display: flex; align-items: center; justify-content: center; gap: 10px; min-height: 72px; padding: 16px 10px 0; color: #507b4e; font-size: 12px; text-align: center; }
.answer-recorded svg { flex-shrink: 0; }
.round-correction { max-width: 560px; margin: 22px auto 0; padding: 23px; border: 1px solid #d2e2cc; background: #ecf4e7; border-radius: 19px; scroll-margin-block: 18px; }
.round-correction.needs-review { background: #f5f0e3; border-color: #e5d9b9; }
.correction-title { display: flex; align-items: center; gap: 12px; }
.correction-symbol { display: inline-flex; align-items: center; justify-content: center; width: 41px; height: 41px; border-radius: 13px; background: #dbe9ce; color: #597744; flex-shrink: 0; }
.needs-review .correction-symbol { background: #eae0c3; color: #8b783d; }
.correction-title > div { flex: 1; }
.correction-title p { font-size: 10px; color: #78906a; margin-bottom: 5px; }
.correction-title h2 { font-size: 16px; letter-spacing: -.3px; line-height: 1.4; }
.round-points { font-size: 24px; font-weight: 700; color: #52773e; letter-spacing: -.6px; flex-shrink: 0; }
.round-points small { display: block; text-align: center; font-size: 9px; font-weight: 400; letter-spacing: 0; }
.correction-explanation { margin: 21px 0; font-size: 14px; color: #5e7355; line-height: 1.85; white-space: pre-line; }
.needs-review .correction-explanation { color: #7f7253; }
.next-question { width: 100%; min-height: 50px; justify-content: space-between; border-radius: 12px; font-size: 13px; }
.next-round { display: flex; align-items: center; justify-content: center; gap: 8px; color: #7d896e; font-size: 12px; border-top: 1px solid #dce4d2; padding-top: 17px; }
.competitive .tile-0 { --tile-bg: #2d65b1; --tile-ink: #fff; --tile-border: #143c76; }
.competitive .tile-1 { --tile-bg: #7548ad; --tile-ink: #fff; --tile-border: #45266c; }
.competitive .tile-2 { --tile-bg: #986b15; --tile-ink: #fff; --tile-border: #5f4009; }
.competitive .tile-3 { --tile-bg: #187d69; --tile-ink: #fff; --tile-border: #0e5243; }
.competitive .answer-tile.selected { border-color: #203a5a; box-shadow: inset 0 0 0 2px #fff; }
.competitive .answer-tile.correct { background: #dcefdc; color: #275b35; border-color: #458052; box-shadow: none; }
.competitive .answer-tile.incorrect { background: #fae5df; color: #8e4432; border-color: #bc6a52; box-shadow: none; }
.competitive .answer-tile.muted { background: #e7ebf0; color: #88929e; border-color: transparent; box-shadow: none; }
.competitive .round-track > span { background: #6283b4; }
.competitive .confirm-answer:not(:disabled) { background: #284b7d; }
@media (min-width: 700px) {
  .question-content { padding-top: 24px; padding-bottom: 30px; }
  .question-stage { min-height: calc(100svh - 155px); }
}
@media (max-width: 380px) {
  .answer-grid { gap: 10px; }
  .answer-tile { padding: 12px; border-radius: 16px; }
  .tile-text { font-size: 14px; }
  .round-progress { gap: 10px; }
  .untimed-label { font-size: 10px; }
  .round-correction { padding: 18px; }
  .correction-title h2 { font-size: 14px; }
}
</style>
