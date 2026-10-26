# QCM BCPST

Application mobile de révision SVT / BCPST avec Vue 3 et TypeScript. Le mode cloud associe un frontend statique Cloudflare Pages à Supabase pour les comptes, questions, images, parties et résultats. Aucun serveur Node.js permanent n’est nécessaire dans ce mode.

Le projet conserve aussi un backend Node.js / SQLite pour les démonstrations locales. Les deux banques de données sont indépendantes.

## Lancer le mode cloud

Prérequis : Node.js 24, npm et un projet Supabase préparé avec les migrations du dépôt.

```sh
npm install
```

Pour une nouvelle installation, copier `.env.example` vers `.env.local`, puis renseigner l’URL et la clé publique du projet :

```dotenv
VITE_BACKEND=supabase
VITE_SUPABASE_URL=https://votre-projet.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_votre_cle_publique
```

Ne pas remplacer un `.env.local` existant sans conserver ses paramètres. Ces variables sont publiques dans le navigateur ; elles ne doivent contenir aucun mot de passe, secret Supabase ou jeton `service_role`.

```sh
npm run dev:cloud
```

Ouvrir <http://localhost:5173>. Vite sert uniquement l’interface : le navigateur contacte directement Supabase. Les migrations doivent être appliquées avant la recette de connexion et de jeu. Voir [configurer Supabase](docs/SUPABASE_SETUP.md).

`VITE_BACKEND` choisit le backend. Sans valeur explicite, `npm run dev` utilise le backend local, `npm run dev:cloud` et le build de production utilisent Supabase. Une valeur explicite a priorité. Une configuration cloud incomplète produit une erreur ; elle ne donne pas accès aux comptes de démonstration.

## Réviser et jouer

- **Révision solo** : chapitres et difficulté au choix, sans chronomètre, 100 points par bonne réponse, correction expliquée et progression à votre rythme.
- **Défi multijoueur** : salon privé et code, mêmes questions, 30 secondes pour répondre, 100 points et jusqu’à 50 points de rapidité, puis correction commune de 5 secondes.
- **Progression** : erreurs à revoir, historique et classements par chapitre, y compris les élèves sans point.
- **Contributions** : quatre propositions, réponses multiples, images, brouillons et validation administrateur avant publication.

Une réponse partielle, incorrecte ou hors délai en multijoueur vaut zéro. Le navigateur ne décide ni des points ni de l’échéance. En cloud, les RPC PostgreSQL contrôlent les droits, l’heure et les transitions de partie. Les joueurs interrogent l’état du salon environ chaque seconde ; il ne s’agit pas d’un flux Supabase Realtime.

Les écrans sont conçus pour téléphone : quatre onglets, actions accessibles au pouce et quatre grandes réponses. Le manifeste permet un affichage de type application dans les navigateurs compatibles. Aucun service worker ni jeu hors connexion n’est fourni ; cette version n’est pas un binaire Android/iOS publié sur les stores.

## Préparer Cloudflare Pages

```sh
npm test
npm run build
npm run pages:check
npm run preview
```

Ouvrir <http://localhost:4173>, puis vérifier connexion, quiz, navigation directe et partie à deux comptes. Le mode preview sert uniquement `dist/` et n’utilise pas Express. Il ne reproduit pas les en-têtes Cloudflare ; leur vérification HTTP s’effectue sur une Preview Pages.

La configuration fournie prépare Pages : build `npm run build`, sortie `dist`, Node.js 24, retour SPA, CSP et cache des assets. Aucune publication ni connexion au compte Cloudflare n’est réalisée par ces fichiers. Le [guide Cloudflare Pages](docs/CLOUDFLARE_PAGES.md) détaille les paramètres Production/Preview, les redirections Auth et la recette avant ouverture.

Le fichier suivi `.env.production` fournit l’URL et la clé publique du projet QCM BCPST pour les builds Git Cloudflare. Le fichier personnel `.env.local` reste ignoré. Des variables de build Cloudflare peuvent remplacer cette configuration ; elles doivent rester complètes et valides, faute de quoi le build s’arrête avant publication.

## Démonstration locale

Pour une démonstration autonome, définir `VITE_BACKEND=local` et `QCM_AUTH_MODE=local`, puis lancer :

```sh
npm run dev
```

Ouvrir <http://localhost:5173>. Le serveur Node.js initialise SQLite avec cinq chapitres et 50 questions. Les comptes suivants sont uniquement des comptes de démonstration locale :

| Rôle | Adresse | Mot de passe public de démonstration |
| --- | --- | --- |
| Élève | `eleve@herbier.local` | `Herbier2026!` |
| Contributeur | `contributeur@herbier.local` | `Herbier2026!` |
| Administrateur | `admin@herbier.local` | `Herbier2026!` |

`QCM_AUTH_MODE` règle seulement l’authentification de l’ancien serveur Node.js. Il ne choisit pas le backend du frontend cloud. Le mode hybride historique, avec comptes Supabase et données SQLite, reste un outil local et ne doit pas être confondu avec le déploiement Pages.

Pour tester les démonstrations sur téléphone, connecter les appareils au même Wi-Fi, relever l’IPv4 de l’ordinateur avec `ipconfig` et ouvrir `http://IP:5173`. Si nécessaire, autoriser Node.js sur le réseau privé dans le pare-feu. Garder l’ordinateur allumé. Utiliser des comptes jetables sur ce transport HTTP ; pour des comptes personnels, privilégier le site cloud HTTPS.

Deux onglets d’un même profil partagent la session. Pour une partie à deux joueurs sur un ordinateur, utiliser des profils de navigateur distincts ou une fenêtre privée et deux comptes différents.

## Données

En cloud, les données sont dans PostgreSQL et les images dans le bucket privé Supabase `question-images`. Les rôles viennent de `profiles` ; une inscription crée toujours un élève. Les promotions s’effectuent par une opération de confiance dans Supabase, jamais depuis les métadonnées du navigateur.

En local, SQLite et les images sont dans `data/`. Sauvegarder ce dossier avec le serveur arrêté. Les anciennes données SQLite ne sont pas automatiquement transférées dans Supabase : comptes, mots de passe, sessions, parties et scores locaux restent locaux. Les mots de passe ne se migrent jamais dans les fichiers du projet. L’export JSON couvre les questions, pas les fichiers images ni les résultats.

La banque de 50 questions fournie pour les essais doit être relue par un enseignant avant usage pédagogique officiel. Son initialisation cloud est une migration séparée, avec un auteur administrateur ; le statut publié facilite les tests et ne remplace pas une validation scientifique.

## Guides

- [Architecture et séparation des backends](docs/ARCHITECTURE.md)
- [Configurer Supabase et ses rôles](docs/SUPABASE_SETUP.md)
- [Préparer Cloudflare Pages](docs/CLOUDFLARE_PAGES.md)
- [Commandes de vérification et recette téléphone](docs/TESTS.md)
