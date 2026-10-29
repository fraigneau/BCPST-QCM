# Consignes pour les agents

## Collaboration et Git

- Communiquer en français, simplement, et distinguer ce qui est vérifié de ce qui reste à vérifier.
- Toute modification du dépôt doit passer par une nouvelle branche et une pull request vers `main`. Ne pas pousser directement sur `main`, fusionner une PR ou déclencher volontairement un déploiement sans demande de l’utilisateur.
- Inspecter `git status` avant de travailler. Préserver les changements personnels, notamment `.idea/`, et ne pas les inclure dans les commits.
- Utiliser des commits ciblés et expliquer dans la PR le changement, les vérifications et les limites.
- Le dépôt est `fraigneau/BCPST-QCM`. Vérifier les droits réels avec `gh auth status` et `gh repo view` : le connecteur GitHub et le CLI peuvent utiliser des comptes différents. Un échec réseau ou d’accès au trousseau dans le bac à sable ne prouve pas que l’authentification est invalide.

## Projet et production

- Application de révision SVT / BCPST, Vue 3, TypeScript et Vite. Node.js 24 requis.
- Site de production communiqué par le propriétaire : https://qcm.fraigneau.fr.
- Le frontend est hébergé sur Cloudflare Pages et déployé par intégration GitHub. Vérifier la configuration distante des branches avant de supposer qu’un push ne publie rien.
- Le mode cloud utilise directement Supabase Auth, PostgreSQL et Storage privé (`question-images`). Aucun serveur Node permanent n’est nécessaire sur Pages.
- Le backend Express / SQLite est un mode local distinct. Les banques cloud et locale sont indépendantes. Ne pas confondre les tests du backend local avec une recette Supabase.
- Les scores, permissions, corrections et délais de jeu sont contrôlés côté serveur. Préserver cette autorité et ne jamais accepter un score ou un rôle choisi par le navigateur.
- Le multijoueur cloud utilise un polling, pas Supabase Realtime.

## Commandes et vérifications

```sh
npm ci
npm run dev:cloud
npm test
npm run build
npm run pages:check
```

- `npm run dev` lance le backend local par défaut ; utiliser `dev:cloud` pour travailler avec Supabase.
- `pages:check` exige un build préalable. Il valide les fichiers générés, pas le déploiement réel.
- Les tests HTTP démarrent des serveurs locaux : des restrictions du bac à sable peuvent nécessiter une exécution autorisée hors de celui-ci.
- Pour une modification documentaire seule, vérifier le diff et les liens ; ne pas relancer toute la suite sans raison.

## Supabase et configuration

- Lire les guides concernés avant de modifier l’infrastructure. Ajouter une nouvelle migration pour une évolution SQL ; ne pas réécrire une migration déjà appliquée.
- Un push du frontend ne déploie pas automatiquement les migrations ni la fonction Edge `username-login`.
- Pour un domaine personnalisé ou une Preview, vérifier les URL Auth et la liste serveur `ALLOWED_ORIGINS` de `username-login`. Ne pas supposer que le domaine personnalisé est autorisé parce que Pages fonctionne.
- Ne pas écraser `.env.local`. `.env.production` contient volontairement la configuration publique du frontend.
- Ne jamais commiter ni afficher mots de passe, jetons de session, clés privilégiées ou secrets. Ne jamais placer une clé `service_role` dans une variable `VITE_`.
- La disponibilité d’un outil connecté autorise sa consultation dans le cadre demandé ; elle ne constitue pas une demande de modifier la production. Pour une demande d’audit ou de configuration des accès, rester en lecture sur les données métier.

## Reprise sur un autre ordinateur

- Ce fichier transmet les conventions du projet, pas l’historique complet des conversations.
- L’authentification GitHub, les connexions MCP/OAuth et les secrets locaux ne sont pas transférés par un clone Git. Vérifier leur état sur chaque machine sans enregistrer les identifiants dans le dépôt.
- Supabase peut être connecté via le plugin disponible dans l’application. Cloudflare propose le MCP officiel https://mcp.cloudflare.com/mcp ; sa configuration et son autorisation sont propres à l’environnement de l’agent.
- Ne pas considérer un accès comme connecté avant d’avoir vérifié son fonctionnement. Utiliser les documentations officielles à jour pour configurer les outils.

## Sources de contexte

- `README.md` : installation et fonctionnalités.
- `docs/ARCHITECTURE.md` : séparation cloud/local et règles métier.
- `docs/SUPABASE_SETUP.md` : installation Supabase et rôles.
- `docs/USERNAME_LOGIN.md` : migration, fonction Edge, origines et limites de connexion.
- `docs/CLOUDFLARE_PAGES.md` : déploiement, configuration et recette.
- `docs/TESTS.md` : tests et limites des validations précédentes.

Lors de l’audit local du 29 octobre 2026 sur le commit `e898dd2`, les 82 tests Node, le build et `pages:check` ont réussi. Le domaine de production répondait en HTTPS avec les en-têtes de sécurité attendus. Cela ne valide pas les migrations distantes ni les parcours authentifiés. La documentation peut présenter des écarts avec le code : vérifier l’implémentation avant d’en déduire le comportement réel.
