import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(root, 'dist')
const failures: string[] = []

function requireCondition(condition: unknown, message: string) {
  if (!condition) failures.push(message)
}

function read(path: string): string {
  try { return readFileSync(resolve(root, path), 'utf8') }
  catch { failures.push(`Fichier requis absent ou illisible : ${path}`); return '' }
}

function secretReason(content: string): string | null {
  if (/sb_secret_[A-Za-z0-9_-]{12,}/.test(content)) return 'clé secrète Supabase'
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content)) return 'clé privée'
  if (/(?:postgres|postgresql):\/\/[^\s"'<>]+:[^\s"'<>]+@/i.test(content)) return 'URL de connexion PostgreSQL avec mot de passe'
  for (const match of content.matchAll(/\beyJ[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+\b/g)) {
    try {
      const payload = JSON.parse(Buffer.from(match[1]!, 'base64url').toString('utf8')) as { role?: string }
      if (payload.role === 'service_role') return 'jeton service_role'
    } catch { }
  }
  return null
}

function inspect(path: string) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const target = join(path, entry.name)
    const name = relative(output, target).replaceAll('\\', '/')
    if (entry.isSymbolicLink()) { failures.push(`Lien symbolique interdit dans dist : ${name}`); continue }
    if (/(?:^|\/)(?:server|data|supabase|tests|node_modules|functions)(?:\/|$)/.test(name) || /(?:^|\/)\.env(?:\.|$)/.test(name) || /\.(?:sqlite(?:-wal|-shm)?|db|pem|key|sql|map)$/i.test(name) || name === '_worker.js') {
      failures.push(`Artefact privé ou serveur interdit dans dist : ${name}`)
      continue
    }
    if (entry.isDirectory()) { inspect(target); continue }
    if (!entry.isFile()) continue
    requireCondition(statSync(target).size <= 25 * 1024 * 1024, `Fichier trop volumineux pour Pages : ${name}`)
    if (!['.html', '.js', '.css', '.json', '.webmanifest', '.txt', '.svg'].includes(extname(name)) && !['_headers', '_redirects'].includes(name)) continue
    const content = readFileSync(target, 'utf8')
    const reason = secretReason(content)
    if (reason) failures.push(`Donnée privée détectée dans ${name} : ${reason}`)
    if (extname(name) === '.js' && /(?:node:sqlite|\bDatabaseSync\b|\bscryptSync\b|CREATE TABLE IF NOT EXISTS)/.test(content)) failures.push(`Code du backend Node.js détecté dans ${name}`)
  }
}

try {
  const configuration = JSON.parse(read('wrangler.jsonc')) as { name?: string; pages_build_output_dir?: string; compatibility_date?: string; main?: string; compatibility_flags?: string[] }
  requireCondition(configuration.name === 'qcm-bcpst', 'Le nom Pages doit être qcm-bcpst.')
  requireCondition(configuration.pages_build_output_dir === './dist', 'Pages doit publier uniquement ./dist.')
  requireCondition(/^\d{4}-\d{2}-\d{2}$/.test(configuration.compatibility_date || ''), 'La date de compatibilité doit être explicite.')
  requireCondition(!configuration.main && !configuration.compatibility_flags?.includes('nodejs_compat'), 'Ce site statique ne doit pas embarquer un Worker Node.js.')
} catch { failures.push('wrangler.jsonc doit être un JSON valide sans commentaires.') }

const backend = process.env.VITE_BACKEND?.trim() || 'supabase'
requireCondition(backend === 'supabase', 'Un build Pages exige VITE_BACKEND=supabase ; le mode local nécessite le serveur Node.js.')
requireCondition(/^24(?:\.\d+){0,2}$/.test(read('.node-version').trim()), '.node-version doit sélectionner Node.js 24.')
const configuredUrl = process.env.VITE_SUPABASE_URL?.trim() || ''
let origin = ''
try {
  const url = new URL(configuredUrl)
  requireCondition(url.protocol === 'https:' && url.hostname.endsWith('.supabase.co') && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash, 'Le déploiement Pages attend une URL HTTPS de projet *.supabase.co, sans chemin ni identifiants.')
  origin = url.origin
} catch { failures.push('VITE_SUPABASE_URL doit être renseignée avec l’URL HTTPS du projet.') }
const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() || ''
requireCondition(/^sb_publishable_[A-Za-z0-9_-]+$/.test(key), 'VITE_SUPABASE_PUBLISHABLE_KEY doit contenir une clé publique sb_publishable_.')
for (const [name, value] of Object.entries(process.env)) {
  if (!name.startsWith('VITE_') || !value) continue
  if (/(?:SECRET|SERVICE_ROLE|PRIVATE|PASSWORD|DATABASE)/i.test(name) || secretReason(value)) failures.push(`Variable publique interdite ou sensible : ${name}`)
}

const redirects = read('public/_redirects')
const headers = read('public/_headers')
requireCondition(!existsSync(resolve(root, 'functions')), 'Le répertoire functions est incompatible avec le déploiement Pages statique prévu.')
requireCondition(redirects.split(/\r?\n/).some(line => line.trim() === '/* /index.html 200'), 'Le retour SPA vers /index.html est absent de _redirects.')
requireCondition(headers.includes("script-src 'self'") && !/script-src[^;\n]*'unsafe-(?:inline|eval)'/.test(headers), 'La CSP doit limiter les scripts aux fichiers du site, sans inline ni eval.')
requireCondition(headers.includes('https://*.supabase.co') && headers.includes('wss://*.supabase.co'), 'La CSP doit autoriser les connexions HTTPS et WebSocket Supabase.')
requireCondition(headers.includes("frame-ancestors 'none'") && headers.includes('X-Content-Type-Options: nosniff'), 'Les en-têtes de sécurité attendus sont incomplets.')
requireCondition(headers.includes('Cache-Control: no-cache') && headers.includes('max-age=31536000, immutable'), 'Les politiques de cache HTML et assets sont manquantes.')
for (const line of headers.split(/\r?\n/)) requireCondition(line.length <= 2000, 'Une ligne _headers dépasse la limite Pages de 2 000 caractères.')

if (!existsSync(output)) failures.push('dist est absent. Exécutez npm run build avant npm run pages:check.')
else {
  const html = read('dist/index.html')
  requireCondition(/<script\b[^>]*type="module"[^>]*src="\/assets\//.test(html), 'Le HTML ne référence pas un bundle Vite compilé.')
  requireCondition(!/<script\b(?![^>]*\bsrc=)[^>]*>/i.test(html), 'Le HTML embarque un script inline non autorisé par la CSP.')
  requireCondition(!html.includes('/src/main.ts'), 'Le HTML de développement a été copié au lieu du build.')
  requireCondition(read('dist/_redirects') === redirects, '_redirects ne correspond pas à la version du build. Reconstruisez.')
  requireCondition(read('dist/_headers') === headers, '_headers ne correspond pas à la version du build. Reconstruisez.')
  inspect(output)
  const bundles = existsSync(join(output, 'assets')) ? readdirSync(join(output, 'assets')).filter(name => name.endsWith('.js')).map(name => readFileSync(join(output, 'assets', name), 'utf8')) : []
  requireCondition(!!origin && bundles.some(content => content.includes(origin)), 'Le projet Supabase configuré n’est pas présent dans le build. Vérifiez les variables puis reconstruisez.')
  requireCondition(!!key && bundles.some(content => content.includes(key)), 'La clé publique configurée n’est pas présente dans le build. Vérifiez les variables puis reconstruisez.')
}

if (failures.length) {
  console.error('Contrôle Pages refusé :')
  for (const failure of new Set(failures)) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log('Contrôle Pages réussi : build statique, paramètres publics cohérents, routage SPA, en-têtes et absence de données serveur vérifiés.')
  console.log('Ce contrôle local ne valide ni les migrations, ni les permissions SQL, ni un déploiement Cloudflare réel.')
}
