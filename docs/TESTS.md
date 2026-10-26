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
