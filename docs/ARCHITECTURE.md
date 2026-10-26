# Architecture de QCM BCPST

## Deux backends explicites

Le frontend Vue 3 / TypeScript conserve les mêmes parcours et types métier. Le choix `VITE_BACKEND` détermine la couche de données ; un échec cloud ne bascule jamais sur les démonstrations locales.

| Mode | Interface servie par | Identités et données | Synchronisation de jeu |
| --- | --- | --- | --- |
| `supabase` | Vite en développement, fichiers statiques Pages en production | Supabase Auth, PostgreSQL, Storage privé | RPC transactionnelles et lectures d’état environ chaque seconde |
| `local` | Serveur Node.js 24 / Express | Comptes locaux et SQLite, images dans `data/uploads` | SSE et commandes HTTP du serveur local |

Sans `VITE_BACKEND`, le développement ordinaire est local ; le mode Vite `cloud` et un build de production choisissent Supabase. Une valeur explicite reste prioritaire. `npm run dev:cloud` démarre seulement Vite. `npm run preview` sert uniquement les fichiers compilés, sans API Node.js.

```text
Téléphone / navigateur Vue
        │ HTTPS + session utilisateur
        ├── Cloudflare Pages : HTML, JS, CSS, illustrations
        │
        └── Supabase
              ├── Auth : connexion, confirmation, renouvellement
              ├── RPC PostgreSQL : droits, questions, parties, scores
              └── Storage privé : images et URL signées
```

Le backend historique peut également utiliser des identités Supabase avec des miroirs SQLite. Ce mode hybride reste une possibilité locale de transition, distincte du backend cloud direct. `QCM_AUTH_MODE` configure uniquement ce serveur Node.js.

## Sécurité et rôles

Le SDK Supabase garde et renouvelle la session du navigateur. Les RPC reçoivent le JWT utilisateur ; les contrôles reposent sur `auth.uid()` et le profil autorisé. La clé publishable est publique et ne remplace pas ces permissions. Aucune clé secrète Supabase ni connexion PostgreSQL privilégiée n’est fournie au frontend.

La connexion e-mail appelle Auth directement. La connexion par pseudo utilise la fonction Supabase `username-login` pour retrouver l’adresse en privé et demander la session à Auth ; le SDK installe ensuite les jetons obtenus. `profiles.username` est unique et indépendant du nom affiché et du rôle. La disponibilité publique d’un pseudo renvoie seulement un booléen ; la modification exige le compte actif du propriétaire. Voir [activer la connexion par pseudo](USERNAME_LOGIN.md).

Une inscription crée un profil `student`. Les métadonnées utilisateur ne donnent aucun rôle privilégié. Les promotions `contributor` ou `admin` se font par une opération de confiance dans Supabase. L’administration cloud affiche les rôles en lecture seule. Les tables exposées sont protégées par RLS ; les bonnes réponses et les commandes internes privilégiées sont isolées dans le schéma privé.

Un contributeur peut proposer et modifier ses questions autorisées, mais ne peut pas les publier lui-même. L’administrateur publie ou refuse avec un motif. Les RPC valident l’énoncé, les quatre propositions distinctes, les indices exacts de bonnes réponses, le chapitre et les images. L’état visible par un élève n’expose pas la correction avant la phase autorisée.

Les changements d’identité invalident l’état précédent et interrompent les abonnements ou lectures de partie. Les réponses réseau tardives ne doivent pas restaurer l’ancien compte. Les modes de démonstration sont masqués dans le backend cloud.

## Parties et points

Les questions sont sélectionnées côté serveur et une partie conserve ses questions. La transaction refuse une réponse d’un non-membre, une question devenue obsolète et un second enregistrement de la même réponse. Le client transmet ses choix, jamais un score à accepter.

En solo, il n’y a pas d’échéance. La sélection exacte de toutes les bonnes réponses vaut 100 points, sans bonus ; toute autre réponse vaut zéro. La correction reste visible jusqu’à la commande suivante. Une interruption n’oblige pas à recommencer le quiz.

En multijoueur, PostgreSQL fixe l’heure de départ, l’échéance de 30 secondes et le calcul du bonus. Une bonne réponse rapporte `100 + floor(50 × max(0, 1 − tempsÉcoulé / durée))`. Une réponse incorrecte, partielle ou hors délai vaut zéro. La correction commune dure cinq secondes et ne doit pas être divulguée aux joueurs qui réfléchissent encore.

Les salons actifs utilisent un polling d’environ une seconde. Les commandes RPC et la lecture d’état font avancer les transitions dues avec l’horloge PostgreSQL. Aucune tâche Cron ni aucun Worker permanent n’est requis. Lorsqu’aucun client ne consulte la partie, son avancement effectif est différé au prochain appel, qui traite les échéances déjà passées. Il n’est pas promis de diffusion SQL Realtime instantanée ; le polling et le réseau ajoutent une latence d’affichage.

Les résultats et classements cloud sont persistés dans PostgreSQL et partagés entre appareils. Le calcul reste serveur et les droits limitent les écritures directes des élèves. Les vues de classement incluent les profils autorisés sans résultat afin que les nouveaux élèves apparaissent aussi.

## Images et banque de questions

Les images cloud sont dans le bucket privé `question-images`. Les politiques Storage vérifient les droits et le préfixe de l’auteur. La lecture passe par des URL signées ; leur durée limitée demande de les renouveler lors d’un nouveau chargement. Les schémas fournis avec le frontend sont des SVG statiques de confiance. Les téléversements utilisateurs doivent respecter les formats et limites du bucket ; ne pas déduire qu’un fichier est sûr uniquement de son extension.

Le dépôt fournit une migration d’initialisation séparée pour les 50 questions de démonstration. Un profil administrateur doit être présent afin de leur attribuer un auteur cloud. Les anciennes bases SQLite et leurs utilisateurs ne sont pas importés automatiquement.

Les questions d’essai et leurs corrections doivent être relues par un enseignant avant utilisation pédagogique officielle. Une initialisation avec le statut publié permet de tester les parcours, sans constituer une validation scientifique.

## Hébergement et fichiers

Cloudflare Pages ne reçoit que `dist/`. Le navigateur charge les assets statiques et contacte Supabase ; il n’a besoin ni d’Express, ni de `node:sqlite`, ni du dossier `data`. Node.js 24 sert à compiler et à tester, pas à exécuter la version Pages.

`public/_redirects` fournit le retour SPA et `public/_headers` définit CSP et cache. Le build ne contient pas d’API `/api` fonctionnelle : ce chemin appartient au backend local. Le contrôle `pages:check` refuse les artefacts privés reconnaissables et vérifie les paramètres publics du build.

Les migrations sont dans `supabase/migrations`, en ordre chronologique. Les tests SQL sont dans `supabase/tests`. Les fondations déjà appliquées ne doivent pas être réécrites ou rejouées ; les évolutions passent par de nouvelles migrations. Voir [Supabase](SUPABASE_SETUP.md), [Cloudflare Pages](CLOUDFLARE_PAGES.md) et [les vérifications](TESTS.md).

Un retour à un ancien frontend ne restaure pas les données cloud. Les sauvegardes PostgreSQL et Storage, leur restauration et la compatibilité des migrations doivent être définies avant une ouverture durable aux élèves.
