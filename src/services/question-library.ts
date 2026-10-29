import type { Question } from '../../shared/types.ts'

export interface LibraryFilters { usage?: string; chapterId?: string; status?: string; difficulty?: string; search?: string }

function searchable(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('fr').trim()
}

export function filterLibraryQuestions(questions: Question[], filters: LibraryFilters): Question[] {
  const search = searchable(filters.search ?? '')
  return questions.filter(question =>
    (!filters.usage || (question.usage ?? 'solo') === filters.usage)
    && (!filters.chapterId || question.chapterId === filters.chapterId)
    && (!filters.status || question.status === filters.status)
    && (!filters.difficulty || question.difficulty === filters.difficulty)
    && (!search || searchable(`${question.prompt} ${question.explanation}`).includes(search)),
  ).sort((first, second) => second.updatedAt.localeCompare(first.updatedAt) || first.id.localeCompare(second.id))
}
