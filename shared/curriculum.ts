import type { Chapter, Question, SchoolYear, SchoolYearFilter } from './types.ts'

export const schoolYears = [{ value: 'BCPST1', label: 'BCPST1' }, { value: 'BCPST2', label: 'BCPST2' }, { value: 'both', label: 'Les deux années' }] as const
export function schoolYearLabel(year?: SchoolYear) { return schoolYears.find(item => item.value === year)?.label ?? 'Les deux années' }
export function matchesSchoolYear(year: SchoolYear | undefined, selected: SchoolYearFilter = 'all') { return selected === 'all' || (year ?? 'both') === 'both' || year === selected }

export function selectedChapterIds(chapters: Chapter[], selected: string[]): string[] {
  if (!selected.length) return chapters.map(chapter => chapter.id)
  return [...new Set(chapters.filter(chapter => selected.includes(chapter.id) || (chapter.parentId && selected.includes(chapter.parentId))).map(chapter => chapter.id))]
}
export function chapterLabel(chapters: Chapter[], id: string): string {
  const chapter = chapters.find(item => item.id === id)
  const parent = chapters.find(item => item.id === chapter?.parentId)
  return chapter ? (parent ? `${parent.name} → ${chapter.name}` : chapter.name) : id
}
export function orderedChapters(chapters: Chapter[]): Chapter[] {
  return chapters.filter(chapter => !chapter.parentId).flatMap(parent => [parent, ...chapters.filter(child => child.parentId === parent.id)])
}
export function chapterCount(chapters: Chapter[], counts: Record<string, number>, id: string) { return selectedChapterIds(chapters, [id]).reduce((sum, key) => sum + (counts[key] ?? 0), 0) }
