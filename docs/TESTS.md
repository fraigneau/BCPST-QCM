# Vérifier QCM BCPST

## Commandes locales

```sh
npm run typecheck
npm test
npm run build
npm run pages:check
```

Les tests s’exécutent avec Node.js 24 et son stripping TypeScript natif. Ils utilisent des données isolées et des clients contrôlés ; ils ne créent pas automatiquement de nouveaux utilisateurs distants. Le nombre de tests et leur résultat doivent être lus dans la dernière exécution, sans assimiler une simulation locale à une recette Supabase réelle.

Les suites couvrent notamment les comptes locaux, permissions, résultats et délais serveur, les sessions Supabase et changements d’identité, la confidentialité des corrections et les rendus Vue. Les tests SQL de `supabase/tests` complètent ces vérifications sous des identités PostgreSQL limitées.

`pages:check` s’exécute après un build destiné au cloud. Il vérifie les paramètres publics et leur présence dans les fichiers compilés, le retour SPA, la CSP et l’absence d’artefacts serveur ou de secrets reconnaissables dans `dist`. Il ne contacte pas Cloudflare ou Supabase et ne démontre pas qu’un projet distant possède les bonnes migrations.

## Backend cloud sans Node.js

Préparer Supabase comme décrit dans [SUPABASE_SETUP.md](SUPABASE_SETUP.md), puis :

```sh
npm run dev:cloud
```

Arrêter tout autre serveur local qui occupe le port choisi. Le frontend doit fonctionner avec Vite seul, sans lancer Express. Dans l’onglet Réseau, vérifier que les opérations métier utilisent les API Supabase, jamais `/api` sur le serveur statique.

| Parcours | Résultat attendu |
| --- | --- |
| Connexion | Compte personnel, profil et rôle corrects ; aucune démonstration proposée |
| Inscription | Profil élève ; message de confirmation si aucune session n’est créée |
| Confirmation | Le lien reçu revient à une URL autorisée et produit la session attendue |
| Rechargement | La session et les données persistantes sont retrouvées |
| Déconnexion | L’interface protégée et les lectures de partie s’arrêtent ; aucune réponse tardive ne restaure l’ancien compte |
| Changement de compte | Aucun score, rôle ou salon de l’utilisateur précédent ne reste affiché |
| Solo | Pas de chrono ni de bonus, 100 points pour une réponse exactement correcte |
| Reprise solo | La question ou correction reste récupérable après interruption |
| Questions | Quatre choix distincts, réponses multiples et correction explicative |
| Contributeur | Brouillon, image, soumission ; aucune auto-publication possible |
| Administrateur | Publication ou refus motivé, image consultable après publication |
| Classement | Résultats persistants et nouveaux élèves visibles sans point |
| Erreurs | La révision d’erreurs cible les réponses à retravailler |
| Rôles | Un élève ne peut ni écrire un score ni modifier son rôle ou une question |

Vérifier les refus aussi par appels RPC directs sous le JWT d’un élève. Un bouton masqué ne démontre pas une permission serveur. Ne jamais recopier un JWT ou un mot de passe dans un journal, un test commité ou une capture partagée.

## Salon à deux comptes

Utiliser deux appareils ou deux profils de navigateur isolés. Deux onglets du même profil partagent une identité et ne constituent pas deux joueurs.

1. Créer un salon, transmettre son code et vérifier la liste commune.
2. Vérifier que seul l’hôte peut lancer la partie et que chacun reçoit la même question.
3. Répondre sur un seul appareil : la correction ne doit pas être divulguée au second avant la phase commune.
4. Répondre sur le second, comparer les points puis attendre le passage à la question suivante.
5. Laisser expirer une question : la réponse absente vaut zéro, même si l’horloge du téléphone est modifiée.
6. Envoyer deux fois une réponse, puis envoyer une commande pour une ancienne question : pas de double score ni de réponse appliquée à la nouvelle question.
7. Passer un appareil en arrière-plan, couper brièvement le réseau, puis reprendre : même partie, échéance PostgreSQL conservée.
8. Terminer et comparer résultats, progression et classement de chapitre sur les deux comptes.

Le cloud utilise un polling d’environ une seconde pendant le jeu ; vérifier ses appels RPC plutôt qu’attendre un flux SSE ou un canal Realtime. Les transitions sont appliquées lors des commandes et lectures d’état. Si tous les joueurs sont absents, leur traitement est différé au prochain appel, sans remettre les délais à zéro. Aucun test ne doit supposer un Worker ou un Cron permanent.

## Build statique et Preview Pages

```sh
npm run build
npm run pages:check
npm run preview
```

Reprendre les parcours sur <http://localhost:4173> sans serveur Node.js. Une réussite en développement ne suffit pas : les variables sont intégrées dans le build et peuvent différer de celles de Vite.

Après création explicite d’une Preview Cloudflare par le propriétaire, vérifier également :

- Accès direct et rechargement des routes Vue, dont `/practice` et une route `/game/...` autorisée.
- Absence de violations CSP et d’appels à `localhost`, une IP privée ou l’API Express.
- HTML en `no-cache`, assets compilés en cache `immutable`, présence de `nosniff` et de la CSP.
- Confirmation e-mail avec l’URL réellement reçue et la liste exacte de retours autorisés.
- Connexion, solo, contribution illustrée et salon à deux comptes sur Android et iPhone réels.

`vite preview` ne reproduit pas les règles `_headers` de Cloudflare. Une vérification HTTP sur Pages reste nécessaire avant ouverture publique. Voir [le guide de publication](CLOUDFLARE_PAGES.md).

## Démonstration locale

Définir `VITE_BACKEND=local` et `QCM_AUTH_MODE=local`, puis lancer `npm run dev`. Vérifier les trois profils de démonstration, la création d’un élève, le solo sans chrono, le salon SSE, les permissions et la persistance après redémarrage.

Les données de ce parcours restent dans `data/`. Les effacer ou changer de serveur local n’affecte pas Supabase. Ne pas utiliser ces comptes publics pour une recette du backend cloud.

## Portée des résultats

Le 26 octobre 2026, la version avec pseudos passe 82 tests Node, le build TypeScript/Vite et `pages:check`. Les tests couvrent les connexions pseudo/e-mail locales avec redémarrage, les collisions, le maintien des rôles, la délégation de la connexion cloud à Auth et les réponses de la fonction. Le point d’entrée Edge a également été contrôlé contre les types du SDK avec des déclarations minimales du runtime Deno. Ces contrôles ne constituent pas une exécution sous Deno ni une validation distante : la nouvelle suite SQL `username_auth.sql`, la migration et la fonction restent à exécuter dans Supabase.

Dernière préparation Pages du 22 octobre 2026 : 64 tests Node réussis, compilation TypeScript/Vite et contrôle `pages:check` réussis. Chrome a chargé le build statique à 390 px, vérifié l’écran cloud sans comptes de démonstration et la redirection d’une route protégée, sans erreur JavaScript ni requête vers `/api`. Cet essai ne fournit pas une session personnelle Supabase et ne remplace pas la recette du domaine publié.

La première phase a déjà été testée localement et la refonte mobile a été examinée avec Chrome headless à 320, 390, 430 et 1440 px. Les captures locales sont dans `.qa/mobile-artifacts/` lorsqu’elles sont conservées. Ces essais ne prouvent ni la configuration du site Pages final ni le comportement d’un clavier Android/iOS réel.

Le 22 octobre 2026, les scripts `supabase/tests/0003_cloud_game.sql` et `0004_cloud_content.sql` ont été exécutés avec succès sur le projet de développement. Ils couvrent notamment le solo sans délai, les réponses multiples, les scores, les doublons, les délais multijoueurs manqués, les snapshots, les classements, les trois rôles, la modération, les imports atomiques et les permissions Storage. Les transactions ont été annulées : aucun compte de test ni résultat n’est conservé. La connexion HTTP personnelle et la partie sur deux appareils restent à vérifier sans communiquer de mot de passe à l’assistant. Aucun état « publié » ne remplace une validation pédagogique de la banque.


## Chapitres, solo et variantes de défi — 29 octobre 2026

La branche de cette évolution a été vérifiée avec 91 tests Node, `npm run build`, `npm run pages:check` et `git diff --check`. Les nouveaux tests HTTP couvrent les droits de création/renommage des chapitres, les liens de variantes, le QCS à réponse unique, la sélection des questions par mode et les imports atomiques avec remappage des identifiants. Une erreur de défi renvoie à sa source solo, même si la variante est ensuite supprimée localement.

Les migrations hors banque initiale ont été exécutées dans un PostgreSQL embarqué PGlite temporaire, avec les rôles PostgreSQL et des schémas Auth/Storage minimaux. Les scripts `0001_foundation.sql`, `0003_cloud_game.sql`, `0004_cloud_content.sql`, `username_auth.sql` et `0005_chapters_question_modes.sql` passent dans cet environnement. Le contrat du profil du test de fondation inclut désormais `username`, déjà ajouté par la migration de connexion par pseudo. Ces vérifications locales ne valident pas Supabase Auth ou Storage réels et ne prouvent pas que la nouvelle migration est appliquée à distance.

Un parcours Chromium local a vérifié la création et le renommage d’un chapitre, un QCM solo à réponses multiples, sa variante QCS liée, les filtres, l’export puis le réimport en brouillon, et la sélection exclusive en défi. L’interface a été examinée en 1280 × 900 et 390 × 844, y compris l’éditeur mobile. Aucun déploiement frontend ni changement de la base distante n’a été effectué pour cette évolution.


## Import XML Moodle / Pronote

Les tests de `tests/question-import.test.ts` vérifient le format Moodle XML `multichoice`, les catégories, les CDATA/entités HTML, les réponses uniques et multiples, les fractions, les corrections, les illustrations intégrées modernes et anciennes, les refus explicites des formats incompatibles, les bornes et le refus des DTD/entités externes. Le JSON historique reste couvert, notamment les identifiants dupliqués et la sélection des sources avec leurs variantes. Le fichier `tests/fixtures/moodle-pronote.xml` est un exemple synthétique rédigé pour ces tests, pas un export utilisateur Pronote.

Un parcours Chromium local a vérifié l’aperçu sans écriture préalable, le choix des chapitres et du niveau, l’enregistrement de QCM XML en brouillons solo, l’image téléversée et lisible, l’annulation, l’exclusion explicite des incompatibles et le réimport JSON avec liens remappés. Un échec sur la deuxième illustration ne crée aucune question et le nouvel essai réutilise la première image ; une réponse réseau incertaine après soumission bloque le nouvel essai. Un changement de session pendant l’envoi d’une illustration empêche toute soumission ultérieure du lot. Les erreurs UTF-8 et XML mal formé restent lisibles. L’interface est examinée en 1280 × 900 et 390 × 844.

La compatibilité vise le format XML Moodle documenté, utilisé par l’export Pronote « compatible Moodle », avec les limites affichées dans l’aperçu. Des fixtures du dépôt officiel Moodle ont également servi à vérifier les refus de contenus non représentables (audio, images dans les propositions, cloze, nombres de choix différents). Aucun export propre à l’utilisateur ni parcours Supabase authentifié n’a été testé pour cet import ; le backend n’est pas modifié et aucune migration supplémentaire n’est nécessaire.

Validation de cette évolution : les 100 tests Node passent, ainsi que le build de production, `pages:check` et le contrôle du diff. Aucune migration ni écriture sur Supabase distant, et aucun déploiement frontend n’ont été effectués pour cette PR.

La migration a ensuite été appliquée sur Supabase le 29 octobre 2026, sous le numéro `20261029044024` attribué par le service. `0005_chapters_question_modes.sql` a réussi sur ce projet réel avec ses données annulées, notamment les rôles, les variantes, les contraintes différées, les imports, les images de source et la sélection par mode. Les comparaisons avant/après confirment la conservation des 50 questions, des corrections, des 5 chapitres et des 50 snapshots. Les nombres de profils (3), de parties (5) et de réponses (42) sont identiques ; aucun compte temporaire de ce test ne subsiste. Cette recette SQL distante ne remplace pas un parcours navigateur authentifié après publication du frontend.

## Années BCPST et sous-chapitres

Les 107 tests Node passent, ainsi que `npm run build` et `npm run pages:check`. `tests/curriculum.test.ts` couvre les questions communes et par année, les imports JSON/XML, les droits sur les chapitres, les parents invalides, la compatibilité des anciennes modifications, les filtres, les comptes et la sélection des descendants sans doublons en solo/défi. Le filtrage et les snapshots sont vérifiés via l’API locale.

Les six suites SQL (`0001_foundation.sql`, `0003_cloud_game.sql`, `0004_cloud_content.sql`, `username_auth.sql`, `0005_chapters_question_modes.sql`, `0006_school_years_subchapters.sql`) passent après la nouvelle migration dans PGlite, avec les schémas Auth/Storage minimaux du banc local. Cela ne valide pas Supabase Auth/Storage réels ; la migration distante et la recette authentifiée cloud restent à faire.

Un parcours Chromium local vérifie la création d’un chapitre et d’un sous-chapitre, une question BCPST1, l’héritage de son année par la variante QCS, la bibliothèque et l’export BCPST2 avec questions communes, et l’année préremplie dans l’import XML. Un élève crée ensuite un solo BCPST2 et un salon BCPST1 en sélectionnant le chapitre parent ; l’état serveur confirme l’année et le nombre de questions attendus. L’interface est examinée à 1280 × 900 et 390 × 844, sans débordement horizontal ni erreur JavaScript dans ce parcours. Aucun déploiement ni changement de la base distante n’a été effectué.

## Affichage hiérarchique des sous-chapitres

L’affichage regroupe les enfants sous leur parent dans la bibliothèque, l’accueil et les sélections solo/défi. Un parcours Chromium local à 390 px vérifie la structure imbriquée, l’ouverture d’un sous-chapitre, sa sélection individuelle puis celle du parent, l’indication des enfants inclus, et la création de parties solo/défi contenant les questions du sous-chapitre. Aucun débordement horizontal ni erreur JavaScript n’est observé. Les 107 tests Node, le build et `pages:check` passent. Cette correction d’interface ne remplace pas l’application de la migration des années et sous-chapitres ; elle n’a pas été appliquée à distance pour cette PR.
