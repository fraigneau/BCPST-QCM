const defaultOrigins = ['https://qcm.fraigneau.fr', 'https://bcpst-qcm.pages.dev', 'http://localhost:5173', 'http://localhost:4173', 'http://127.0.0.1:5173', 'http://127.0.0.1:4173']

export function resolveAllowedOrigins(configuration?: string): string[] {
  return configuration === undefined ? [...defaultOrigins] : configuration.split(',').map(origin => origin.trim()).filter(Boolean)
}
