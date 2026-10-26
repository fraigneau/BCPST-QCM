<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ArrowRight } from '../components/icons'
import { api, session } from '../services/api'
import type { LeaderboardRow } from '../../shared/types'
import ChapterIcon from '../components/ChapterIcon.vue'

const chapter = ref(session.bootstrap?.chapters[0]?.id || 'cellulaire')
const rows = ref<LeaderboardRow[]>([])
const loading = ref(true)
const error = ref('')
const search = ref('')
const filtered = computed(() => rows.value.filter(row => row.name.toLocaleLowerCase('fr').includes(search.value.trim().toLocaleLowerCase('fr'))))
const me = computed(() => rows.value.find(row => row.userId === session.user?.id))
let request = 0
async function load() {
  const current = ++request
  loading.value = true
  error.value = ''
  try { const result = await api<LeaderboardRow[]>(`/leaderboard?chapterId=${encodeURIComponent(chapter.value)}`); if (current === request) rows.value = result }
  catch (cause) { if (current === request) error.value = (cause as Error).message }
  finally { if (current === request) loading.value = false }
}
function initials(name: string) { return name.trim().split(/\s+/).map(part => part[0]).slice(0, 2).join('').toUpperCase() }
onMounted(load)
watch(chapter, load)
</script>

<template>
  <div class="mobile-leaderboard">
    <header class="screen-heading"><h1>Classement</h1><p>Vos points, chapitre par chapitre.</p></header>
    <nav class="chapter-filter" aria-label="Choisir un chapitre"><button v-for="item in session.bootstrap?.chapters" :key="item.id" type="button" :class="{ selected: chapter === item.id }" :aria-pressed="chapter === item.id" @click="chapter = item.id"><ChapterIcon :id="item.id" :size="18" />{{ item.shortName }}</button></nav>
    <p v-if="loading" class="screen-state" role="status">Chargement du classement…</p>
    <div v-else-if="error" class="screen-state"><p class="error-copy" role="alert">{{ error }}</p><button class="retry-action" @click="load">Réessayer</button></div>
    <template v-else>
      <section v-if="me" class="personal-rank" aria-label="Votre classement"><div><span>Votre place</span><strong>#{{ me.rank }}</strong></div><div><span>Vos points</span><strong>{{ me.points.toLocaleString('fr-FR') }}</strong></div><div><span>Précision</span><strong>{{ me.accuracy }}<small> %</small></strong></div></section>
      <section class="players-section" aria-labelledby="players-title">
        <div class="list-heading"><h2 id="players-title">Les joueurs</h2><span>{{ rows.length }} au classement</span></div>
        <label class="player-search">Rechercher un joueur<input v-model="search" type="search" placeholder="Nom du joueur" autocomplete="off"></label>
        <ol v-if="filtered.length" class="player-list">
          <li v-for="row in filtered" :key="row.userId" :class="{ 'current-player': row.userId === session.user?.id }">
            <span class="player-position" :aria-label="`Position ${row.rank}`">{{ row.rank }}</span><span class="player-avatar" aria-hidden="true">{{ initials(row.name) }}</span>
            <div class="player-info"><strong>{{ row.name }}<span v-if="row.userId === session.user?.id" class="you-label">Vous</span></strong><span>{{ row.answered }} réponses · {{ row.accuracy }} % justes</span></div>
            <span class="player-points"><strong>{{ row.points.toLocaleString('fr-FR') }}</strong><small>points</small></span>
          </li>
        </ol>
        <div v-else class="empty-list"><p>{{ search ? 'Aucun joueur ne correspond à ce nom.' : 'Aucun joueur pour ce chapitre pour le moment.' }}</p><button v-if="search" class="retry-action" @click="search = ''">Effacer la recherche</button></div>
      </section>
      <RouterLink :to="{ path: '/practice', query: { chapter } }" class="practice-link">Réviser ce chapitre<ArrowRight :size="19" /></RouterLink>
      <p class="scoring-note">Solo : 100 points par bonne réponse. Défi : jusqu’à 50 points de rapidité en plus. À points et précision égaux, la place est partagée.</p>
    </template>
  </div>
</template>

<style scoped>
.mobile-leaderboard{display:flex;flex-direction:column;gap:22px;min-width:0;color:#17382e;font-size:16px}.screen-heading h1{font-family:inherit;font-size:28px;font-weight:700;letter-spacing:-.8px;line-height:1.2;margin:0 0 7px}.screen-heading p{font-size:15px;line-height:1.5;color:#5a7065;margin:0}.chapter-filter{display:flex;align-items:center;gap:8px;overflow-x:auto;max-width:100%;min-width:0;padding:3px 2px 8px;scrollbar-width:thin;scrollbar-color:#ccdcd2 transparent}.chapter-filter button{display:flex;flex:0 0 auto;align-items:center;gap:8px;min-height:45px;padding:10px 13px;border:1px solid #dfe8e2;border-radius:12px;background:#fff;color:#52695c;font-family:inherit;font-size:13px;font-weight:600;white-space:nowrap;cursor:pointer}.chapter-filter button.selected{background:#21664b;border-color:#21664b;color:#fff}.chapter-filter button>svg{flex-shrink:0}.personal-rank{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));background:#e8f1eb;border:1px solid #d4e4da;border-radius:17px;padding:19px 6px}.personal-rank>div{display:flex;flex-direction:column;gap:7px;align-items:center;min-width:0;border-right:1px solid #cbddd0}.personal-rank>div:last-child{border-right:0}.personal-rank span{font-size:12px;color:#52695c}.personal-rank strong{font-size:22px;line-height:1.2;font-weight:700;letter-spacing:-.5px;font-variant-numeric:tabular-nums}.personal-rank small{font-size:15px}.list-heading{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:16px}.list-heading h2{font-family:inherit;font-size:18px;line-height:1.3;letter-spacing:-.3px;margin:0}.list-heading>span{font-size:12px;color:#5a7065;white-space:nowrap}.player-search{display:block;font-size:13px;font-weight:600}.player-search input{display:block;box-sizing:border-box;width:100%;min-height:48px;margin-top:8px;border:1px solid #dfe8e2;border-radius:12px;padding:12px 14px;background:#fff;color:#17382e;font-family:inherit;font-size:16px;font-weight:400}.player-search input::placeholder{color:#7c9084}.player-list{list-style:none;padding:0;margin:16px 0 0;border:1px solid #dfe8e2;border-radius:17px;overflow:hidden;background:#fff}.player-list li{display:flex;align-items:center;gap:10px;min-height:85px;padding:14px 12px;border-bottom:1px solid #e6ede8;box-sizing:border-box}.player-list li:last-child{border-bottom:0}.player-list li.current-player{background:#edf5ef;box-shadow:inset 3px 0 #21664b}.player-position{flex:0 0 22px;text-align:center;font-size:14px;font-weight:600;color:#647c6e;font-variant-numeric:tabular-nums}.player-avatar{display:grid;place-items:center;flex:0 0 37px;height:37px;border-radius:50%;background:#eff3f0;color:#486351;font-size:12px;font-weight:700}.current-player .player-avatar{background:#dcebe0;color:#21664b}.player-info{flex:1;min-width:0}.player-info>strong{display:block;font-size:14px;font-weight:600;line-height:1.45;overflow-wrap:anywhere}.you-label{display:inline-block;margin-left:6px;font-size:10px;color:#21664b;font-weight:500}.player-info>span{display:block;font-size:12px;line-height:1.5;color:#647c6e;margin-top:4px}.player-points{flex-shrink:0;text-align:right;min-width:40px;font-variant-numeric:tabular-nums}.player-points strong{display:block;font-size:16px;font-weight:700;line-height:1.2}.player-points small{display:block;font-size:11px;color:#647c6e;margin-top:5px}.practice-link,.retry-action{display:flex;align-items:center;justify-content:center;gap:12px;min-height:48px;box-sizing:border-box;padding:12px 16px;border:1px solid #ccdcd2;border-radius:12px;background:#fff;color:#21664b;font-family:inherit;font-size:15px;font-weight:600;text-decoration:none;cursor:pointer}.screen-state,.empty-list{background:#fff;border:1px solid #dfe8e2;border-radius:16px;padding:27px 20px;text-align:center;color:#5a7065;font-size:15px;line-height:1.6;margin:0}.screen-state p,.empty-list p{margin:0 0 16px}.empty-list{margin-top:16px}.error-copy{color:#943c34}.screen-state button,.empty-list button{margin:0 auto}.scoring-note{font-size:13px;color:#647c6e;line-height:1.65;margin:-5px 0 0}.mobile-leaderboard :is(button,input,a):focus-visible{outline:3px solid #7797e7;outline-offset:3px}@media(max-width:350px){.player-list li{gap:7px;padding-left:8px;padding-right:10px}.player-avatar{flex-basis:30px;height:30px;font-size:10px}.player-info>span{font-size:11px}.player-position{flex-basis:18px}.player-info>strong{font-size:13px}}
</style>
