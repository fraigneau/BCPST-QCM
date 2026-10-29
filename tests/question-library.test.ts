import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Question } from '../shared/types.ts'
import { filterLibraryQuestions } from '../src/services/question-library.ts'

const base: Question = { id: 'cell', chapterId: 'cellulaire', difficulty: 'easy', prompt: 'À quoi sert la membrane cellulaire ?', options: ['A', 'B', 'C', 'D'], correctAnswers: [0], explanation: 'Elle délimite la cellule et contrôle les échanges.', image: null, status: 'published', authorId: 'admin', createdAt: '2026-10-01T12:00:00Z', updatedAt: '2026-10-01T12:00:00Z' }
const questions: Question[] = [base, { ...base, id: 'plant', chapterId: 'vegetale', status: 'pending', difficulty: 'hard', updatedAt: '2026-10-03T12:00:00Z' }, { ...base, id: 'cell-pending', status: 'pending', difficulty: 'hard', updatedAt: '2026-10-02T12:00:00Z' }]

test('un dossier et son export restent limités au chapitre et aux filtres sélectionnés', () => {
  assert.deepEqual(filterLibraryQuestions(questions, { chapterId: 'cellulaire', status: 'pending', difficulty: 'hard' }).map(question => question.id), ['cell-pending'])
  assert.deepEqual(filterLibraryQuestions(questions, { chapterId: 'geologie' }), [])
  assert.deepEqual(filterLibraryQuestions(questions, { chapterId: 'cellulaire', difficulty: 'medium' }), [])
})

test('la bibliothèque recherche les énoncés et corrections avec ou sans accents sans modifier les données', () => {
  const before = structuredClone(questions)
  assert.equal(filterLibraryQuestions(questions, { search: '  CONTROLE LES ECHANGES ' }).length, 3)
  assert.deepEqual(filterLibraryQuestions(questions, { chapterId: 'cellulaire', search: 'membrane' }).map(question => question.id), ['cell-pending', 'cell'])
  assert.deepEqual(filterLibraryQuestions(questions, { search: 'inexistant' }), [])
  assert.deepEqual(questions, before)
})


test('le filtre sépare les QCM solo historiques des variantes QCS de défi', () => {
  const library: Question[] = [base, { ...base, id: 'variant', usage: 'challenge', sourceQuestionId: base.id }]
  assert.deepEqual(filterLibraryQuestions(library, { usage: 'solo' }).map(q => q.id), [base.id])
  assert.deepEqual(filterLibraryQuestions(library, { usage: 'challenge' }).map(q => q.id), ['variant'])
  assert.equal(filterLibraryQuestions(library, {}).length, 2)
})
