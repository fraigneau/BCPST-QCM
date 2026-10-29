import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseQuestionImport, importPayload, MAX_IMPORT_BYTES } from '../src/services/question-import.ts'
import type { Chapter } from '../shared/types.ts'
const chapters: Chapter[] = [{ id: 'cell', name: 'Chapitre 1 — Cellules', shortName: 'Cellules', description: '', color: '#648c5f', icon: 'Leaf' }, { id: 'org', name: 'Chapitre 2 — Organites', shortName: 'Organites', description: '', color: '#648c5f', icon: 'Leaf' }]
const fixture = readFileSync(new URL('./fixtures/moodle-pronote.xml', import.meta.url), 'utf8')
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const basic = `<question type="multichoice"><name><text>Test</text></name><questiontext format="html"><text><![CDATA[<p>Quelle proposition décrit la cellule ?</p>]]></text></questiontext><single>true</single>${['Réponse A', 'Réponse B', 'Réponse C', 'Réponse D'].map((value, index) => `<answer fraction="${index === 0 ? 100 : 0}"><text>${value}</text></answer>`).join('')}</question>`
const parse = (question: string) => parseQuestionImport(`<quiz>${question}</quiz>`, chapters)
const first = (question: string) => parse(question).rows[0]!

test('XML Moodle/Pronote : catégories, CDATA, HTML, bonnes réponses et corrections sont conservés en brouillons solo', () => {
  const result = parseQuestionImport('\uFEFF' + fixture, chapters)
  assert.equal(result.format, 'moodle')
  assert.equal(result.rows.length, 2)
  assert.equal(result.rows[0]!.error, undefined)
  assert.equal(result.rows[0]!.category, 'Chapitre 1 — Cellules')
  assert.equal(result.rows[1]!.category, 'Chapitre 2 — Organites')
  assert.equal(result.rows[0]!.question!.prompt, 'Quelles structures composent une membrane cellulaire ?')
  assert.deepEqual(result.rows[0]!.question!.correctAnswers, [0, 1])
  assert.match(result.rows[0]!.question!.explanation, /bicouche lipidique/)
  assert.match(result.rows[0]!.question!.explanation, /A — Ils forment la bicouche/)
  assert.match(result.rows[0]!.question!.explanation, /B — Elles remplissent/)
  assert.ok(result.rows[0]!.warnings.some(value => value.includes('Pondérations')))
  assert.equal(result.rows[1]!.question!.usage, 'solo')
  assert.equal(result.rows[1]!.question!.sourceQuestionId, null)
  assert.match(result.rows[1]!.question!.explanation, /Correction à compléter/)
  assert.ok(result.rows[1]!.warnings.some(value => value.includes('Correction absente')))
  assert.equal(result.rows[1]!.imageDataUrl, `data:image/png;base64,${png}`)
  const input = importPayload(result, [1, 2], { 'Chapitre 1 — Cellules': 'cell', 'Chapitre 2 — Organites': 'org' }, 'hard', chapters)
  assert.deepEqual(input.map(q => [q.chapterId, q.difficulty, q.status, q.usage]), [['cell', 'hard', 'draft', 'solo'], ['org', 'hard', 'draft', 'solo']])
})

test('les chapitres doivent être explicitement associés et seuls les éléments sélectionnés sont préparés', () => {
  const result = parseQuestionImport(fixture, chapters)
  assert.throws(() => importPayload(result, [1, 2], {}, 'easy', chapters), /Choisis un chapitre/)
  assert.throws(() => importPayload(result, [], {}, 'easy', chapters), /Sélectionne/)
  const payload = importPayload(result, [1], { 'Chapitre 1 — Cellules': 'cell' }, 'easy', chapters)
  assert.equal(payload.length, 1)
  assert.equal(result.rows[0]!.question!.chapterId, '')
  assert.equal(result.rows[0]!.question!.difficulty, 'medium')
  result.rows[1]!.uploadedImage = '/uploads/11111111-1111-4111-8111-111111111111.png'
  assert.equal(importPayload(result, [2], { 'Chapitre 2 — Organites': 'org' }, 'medium', chapters)[0]!.image, result.rows[1]!.uploadedImage)
})

test('les barèmes ambigus ne sont pas transformés en réponses inventées', () => {
  for (const [value, message] of [[basic.replace('fraction="100"', 'fraction="50"'), /barème partiel/], [basic.replace('fraction="0"', 'fraction="100"'), /conversion ambiguë/], [basic.replace('fraction="100"', ''), /Barème de réponse/], [basic.replace('fraction="100"', 'fraction="101"'), /hors de la plage/], [basic.replace('<single>true</single>', '<single>parfois</single>'), /mode de réponse/]] as const) assert.match(first(value).error!, message)
  const multiple = first(basic.replace('<single>true</single>', '').replace('fraction="100"', 'fraction="50"').replace('fraction="0"', 'fraction="50"'))
  assert.deepEqual(multiple.question!.correctAnswers, [0, 1])
  assert.ok(multiple.warnings.some(value => value.includes('absent')))
  assert.match(first(basic.replace('<single>true</single>', '<single>false</single>').replace('fraction="0"', 'fraction="50"')).error!, /Somme des pondérations/)
})

test('les types et nombres de choix incompatibles restent visibles avec leurs motifs', () => {
  const result = parse(basic + basic.replace('type="multichoice"', 'type="truefalse"') + basic.replace(/<answer fraction="0"><text>Réponse D<\/text><\/answer>/, ''))
  assert.equal(result.rows.length, 3)
  assert.equal(result.rows[0]!.error, undefined)
  assert.match(result.rows[1]!.error!, /truefalse/)
  assert.match(result.rows[2]!.error!, /quatre propositions/)
  assert.throws(() => importPayload(result, [1, 2], { '': 'cell' }, 'medium', chapters), /incompatible/)
  assert.equal(importPayload(result, [1], { '': 'cell' }, 'medium', chapters).length, 1)
  assert.match(first(basic.replace('Réponse D', 'réponse a')).error!, /distinctes/)
})

test('les XML mal formés, racines étrangères, DTD et entités sont refusés sans accès externe', () => {
  for (const value of ['<quiz><question></quiz>', '<quiz><question type="multichoice" type="essay"/></quiz>', '<quiz><question>&unknown;</question></quiz>']) assert.throws(() => parseQuestionImport(value, chapters), /mal formé/)
  assert.throws(() => parseQuestionImport('<html/>', chapters), /racine <quiz>/)
  assert.throws(() => parseQuestionImport('<quiz><script/></quiz>', chapters), /éléments inattendus/)
  assert.throws(() => parseQuestionImport('<!DOCTYPE quiz SYSTEM "https://external.invalid/x"><quiz/>', chapters), /DOCTYPE/)
  assert.throws(() => parseQuestionImport('<!DOCTYPE quiz [<!ENTITY x SYSTEM "file:///etc/passwd">]><quiz/>', chapters), /DOCTYPE/)
})

test('une illustration intégrée est reconnue sans charger d’URL distante ; les médias perdus sont refusés', () => {
  const image = `<img src="@@PLUGINFILE@@/figure.png"/>`
  const withImage = basic.replace('</p>]]>', `</p>${image}]]>`).replace('</questiontext>', `<file name="figure.png" encoding="base64">${png}</file></questiontext>`)
  assert.equal(first(withImage).imageDataUrl, `data:image/png;base64,${png}`)
  assert.equal(first(withImage.replace('figure.png"/>', 'figure.png?time=123#image"/>')).imageDataUrl, `data:image/png;base64,${png}`)
  assert.match(first(withImage.replace('figure.png"/>', 'absente.png"/>')).error!, /absente du XML/)
  assert.match(first(withImage.replace(image, '<img src="https://external.invalid/x.png"/>')).error!, /distante/)
  assert.match(first(withImage.replace(image, image + '<img src="other.png"/>')).error!, /Plusieurs illustrations/)
  assert.match(first(withImage.replace(png, btoa('<svg/>'))).error!, /PNG, JPEG et WebP/)
  assert.match(first(withImage.replace(png, '%%%')).error!, /base64/)
  assert.match(first(basic.replace('Réponse A</text>', '&lt;img src="x.png"/&gt;</text>')).error!, /images dans les propositions/)
  assert.match(first(basic.replace('</p>]]>', '</p><a href="@@PLUGINFILE@@/audio.mp3">Écouter</a>]]>')).error!, /pièce jointe/)
  assert.match(first(basic.replace('</p>]]>', '</p><table><tr><td>Important</td></tr></table>]]>')).error!, /Tableau/)
  const legacy = first(basic.replace('</question>', `<image>figure.png</image><image_base64>${png}</image_base64></question>`))
  assert.equal(legacy.imageDataUrl, `data:image/png;base64,${png}`)
})

test('le contenu HTML importé devient du texte et les indices scientifiques restent lisibles', () => {
  const row = first(basic.replace('Quelle proposition décrit la cellule ?', 'Quelle structure contient CO<sub>2</sub> et x<sup>2</sup> ?<script>globalThis.importScriptExecuted=true</script>'))
  assert.equal(row.error, undefined)
  assert.match(row.question!.prompt, /CO_\(2\).*x\^\(2\)/)
  assert.ok(!row.question!.prompt.includes('<script>'))
  assert.equal((globalThis as Record<string, unknown>).importScriptExecuted, undefined)
  const feedback = first(basic.replace('</question>', '<correctfeedback><text>La réponse correcte rappelle une propriété du cours.</text></correctfeedback></question>'))
  assert.match(feedback.question!.explanation, /Si la réponse est correcte/)
})

test('les bornes de taille, de profondeur et de nombre empêchent un import excessif', () => {
  assert.throws(() => parseQuestionImport(' '.repeat(MAX_IMPORT_BYTES + 1), chapters), /5 Mo/)
  assert.throws(() => parseQuestionImport('', chapters), /vide/)
  assert.throws(() => parse(`<question type="category"><category><text>Catégorie</text></category></question>`), /1 à 500/)
  assert.throws(() => parse(basic.repeat(501)), /1 à 500/)
  assert.throws(() => parseQuestionImport('<quiz>' + '<a>'.repeat(65) + '</a>'.repeat(65) + '</quiz>', chapters), /trop complexe/)
  const huge = basic.replace('</p>]]>', `</p><img src="data:image/png;base64,${'A'.repeat(2796208)}"/>]]>`)
  assert.match(first(huge).error!, /2 Mo/)
})

test('l’import JSON historique conserve les liens et ignore les privilèges fournis dans le fichier', () => {
  const base = { id: 'source', chapterId: 'cell', difficulty: 'easy', prompt: 'Quelle proposition décrit la membrane ?', options: ['Lipides', 'Noyau', 'Golgi', 'Vacuole'], correctAnswers: [0], explanation: 'La membrane comprend une bicouche lipidique.', image: null, status: 'published', role: 'admin' }
  const result = parseQuestionImport(JSON.stringify([base, { ...base, id: 'variant', usage: 'challenge', sourceQuestionId: 'source' }]), chapters)
  assert.equal(result.format, 'json')
  const payload = importPayload(result, [1, 2], {}, 'hard', chapters)
  assert.equal(payload[0]!.status, 'draft')
  assert.equal(payload[0]!.difficulty, 'easy')
  assert.equal(payload[0]!.usage, 'solo')
  assert.equal(payload[1]!.sourceQuestionId, 'source')
  assert.equal('role' in payload[0]!, false)
  assert.throws(() => importPayload(result, [2], {}, 'easy', chapters), /Sélectionne aussi/)
  assert.equal(base.status, 'published')
  const bad = parseQuestionImport(JSON.stringify([null, { ...base, chapterId: 'absent' }, base, base]), chapters)
  assert.match(bad.rows[0]!.error!, /entrée/)
  assert.match(bad.rows[1]!.error!, /chapitre/)
  assert.match(bad.rows[3]!.error!, /dupliqué/)
  const invalidSource = parseQuestionImport(JSON.stringify([{ ...base, correctAnswers: [] }, { ...base, id: 'child', usage: 'challenge', sourceQuestionId: 'source' }]), chapters)
  assert.match(invalidSource.rows[1]!.error!, /source du fichier est incompatible/)
  const duplicateSource = parseQuestionImport(JSON.stringify([base, base, { ...base, id: 'child', usage: 'challenge', sourceQuestionId: 'source' }]), chapters)
  assert.match(duplicateSource.rows[2]!.error!, /source du fichier est incompatible/)
  assert.throws(() => parseQuestionImport('{}', chapters), /liste/)
  assert.throws(() => parseQuestionImport('not json', chapters), /JSON valide/)
})
