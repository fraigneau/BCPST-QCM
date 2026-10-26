<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ArrowRight, BookOpen, Users, RotateCcw } from '../components/icons'
import { api, session } from '../services/api'
import type { GameState } from '../../shared/types'
import ChapterIcon from '../components/ChapterIcon.vue'

const progress = computed(() => session.bootstrap?.progress)
const chapters = computed(() => session.bootstrap?.chapters || [])
const firstName = computed(() => session.user?.name.split(' ')[0] || '')
const totalQuestions = computed(() => Object.values(session.bootstrap?.counts || {}).reduce((sum, count) => sum + count, 0))
const resumed = ref<GameState | null>(null)

onMounted(async () => {
  const activeId = sessionStorage.getItem('herbier-active-game')
  if (!activeId) return
  try {
    const state = await api<GameState>(`/games/${activeId}`)
    if (state.status !== 'finished') resumed.value = state
    else if (sessionStorage.getItem('herbier-active-game') === activeId) sessionStorage.removeItem('herbier-active-game')
  } catch {
    if (sessionStorage.getItem('herbier-active-game') === activeId) sessionStorage.removeItem('herbier-active-game')
  }
})
</script>

<template>
  <div class="mobile-home">
    <header class="home-welcome">
      <h1>Bonjour {{ firstName }}</h1>
      <p>Qu’est-ce qu’on révise aujourd’hui ?</p>
    </header>

    <RouterLink v-if="resumed" :to="`/game/${resumed.id}`" class="home-resume">
      <span class="resume-symbol"><RotateCcw :size="23" /></span>
      <span><strong>{{ resumed.mode === 'solo' ? 'Reprendre ma révision' : 'Retrouver mon défi' }}</strong><small>{{ resumed.status === 'waiting' ? 'Votre groupe vous attend' : `Question ${resumed.questionIndex + 1} sur ${resumed.totalQuestions}` }}</small></span>
      <ArrowRight :size="20" />
    </RouterLink>

    <section class="home-modes" aria-label="Choisir un mode de jeu">
      <RouterLink class="home-solo" to="/practice">
        <span class="solo-symbol"><BookOpen :size="27" /></span>
        <span class="mode-copy"><strong>Révision solo</strong><span>Sans chrono, à votre rythme.</span></span>
        <ArrowRight :size="23" />
      </RouterLink>
      <RouterLink class="home-challenge" to="/multiplayer">
        <span class="challenge-symbol"><Users :size="24" /></span>
        <span class="mode-copy"><strong>Défi multijoueur</strong><span>Un salon, vos amis, 30 secondes.</span></span>
        <ArrowRight :size="21" />
      </RouterLink>
    </section>

    <section class="home-numbers" aria-label="Vos statistiques">
      <div><strong>{{ (progress?.totalPoints || 0).toLocaleString('fr-FR') }}</strong><span>Points</span></div>
      <div><strong>{{ progress?.accuracy || 0 }}<small> %</small></strong><span>Réussite</span></div>
      <div><strong>{{ progress?.answered || 0 }}</strong><span>Questions</span></div>
    </section>

    <section class="home-chapters" aria-labelledby="home-chapters-title">
      <div class="chapter-list-heading"><h2 id="home-chapters-title">Par chapitre</h2><span>{{ totalQuestions }} questions</span></div>
      <div class="chapter-list">
        <RouterLink v-for="chapter in chapters" :key="chapter.id" :to="{ path: '/practice', query: { chapter: chapter.id } }" class="home-chapter">
          <span class="chapter-emblem" :style="{ color: chapter.color }"><ChapterIcon :id="chapter.id" :size="26" /></span>
          <span class="chapter-description"><strong>{{ chapter.name }}</strong><small>{{ session.bootstrap?.counts[chapter.id] || 0 }} questions</small></span>
          <ArrowRight :size="18" />
        </RouterLink>
      </div>
      <p v-if="!chapters.length" class="chapter-empty">Les chapitres apparaîtront dès que la bibliothèque sera disponible.</p>
    </section>

    <RouterLink v-if="progress?.mistakes.length" class="home-mistakes" to="/practice?mistakes=1"><RotateCcw :size="19" /><span>Revoir mes erreurs</span><span class="mistake-count">{{ progress.mistakes.length }}</span><ArrowRight :size="18" /></RouterLink>
  </div>
</template>

<style scoped>
.mobile-home{color:#17382e;font-size:16px;padding-bottom:12px}.home-welcome{margin:4px 0 23px}.home-welcome h1{font-size:27px;line-height:1.25;font-weight:700;letter-spacing:-.7px;overflow-wrap:anywhere}.home-welcome p{color:#687e73;font-size:15px;line-height:1.6;margin-top:7px}.home-resume{display:flex;align-items:center;gap:12px;padding:15px;background:#edf4ef;border:1px solid #c6dbce;border-radius:14px;margin-bottom:18px;min-height:77px}.resume-symbol{height:40px;width:40px;flex-shrink:0;display:grid;place-items:center;background:#dcebe1;color:#21664b;border-radius:12px}.home-resume>span:nth-child(2){flex:1;min-width:0}.home-resume strong{font-size:15px;font-weight:650;display:block;line-height:1.4}.home-resume small{display:block;font-size:13px;color:#5e7a69;margin-top:4px;line-height:1.5}.home-resume>svg{flex-shrink:0;color:#21664b}.home-modes{display:grid;gap:11px}.home-solo,.home-challenge{display:flex;align-items:center;gap:14px;border-radius:18px;padding:22px 18px;min-height:114px}.home-solo{color:#fff;background:#21664b;border:1px solid #21664b}.solo-symbol{width:51px;height:51px;display:grid;place-items:center;border-radius:15px;background:#ffffff1a;flex-shrink:0}.mode-copy{display:grid;gap:7px;min-width:0;flex:1}.mode-copy strong{font-size:20px;line-height:1.25;font-weight:650;letter-spacing:-.35px}.mode-copy>span{font-size:14px;line-height:1.5}.home-solo .mode-copy>span{color:#d3e7dc}.home-solo>svg,.home-challenge>svg{flex-shrink:0}.home-challenge{color:#244d9e;background:#eaf0fc;border:1px solid #d2def6;padding-block:17px;min-height:94px}.challenge-symbol{height:45px;width:45px;flex-shrink:0;display:grid;place-items:center;color:#315ed2;background:#dce6fa;border-radius:13px}.home-challenge .mode-copy strong{font-size:18px;letter-spacing:-.3px}.home-challenge .mode-copy>span{color:#59729a;font-size:13px}.home-numbers{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border:1px solid #dfe8e2;border-radius:15px;background:#fff;padding:19px 0;margin:21px 0 28px}.home-numbers>div{text-align:center;padding:0 8px;border-right:1px solid #e5ece7;min-width:0}.home-numbers>div:last-child{border:0}.home-numbers strong{font-size:23px;line-height:1.3;font-weight:700;letter-spacing:-.65px;font-variant-numeric:tabular-nums}.home-numbers strong small{font-size:16px;font-weight:500;letter-spacing:0}.home-numbers span{display:block;font-size:13px;color:#71847a;margin-top:4px}.chapter-list-heading{display:flex;align-items:center;justify-content:space-between;gap:15px;margin-bottom:13px}.chapter-list-heading h2{font-size:20px;font-weight:650;letter-spacing:-.4px}.chapter-list-heading>span{font-size:13px;color:#71847a;white-space:nowrap}.chapter-list{background:#fff;border:1px solid #dfe8e2;border-radius:17px;overflow:hidden}.home-chapter{display:flex;align-items:center;gap:13px;min-height:87px;padding:15px 16px;border-bottom:1px solid #e7ede8}.home-chapter:last-child{border:0}.chapter-emblem{height:43px;width:43px;flex-shrink:0;display:grid;place-items:center;background:#f2f5f0;border-radius:13px}.chapter-description{flex:1;min-width:0}.chapter-description strong{display:block;font-size:15px;font-weight:600;line-height:1.4;letter-spacing:-.15px}.chapter-description small{display:block;font-size:13px;color:#71847a;margin-top:5px;line-height:1.4}.home-chapter>svg{color:#84988d;flex-shrink:0}.chapter-empty{font-size:14px;color:#71847a;line-height:1.7;padding:17px 0}.home-mistakes{display:flex;gap:11px;align-items:center;background:#fff;border:1px solid #dfe8e2;border-radius:13px;padding:16px;margin-top:17px;color:#557365;font-size:14px;min-height:57px}.home-mistakes>span:first-of-type{flex:1}.mistake-count{font-size:13px;font-weight:650;background:#edf2ed;border-radius:6px;padding:2px 7px}.mobile-home a:focus-visible{outline:3px solid #21664b;outline-offset:4px}.home-solo:active,.home-challenge:active,.home-resume:active,.home-chapter:active{filter:brightness(.97)}@media(min-width:480px){.home-welcome h1{font-size:30px}.home-solo{min-height:120px;padding:24px}.home-challenge{padding-inline:23px}.home-chapter{padding-inline:20px}}@media(max-width:359px){.home-solo,.home-challenge{gap:11px;padding-inline:14px}.solo-symbol{width:43px;height:43px}.mode-copy strong{font-size:19px}.mode-copy>span{font-size:13px}.home-challenge .mode-copy strong{font-size:16px}.challenge-symbol{width:39px;height:39px}.home-chapter{padding-inline:12px;gap:11px}.chapter-emblem{height:39px;width:39px}.chapter-list-heading>span{font-size:13px}}
</style>
