export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,23}$/
export const USERNAME_HELP = 'Choisis un pseudo de 3 à 24 caractères : lettres sans accent, chiffres, point, tiret ou _. Commence par une lettre ou un chiffre.'

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase()
}

export function usernameBase(value: string): string {
  const base = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '.').replace(/^[^a-z0-9]+/, '').slice(0, 24)
  return base.length >= 3 ? base : 'membre'
}
