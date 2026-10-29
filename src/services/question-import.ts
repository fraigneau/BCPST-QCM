import { DOMParser, XMLSerializer, type Element, type Node } from '@xmldom/xmldom'
import type { Chapter, Difficulty, QuestionInput } from '../../shared/types.ts'

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024
export type ImportedQuestion = QuestionInput & { id?: string }
export interface ImportRow {
  index: number
  title: string
  category: string
  originalId?: string
  question?: ImportedQuestion
  imageDataUrl?: string
  uploadedImage?: string
  warnings: string[]
  error?: string
}
export interface QuestionImportPlan { format: 'json' | 'moodle'; rows: ImportRow[] }
const children = (node: Node, name?: string): Element[] => Array.from(node.childNodes).filter((child): child is Element => child.nodeType === 1 && (!name || child.localName === name))
const child = (node: Node, name: string) => children(node, name)[0]
const text = (node: Node | undefined) => node?.textContent?.trim() ?? ''
const normalize = (value: string) => value.trim().toLocaleLowerCase('fr')

function boundedTree(root: Node) {
  const stack: [Node, number][] = [[root, 0]]
  let count = 0
  while (stack.length) {
    const [node, depth] = stack.pop()!
    if (++count > 100000 || depth > 64) throw new Error('Le document XML est trop complexe.')
    for (const item of Array.from(node.childNodes)) stack.push([item, depth + 1])
  }
}

function decodeImage(base64: string): string {
  const value = base64.replace(/\s/g, '')
  if (!value || value.length > 2796204 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('Illustration base64 invalide ou supérieure à 2 Mo.')
  const bytes = atob(value)
  if (!bytes.length || bytes.length > 2097152) throw new Error('L’illustration doit peser moins de 2 Mo.')
  const signature = [...bytes.slice(0, 12)].map(char => char.charCodeAt(0))
  const mime = signature.slice(0, 8).join() === '137,80,78,71,13,10,26,10' ? 'png'
    : signature[0] === 255 && signature[1] === 216 && signature[2] === 255 ? 'jpeg'
      : bytes.startsWith('RIFF') && bytes.slice(8, 12) === 'WEBP' ? 'webp' : null
  if (!mime) throw new Error('Seules les illustrations PNG, JPEG et WebP sont acceptées.')
  return `data:image/${mime};base64,${value}`
}

interface FieldText { value: string; images: string[] }
function field(element: Element | undefined): FieldText {
  if (!element) return { value: '', images: [] }
  const holder = child(element, 'text') ?? element
  const raw = children(holder).length ? Array.from(holder.childNodes).map(node => new XMLSerializer().serializeToString(node)).join('') : holder.textContent ?? ''
  const format = element.getAttribute('format') ?? 'html'
  if (format === 'plain_text') return { value: raw.trim(), images: [] }
  if (!['html', 'moodle_auto_format', 'markdown'].includes(format)) throw new Error(`Format de texte non pris en charge : ${format}.`)
  const doc = new DOMParser({ onError: () => { /* Le HTML exporté peut omettre les balises de fermeture. */ } }).parseFromString(`<html><body>${raw}</body></html>`, 'text/html')
  boundedTree(doc)
  const images: string[] = []
  function read(node: Node): string {
    if (node.nodeType === 3 || node.nodeType === 4) return node.nodeValue ?? ''
    if (node.nodeType !== 1 && node.nodeType !== 9) return ''
    const name = node.nodeType === 1 ? ((node as Element).localName ?? '').toLowerCase() : ''
    if (['script', 'style'].includes(name)) return ''
    if (['math', 'table', 'svg', 'iframe', 'object', 'embed', 'audio', 'video', 'canvas'].includes(name)) throw new Error('Tableau, formule MathML ou média non pris en charge : adapter cette question avant l’import.')
    if (name === 'a' && (node as Element).getAttribute('href')) throw new Error('Lien ou pièce jointe dans le texte : adapter cette question avant l’import.')
    if (name === 'img') {
      const src = (node as Element).getAttribute('src')
      if (!src) throw new Error('Illustration sans référence de fichier.')
      images.push(src.trim())
      return ' '
    }
    const content = Array.from(node.childNodes).map(read).join('')
    if (name === 'br') return '\n'
    if (name === 'sup') return `^(${content})`
    if (name === 'sub') return `_(${content})`
    return ['p', 'div', 'li', 'ul', 'ol', 'h1', 'h2', 'h3'].includes(name) ? `\n${content}\n` : content
  }
  return { value: read(doc).replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim(), images }
}

function validate(question: ImportedQuestion) {
  if (typeof question.chapterId !== 'string' || question.chapterId.length > 100) throw new Error('Chapitre invalide.')
  if (!['easy', 'medium', 'hard'].includes(question.difficulty)) throw new Error('Difficulté invalide.')
  if (typeof question.prompt !== 'string' || question.prompt.trim().length < 10 || question.prompt.length > 5000) throw new Error('L’énoncé doit contenir de 10 à 5 000 caractères.')
  if (!Array.isArray(question.options) || question.options.length !== 4) throw new Error('Le jeu exige exactement quatre propositions : aucune réponse n’a été ajoutée ou supprimée.')
  if (question.options.some(option => typeof option !== 'string' || !option.trim() || option.length > 1000) || new Set(question.options.map(normalize)).size !== 4) throw new Error('Les quatre propositions doivent être renseignées, distinctes et limitées à 1 000 caractères.')
  if (!Array.isArray(question.correctAnswers) || question.correctAnswers.length < 1 || question.correctAnswers.length > 4 || question.correctAnswers.some(answer => !Number.isInteger(answer) || answer < 0 || answer > 3) || new Set(question.correctAnswers).size !== question.correctAnswers.length) throw new Error('Les indices des bonnes réponses doivent être distincts, entre 0 et 3.')
  if (typeof question.explanation !== 'string' || question.explanation.trim().length < 10 || question.explanation.length > 10000) throw new Error('La correction doit contenir de 10 à 10 000 caractères.')
  if (!['solo', 'challenge'].includes(question.usage ?? 'solo')) throw new Error('Mode de question invalide.')
  if (question.usage === 'challenge' && (question.correctAnswers.length !== 1 || !question.sourceQuestionId)) throw new Error('Un QCS de défi doit avoir une bonne réponse et une question solo source.')
  if (question.usage !== 'challenge' && question.sourceQuestionId) throw new Error('Une question solo ne peut pas être une variante.')
  if (question.sourceQuestionId != null && (typeof question.sourceQuestionId !== 'string' || question.sourceQuestionId.length > 100)) throw new Error('Question source invalide.')
  if (question.image != null && (typeof question.image !== 'string' || question.image.length > 2048)) throw new Error('Référence d’image invalide.')
  if (question.id != null && (typeof question.id !== 'string' || !question.id || question.id.length > 100)) throw new Error('Identifiant de question invalide.')
}

function nativeJson(source: string, chapters: Chapter[]): QuestionImportPlan {
  let data: unknown
  try { data = JSON.parse(source) } catch { throw new Error('Ce fichier ne contient pas de JSON valide.') }
  if (!Array.isArray(data) || !data.length || data.length > 500) throw new Error('Le fichier doit contenir une liste de 1 à 500 questions.')
  const ids = new Set<string>()
  const rows: ImportRow[] = data.map((value: unknown, index) => {
    const row: ImportRow = { index: index + 1, title: `Question ${index + 1}`, category: '', warnings: [] }
    try {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Cette entrée n’est pas une question.')
      const q = value as ImportedQuestion
      row.originalId = typeof q.id === 'string' ? q.id : undefined
      row.title = typeof q.prompt === 'string' ? q.prompt.slice(0, 160) : row.title
      const question: ImportedQuestion = { id: q.id, usage: q.usage ?? 'solo', sourceQuestionId: q.sourceQuestionId ?? null, chapterId: q.chapterId, difficulty: q.difficulty, prompt: q.prompt, options: q.options, correctAnswers: q.correctAnswers, explanation: q.explanation, image: q.image ?? null, status: 'draft' }
      validate(question)
      if (!chapters.some(chapter => chapter.id === question.chapterId)) throw new Error('Le chapitre de cette question n’existe pas dans cette banque.')
      if (question.id && ids.has(question.id)) throw new Error('Identifiant dupliqué dans le fichier.')
      if (question.id) ids.add(question.id)
      row.question = question
    } catch (error) { row.error = (error as Error).message }
    return row
  })
  // Ne pas remapper une variante vers un doublon ou une source rejetée lors de la sélection.
  for (const row of rows) {
    const sourceId = row.question?.sourceQuestionId
    if (!sourceId) continue
    const sourceRows = rows.filter(other => other.originalId === sourceId)
    if (sourceRows.length && (sourceRows.length !== 1 || sourceRows[0]!.error || sourceRows[0]!.question?.usage !== 'solo' || sourceRows[0]!.question?.chapterId !== row.question?.chapterId)) row.error = 'La question solo source du fichier est incompatible.'
  }
  return { format: 'json', rows }
}

function moodle(source: string): QuestionImportPlan {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source)) throw new Error('Les déclarations DOCTYPE et ENTITY ne sont pas acceptées.')
  let doc
  try { doc = new DOMParser({ onError: () => { throw new Error('XML invalide') } }).parseFromString(source, 'application/xml') }
  catch { throw new Error('Ce fichier XML est mal formé. Exporte-le à nouveau depuis Moodle ou Pronote.') }
  boundedTree(doc)
  if (doc.documentElement?.localName !== 'quiz') throw new Error('Ce fichier n’est pas un export XML Moodle. Dans Pronote, choisis « XML compatible Moodle » : la racine <quiz> est attendue.')
  const elements = children(doc.documentElement)
  if (elements.some(element => element.localName !== 'question')) throw new Error('Le fichier contient des éléments inattendus dans <quiz>.')
  const questionElements = elements.filter(element => element.getAttribute('type') !== 'category')
  if (!questionElements.length || questionElements.length > 500) throw new Error('Le fichier doit contenir de 1 à 500 questions hors catégories.')
  let category = ''
  const rows: ImportRow[] = []
  for (const element of elements) {
    if (element.getAttribute('type') === 'category') {
      category = text(child(child(element, 'category') ?? element, 'text')).replace(/^\$[^$]+\$\/?/, '')
      if (category.length > 1000) throw new Error('Un nom de catégorie dépasse 1 000 caractères.')
      continue
    }
    const row: ImportRow = { index: rows.length + 1, title: text(child(child(element, 'name') ?? element, 'text')).slice(0, 160) || `Question ${rows.length + 1}`, category, warnings: [] }
    rows.push(row)
    try {
      const type = element.getAttribute('type')
      if (type !== 'multichoice') throw new Error(`Type « ${type || 'inconnu'} » non pris en charge. Seuls les QCM à quatre propositions sont importables.`)
      const questionText = child(element, 'questiontext')
      const prompt = field(questionText)
      const answers = children(element, 'answer')
      const answerFields = answers.map(answer => field(answer))
      if (answerFields.some(answer => answer.images.length)) throw new Error('Les images dans les propositions ne sont pas prises en charge.')
      const fractions = answers.map(answer => {
        const raw = answer.getAttribute('fraction')?.trim() ?? ''
        if (!/^-?\d+(?:[.,]\d+)?$/.test(raw)) throw new Error('Barème de réponse manquant ou invalide : les bonnes réponses ne peuvent pas être déduites.')
        const value = Number(raw.replace(',', '.'))
        if (value < -100 || value > 100) throw new Error('Une pondération de réponse est hors de la plage −100 à 100.')
        return value
      })
      const correctAnswers = fractions.flatMap((fraction, index) => fraction > 0 ? [index] : [])
      const single = text(child(element, 'single')).toLowerCase()
      if (single && !['true', 'false', '1', '0'].includes(single)) throw new Error('Le mode de réponse unique/multiple est invalide.')
      if ((single === 'true' || single === '1') && (correctAnswers.length !== 1 || fractions[correctAnswers[0]!] !== 100)) throw new Error('Ce QCM à réponse unique possède un barème partiel ou plusieurs réponses positives : conversion ambiguë.')
      const positives = fractions.filter(fraction => fraction > 0)
      if (positives.length && !positives.every(value => value === 100) && Math.abs(positives.reduce((sum, value) => sum + value, 0) - 100) > 0.05) throw new Error('Somme des pondérations positives ambiguë : adapter le barème avant l’import.')
      if (!single) row.warnings.push('Mode unique/multiple absent : bonnes réponses déduites des fractions positives.')
      if (fractions.some(fraction => fraction !== 0 && fraction !== 100)) row.warnings.push('Pondérations converties en réponses exactes : aucun point partiel ni pénalité Moodle.')
      const feedbackTypes = [['generalfeedback', ''], ['correctfeedback', 'Si la réponse est correcte'], ['partiallycorrectfeedback', 'Si la réponse est partielle'], ['incorrectfeedback', 'Si la réponse est incorrecte']] as const
      const feedbackElements = [...feedbackTypes.map(([name]) => child(element, name)), ...answers.map(answer => child(answer, 'feedback'))].filter((item): item is Element => !!item)
      if (feedbackElements.map(field).some(item => item.images.length)) throw new Error('Une illustration de correction ne peut pas être conservée dans le jeu actuel.')
      const feedback = feedbackTypes.map(([name, title]) => {
        const value = field(child(element, name)).value
        return value ? (title ? `${title} — ${value}` : value) : ''
      })
      const details = answers.map((answer, index) => {
        const value = field(child(answer, 'feedback')).value
        return value ? `${String.fromCharCode(65 + index)} — ${value}` : ''
      })
      const explanation = [...feedback, ...details].filter(Boolean).join('\n\n')
      const question: ImportedQuestion = { usage: 'solo', sourceQuestionId: null, chapterId: '', difficulty: 'medium', prompt: prompt.value, options: answerFields.map(answer => answer.value), correctAnswers, explanation: explanation.length >= 10 ? explanation : [explanation, 'Correction à compléter après import.'].filter(Boolean).join('\n\n'), image: null, status: 'draft' }
      if (explanation.length < 10) row.warnings.push('Correction absente ou trop courte : à compléter dans le brouillon avant publication.')
      const imageElement = child(element, 'image')
      const legacyImage = imageElement && !children(imageElement).length ? text(imageElement) : ''
      const references = [...new Set([...prompt.images, ...(legacyImage ? [legacyImage] : [])])]
      if (references.length > 1) throw new Error('Plusieurs illustrations sont référencées : le jeu accepte une illustration par question.')
      const embeddedLegacy = text(child(element, 'image_base64') ?? (imageElement ? child(imageElement, 'image_base64') : undefined))
      if (embeddedLegacy && !references.length) references.push('legacy')
      if (references.length) {
        const reference = references[0]!
        if (reference.startsWith('data:')) {
          const match = /^data:image\/(?:png|jpeg|webp);base64,([\s\S]+)$/i.exec(reference)
          if (!match) throw new Error('Illustration intégrée dans un format non pris en charge.')
          row.imageDataUrl = decodeImage(match[1]!)
        } else if (embeddedLegacy) row.imageDataUrl = decodeImage(embeddedLegacy)
        else {
          if (/^(?:[a-z]+:|\/\/)/i.test(reference)) throw new Error('Illustration distante : réexporte le QCM avec les images intégrées. Aucun fichier externe n’est téléchargé.')
          let path: string
          try { path = decodeURIComponent(reference.replace(/^@@PLUGINFILE@@\//, '').split(/[?#]/, 1)[0]!).replace(/^\//, '') } catch { throw new Error('Référence d’illustration invalide.') }
          const files = questionText ? children(questionText, 'file') : []
          const file = files.find(file => `${file.getAttribute('path') ?? '/'}${file.getAttribute('name') ?? ''}`.replace(/^\//, '') === path)
          if (!file || file.getAttribute('encoding') !== 'base64') throw new Error('Illustration absente du XML ou non encodée en base64.')
          row.imageDataUrl = decodeImage(text(file))
        }
      }
      validate(question)
      row.question = question
    } catch (error) { row.error = (error as Error).message }
  }
  return { format: 'moodle', rows }
}

export function parseQuestionImport(source: string, chapters: Chapter[]): QuestionImportPlan {
  if (new TextEncoder().encode(source).byteLength > MAX_IMPORT_BYTES) throw new Error('Le fichier doit peser moins de 5 Mo.')
  const value = source.replace(/^\uFEFF/, '').trim()
  if (!value) throw new Error('Le fichier est vide.')
  return value.startsWith('<') ? moodle(value) : nativeJson(value, chapters)
}

export function importPayload(plan: QuestionImportPlan, selected: number[], mapping: Record<string, string>, difficulty: Difficulty, chapters: Chapter[]): ImportedQuestion[] {
  const rows = plan.rows.filter(row => selected.includes(row.index))
  if (!rows.length || rows.length > 500) throw new Error('Sélectionne de 1 à 500 questions compatibles.')
  return rows.map(row => {
    if (row.error || !row.question) throw new Error('Une question sélectionnée est incompatible.')
    if (plan.format === 'json' && row.question.sourceQuestionId && plan.rows.some(other => other.originalId === row.question!.sourceQuestionId) && !rows.some(other => other.question?.id === row.question!.sourceQuestionId && !other.error)) throw new Error('Sélectionne aussi la question solo source présente dans le fichier.')
    const question = { ...row.question, image: row.uploadedImage ?? row.question.image, status: 'draft' as const }
    if (plan.format === 'moodle') { question.chapterId = mapping[row.category] ?? ''; question.difficulty = difficulty }
    if (!chapters.some(chapter => chapter.id === question.chapterId)) throw new Error('Choisis un chapitre existant pour chaque catégorie sélectionnée.')
    validate(question)
    return question
  })
}
