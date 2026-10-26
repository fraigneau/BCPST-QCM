<script setup lang="ts">
import { Dna, Leaf, HeartPulse, Mountain, Sprout } from './icons'
defineProps<{ id: string; size?: number }>()
const icons: Record<string, typeof Dna> = { cellulaire: Dna, vegetale: Leaf, physiologie: HeartPulse, geologie: Mountain, ecologie: Sprout }
</script>

<template><component :is="icons[id] || Leaf" :size="size || 24" :stroke-width="1.6" aria-hidden="true" /></template>
