import { readSupabaseConfiguration } from '../src/services/supabase-config.ts'

try {
  const configuration = readSupabaseConfiguration(process.env)
  const response = await fetch(`${configuration.url}/auth/v1/settings`, {
    headers: { apikey: configuration.publishableKey },
    signal: AbortSignal.timeout(15_000),
  })

  if (!response.ok) throw new Error(`Supabase refuse la vérification (HTTP ${response.status}). Vérifiez l’URL, la clé publique et l’état du projet.`)
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('application/json')) throw new Error('La réponse reçue n’est pas celle attendue du service Supabase Auth.')
  const settings: unknown = await response.json()
  if (!settings || typeof settings !== 'object' || !('external' in settings)) throw new Error('Le service contacté ne renvoie pas les réglages attendus de Supabase Auth.')

  console.log(`Projet contacté : ${configuration.url}`)
  console.log('Supabase Auth répond correctement avec la clé publique configurée.')
  console.log('Ce contrôle ne valide pas les tables, les permissions ni les parcours de connexion de QCM BCPST. Leur migration reste à réaliser.')
} catch (error) {
  const message = error instanceof Error ? error.message : 'Erreur inconnue.'
  console.error(`Vérification Supabase impossible : ${message}`)
  process.exitCode = 1
}
