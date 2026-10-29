<script setup lang="ts">
import { computed } from 'vue'
import { Check } from './icons'
import { chapterCount } from '../../shared/curriculum'
import type { Chapter } from '../../shared/types'
const props = defineProps<{ chapters: Chapter[]; counts: Record<string, number>; modelValue: string[]; disabled?: boolean; unit?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>()
const groups = computed(() => props.chapters.filter(chapter => !chapter.parentId).map(parent => ({ parent, children: props.chapters.filter(child => child.parentId === parent.id) })))
function toggle(id: string) {
  const descendants = props.chapters.filter(chapter => chapter.parentId === id).map(chapter => chapter.id)
  emit('update:modelValue', props.modelValue.includes(id) ? props.modelValue.filter(value => value !== id) : [...props.modelValue.filter(value => !descendants.includes(value)), id])
}
</script>

<template>
  <div class="chapter-tree-picker">
    <button type="button" class="chapter-choice" :class="{ chosen: !modelValue.length }" :aria-pressed="!modelValue.length" :disabled="disabled" @click="emit('update:modelValue', [])"><span>Tous les chapitres</span><Check v-if="!modelValue.length" :size="18" /></button>
    <ul class="chapter-groups" aria-label="Chapitres">
      <li v-for="group in groups" :key="group.parent.id" class="chapter-group">
        <button type="button" class="chapter-choice parent-choice" :class="{ chosen: modelValue.includes(group.parent.id) }" :aria-pressed="modelValue.includes(group.parent.id)" :disabled="disabled" @click="toggle(group.parent.id)"><span><strong>{{ group.parent.name }}</strong><small>{{ chapterCount(chapters, counts, group.parent.id) }} {{ unit || 'questions' }}<template v-if="group.children.length"> · Sous-chapitres inclus</template></small></span><Check v-if="modelValue.includes(group.parent.id)" :size="18" /></button>
        <ul v-if="group.children.length" class="chapter-children" :aria-label="`Sous-chapitres de ${group.parent.name}`">
          <li v-for="child in group.children" :key="child.id"><button type="button" class="chapter-choice child-choice" :class="{ chosen: modelValue.includes(child.id), included: modelValue.includes(group.parent.id) }" :aria-pressed="modelValue.includes(child.id) || modelValue.includes(group.parent.id)" :disabled="disabled || modelValue.includes(group.parent.id)" @click="toggle(child.id)"><span><strong>{{ child.name }}</strong><small>{{ counts[child.id] || 0 }} {{ unit || 'questions' }}<template v-if="modelValue.includes(group.parent.id)"> · Inclus avec le chapitre</template></small></span><Check v-if="modelValue.includes(child.id) || modelValue.includes(group.parent.id)" :size="16" /></button></li>
        </ul>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.chapter-tree-picker{display:grid;gap:10px}.chapter-groups,.chapter-children{list-style:none;margin:0;padding:0}.chapter-groups{display:grid;gap:12px}.chapter-group{border:1px solid #dfe8e2;border-radius:12px;background:white;overflow:hidden}.chapter-choice{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;min-width:0;text-align:left;font:inherit;color:#17382e;background:white;border:1px solid #dfe8e2;border-radius:10px;padding:13px 15px;cursor:pointer}.parent-choice{border:0;border-radius:0}.chapter-choice>span{min-width:0}.chapter-choice strong{display:block;font-size:15px;line-height:1.4;overflow-wrap:anywhere}.chapter-choice small{display:block;color:#687e73;font-size:13px;line-height:1.5;margin-top:4px}.chapter-choice>svg{flex-shrink:0}.chapter-choice.chosen{background:#eaf2ec;box-shadow:inset 0 0 0 2px #21664b;color:#21664b}.chapter-children{margin:0 12px 12px 24px;padding-left:12px;border-left:2px solid #cbded0;display:grid;gap:5px}.child-choice{border:0;border-radius:8px;min-height:60px;padding:10px 12px}.child-choice strong{font-size:14px;font-weight:500}.child-choice.included{background:#f1f6f2;color:#496459;opacity:1}.chapter-choice:focus-visible{outline:3px solid #87ac96;outline-offset:-3px}.chapter-choice:disabled{cursor:default}
</style>
