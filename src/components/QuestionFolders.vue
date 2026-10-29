<script setup lang="ts">
import { computed } from 'vue'
import { ArrowRight } from './icons'
import { selectedChapterIds } from '../../shared/curriculum'
import type { Chapter, Question } from '../../shared/types'

const props = defineProps<{ chapters: Chapter[]; questions: Question[]; parentId?: string }>()
const emit = defineEmits<{ open: [chapterId: string] }>()

const folders = computed(() => {
  const counts = new Map<string, { total: number; published: number; pending: number; solo: number; challenge: number }>()
  for (const question of props.questions) {
    const count = counts.get(question.chapterId) || { total: 0, published: 0, pending: 0, solo: 0, challenge: 0 }
    count.total++
    if (question.usage === 'challenge') count.challenge++; else count.solo++
    if (question.status === 'published') count.published++
    if (question.status === 'pending') count.pending++
    counts.set(question.chapterId, count)
  }
  return props.chapters.filter(chapter => (chapter.parentId ?? undefined) === props.parentId).map(chapter => {
    const ids = selectedChapterIds(props.chapters, [chapter.id])
    const count = { total: 0, published: 0, pending: 0, solo: 0, challenge: 0 }
    for (const id of ids) { const own = counts.get(id); if (own) for (const key of Object.keys(count) as (keyof typeof count)[]) count[key] += own[key] }
    return { chapter, ...count }
  })
})

function folderLabel(folder: typeof folders.value[number]) {
  return `Ouvrir le chapitre ${folder.chapter.name}, ${folder.total} question${folder.total > 1 ? 's' : ''}, ${folder.published} publiée${folder.published > 1 ? 's' : ''}, ${folder.pending} à valider`
}
</script>

<template>
  <ul class="question-folders" aria-label="Chapitres de questions">
    <li v-for="folder in folders" :key="folder.chapter.id">
      <button type="button" class="folder-row" :aria-label="folderLabel(folder)" @click="emit('open', folder.chapter.id)">
        <span class="folder-symbol" aria-hidden="true">
          <svg width="42" height="38" viewBox="0 0 42 38" fill="none">
            <path d="M4 9a3 3 0 0 1 3-3h9l4 4h15a3 3 0 0 1 3 3v17a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V9Z" fill="currentColor" fill-opacity=".11" />
            <path d="M4 14V9a3 3 0 0 1 3-3h9l4 4h15a3 3 0 0 1 3 3v17a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V14Zm0 0h34" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </span>
        <span class="folder-copy">
          <strong>{{ folder.chapter.shortName || folder.chapter.name }}</strong>
          <span class="folder-total">{{ folder.total }} question{{ folder.total > 1 ? 's' : '' }}</span>
          <span class="folder-status">{{ folder.solo }} QCM solo · {{ folder.challenge }} QCS défi</span>
          <span class="folder-status">{{ folder.published }} publiée{{ folder.published > 1 ? 's' : '' }}<span aria-hidden="true"> · </span>{{ folder.pending }} à valider</span>
        </span>
        <ArrowRight class="folder-arrow" :size="20" />
      </button>
      <QuestionFolders v-if="!parentId && chapters.some(child => child.parentId === folder.chapter.id)" class="nested-folders" :chapters="chapters" :questions="questions" :parent-id="folder.chapter.id" @open="emit('open', $event)" />
    </li>
  </ul>
</template>

<style scoped>
.question-folders.nested-folders{margin:0 14px 14px 32px;padding-left:8px;border:0;border-left:2px solid #cbded0;border-radius:0}.nested-folders :deep(.folder-row){min-height:80px;padding:12px 8px}.nested-folders :deep(.folder-symbol){width:30px}.nested-folders :deep(.folder-symbol svg){width:30px}.nested-folders :deep(.folder-copy>strong){font-size:14px}

.question-folders{margin:0;padding:0;list-style:none;border:1px solid var(--line,#dfe8e2);border-radius:14px;background:#fff;overflow:hidden}.question-folders>li+li{border-top:1px solid var(--line,#dfe8e2)}.folder-row{display:flex;align-items:center;gap:13px;width:100%;min-height:106px;padding:17px 16px;border:0;background:transparent;color:var(--ink,#17382e);text-align:left;font:inherit;cursor:pointer;touch-action:manipulation}.folder-symbol{display:grid;place-items:center;flex-shrink:0;width:43px;color:var(--green,#21664b)}.folder-copy{display:flex;flex-direction:column;gap:4px;flex:1;min-width:0}.folder-copy>strong{font-size:16px;font-weight:600;line-height:1.4;letter-spacing:-.15px;overflow-wrap:anywhere}.folder-total{font-size:14px;line-height:1.5;color:var(--muted,#71847a)}.folder-status{font-size:13px;line-height:1.5;color:var(--muted,#71847a);overflow-wrap:anywhere}.folder-arrow{flex-shrink:0;color:var(--green,#21664b);opacity:.7}.folder-row:hover{background:#f5f8f5}.folder-row:active{background:#edf3ee}.folder-row:focus-visible{position:relative;z-index:1;outline:3px solid var(--green,#21664b);outline-offset:-4px;border-radius:10px}@media(max-width:359px){.folder-row{gap:10px;padding:16px 12px}.folder-symbol{width:36px}.folder-symbol svg{width:36px;height:34px}.folder-arrow{width:18px}}
</style>
