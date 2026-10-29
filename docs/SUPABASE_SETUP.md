# Configurer Supabase

Le backend cloud direct fournit les comptes, rôles, questions, images, parties et classements. Le frontend Pages utilise seulement l’URL du projet et sa clé publishable. Aucun mot de passe personnel ou secret Supabase ne doit être ajouté au dépôt.

## Variables frontend

Pour une nouvelle installation, copier `.env.example` vers `.env.local` et renseigner :

```dotenv
VITE_BACKEND=supabase
VITE_SUPABASE_URL=https://votre-projet.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_votre_cle_publique
```

Ne pas écraser les paramètres d’un fichier existant. `npm run dev:cloud` choisit aussi le backend cloud si `VITE_BACKEND` n’est pas défini ; `VITE_BACKEND=local` resterait prioritaire. Après changement de configuration, redémarrer Vite. Pour un site compilé, reconstruire le frontend.

Les variables `VITE_` sont publiques. Ne jamais y placer une clé `sb_secret_`, une ancienne clé JWT `service_role`, une chaîne de connexion PostgreSQL ou un mot de passe. Les URL personnalisées Supabase exigent une adaptation de la CSP Pages ; la configuration fournie cible les projets HTTPS `*.supabase.co`.

## Préparer la base

Utiliser les migrations de `supabase/migrations` dans l’ordre des noms. Elles couvrent les fondations et RLS, les frontières des fonctions privées, le moteur de partie, les commandes de contenu et la banque initiale. Les noms horodatés du dépôt font foi. Ne pas rejouer les migrations déjà inscrites dans l’historique du projet.

Pour un nouveau projet, appliquer d’abord les fondations, créer le compte administrateur décrit ci-dessous, puis appliquer les migrations suivantes et l’initialisation de la banque. La banque initiale de 50 questions a besoin d’un auteur administrateur. Dans un projet existant, relire les migrations encore absentes et sauvegarder les données avant de les appliquer.

Exécuter les tests SQL de `supabase/tests` dans une session de confiance. Ils doivent tester des identités `anon` et `authenticated` et annuler leurs données temporaires. L’inspection sous un compte PostgreSQL privilégié seule ne démontre pas qu’un élève est correctement limité par RLS.

Sur le projet de développement `bogagjweldkzbgdvpxsw`, les cinq migrations ont été appliquées le 22 octobre 2026. Les tests SQL de jeu et de contenu passent avec leurs données annulées. La banque contient 50 questions publiées, réparties par dix dans les cinq chapitres ; le compte administrateur existant est conservé. Il ne faut pas réappliquer ces migrations dans ce projet.

Au contrôle du 29 octobre 2026, le schéma de connexion par pseudo et la fonction `username-login` sont présents sur le projet distant, mais `20261026160000_username_auth.sql` ne figure pas dans son historique de migrations. Ne pas rejouer cette migration sur ce projet sans réconcilier au préalable le schéma et l’historique. Suivre [USERNAME_LOGIN.md](USERNAME_LOGIN.md) pour les activer ; le déploiement du frontend Cloudflare seul ne suffit pas.

## Chapitres et modes de questions

La migration `20261029044024_chapters_question_modes.sql` ajoute les chapitres administrables, l’usage solo/défi et les liens entre les variantes. Elle doit être appliquée avant de publier le frontend correspondant. Elle laisse toutes les questions existantes en solo et ne modifie ni les réponses ni les parties déjà enregistrées. Les nouveaux salons exigent des variantes QCS publiées : en créer puis en valider au moins une avant de tester un défi. Les salons déjà créés conservent leurs snapshots et leurs anciennes règles de sélection.

Tester `supabase/tests/0003_cloud_game.sql`, `0004_cloud_content.sql`, `username_auth.sql` et `0005_chapters_question_modes.sql` après migration. Le dernier script teste les rôles, les chapitres, les sources, la sélection par mode, les réponses multiples refusées en défi, la révision des erreurs et le remappage atomique des imports. Il annule ses données. La migration a été appliquée au projet `bogagjweldkzbgdvpxsw` le 29 octobre 2026 via le MCP Supabase, sous la version `20261029044024`. Le fichier a été renommé pour correspondre à cette version attribuée par Supabase, sans changer son contenu SQL. Le script `0005_chapters_question_modes.sql` a réussi sur la base distante dans une transaction annulée. Les 50 questions, leurs corrections, les 5 chapitres et les 50 snapshots ont été comparés à la sauvegarde préalable et sont conservés. Les comptes et résultats n’ont pas changé ; aucun utilisateur temporaire du test ne subsiste. Les 50 questions sont en solo et aucune variante QCS n’a été créée par la migration.

## Comptes et rôles

Le compte du tableau de bord Supabase et le compte Auth de l’application sont distincts. Le propriétaire doit utiliser un compte réel créé dans **Authentication → Users**, avec sa véritable adresse et un mot de passe conservé dans son gestionnaire personnel.

Le déclencheur crée un profil `student`. Après vérification de l’identité, une opération de confiance sur `public.profiles` peut désigner son rôle. Exemple à adapter avec l’UUID réel dans le SQL Editor autorisé :

```sql
update public.profiles
set role = 'admin'
where id = 'UUID_DU_COMPTE_VERIFIE'::uuid;
```

Le premier inscrit n’est jamais automatiquement administrateur. Les rôles fournis dans les métadonnées d’inscription ne confèrent aucun privilège. Après la désignation du premier administrateur, celui-ci peut promouvoir ses collègues dans l’écran Administration : la commande passe par une RPC Supabase qui contrôle ses droits et conserve une trace. Il ne peut pas retirer son propre rôle administrateur.

Un compte administrateur personnel a été désigné dans le projet de développement au cours de la première phase. Cela ne crée pas d’administrateur dans un autre projet Supabase : vérifier explicitement le profil du projet utilisé pour Pages.

## Auth et confirmation e-mail

Activer le fournisseur e-mail et vérifier les réglages de confirmation. Une inscription depuis l’application crée un élève. Si une confirmation est exigée, l’interface affiche une invitation à consulter sa boîte mail et attend une vraie session avant d’ouvrir l’espace.

Pour ce projet d’étude, la confirmation peut être désactivée dans **Authentication → Sign In / Providers → Email → Confirm email**, puis enregistrée. Ce réglage se fait dans Supabase, pas dans le frontend : une PR ou un déploiement Pages ne le change pas. Une fois désactivé, une nouvelle inscription ouvre directement une session ; l’application accepte déjà ce cas. Les adresses ne sont alors pas vérifiées. Ne pas supprimer l’écran de confirmation pour contourner un réglage serveur encore actif. Voir la [configuration Auth](https://supabase.com/docs/guides/auth/general-configuration).

Le contrôle Supabase du 22 octobre signale que la protection contre les mots de passe compromis est désactivée. Son activation se règle dans Auth selon les possibilités du forfait ; voir la [protection des mots de passe Supabase](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection). Aucun autre avertissement de sécurité SQL n’a été remonté lors de ce contrôle.

Pendant la préparation, garder `http://localhost:5173` comme origine locale autorisée et ajouter `http://localhost:4173` pour le build preview. Avant publication, la **Site URL** doit devenir l’origine HTTPS finale. Ajouter dans **Redirect URLs** les URL de retour exactes des environnements réellement utilisés. Les previews ne doivent pas autoriser tous les domaines `pages.dev`.

Sans `emailRedirectTo` explicite dans le client, l’e-mail revient à la Site URL. Une URL Preview ajoutée à la liste autorisée ne change pas à elle seule cette destination. Vérifier le lien reçu et utiliser un projet de test pour essayer la confirmation sur une Preview sans déplacer la Site URL de production. Le comportement et les chemins autorisés sont décrits dans les [redirections Supabase Auth](https://supabase.com/docs/guides/auth/redirect-urls).

## Storage

Vérifier la présence du bucket privé `question-images` et ses politiques après les migrations. Les contributions téléversent avec la session utilisateur dans leur préfixe autorisé. Les URL signées permettent l’affichage d’images sans rendre le bucket public.

Tester un téléversement valide, le refus d’un fichier trop volumineux ou d’un type non autorisé, la publication d’une question illustrée et la lecture de l’image avec un compte élève. Les références exportées dans un JSON ne constituent pas une sauvegarde des fichiers Storage.

## Vérifications et lancement

```sh
npm run supabase:check
npm run dev:cloud
```

`supabase:check` lit uniquement les réglages publics Auth. Il ne crée ni compte ni table et ne valide pas les RPC, les permissions, les mots de passe ou les parcours métier. Une erreur réseau dans cet environnement ne permet pas de conclure à une panne du projet distant.

La recette complète est dans [TESTS.md](TESTS.md). La connexion personnelle doit être testée sans transmettre le mot de passe à l’assistant. Vérifier ensuite solo, persistance, contribution illustrée et partie à deux comptes. Les appels cloud doivent viser Supabase directement et fonctionner sans serveur Node.js.

## Anciennes données locales

Le dossier `data/` reste indépendant de PostgreSQL. Ne pas copier SQLite, ses comptes, ses sessions ou ses mots de passe dans `public/`, `dist/` ou les migrations. Aucune fusion automatique par e-mail n’est effectuée. Les comptes cloud doivent conserver leurs identifiants Auth propres.

Un transfert de questions relues peut utiliser les outils d’import après vérification de leur format et transfert séparé des images. Il n’importe pas automatiquement les parties ou scores. La banque SQL initiale est une banque d’essai distincte, pas une migration des utilisateurs locaux.

Voir aussi le [guide officiel Supabase pour Vue](https://supabase.com/docs/guides/getting-started/quickstarts/vue) et le [guide Cloudflare Pages](CLOUDFLARE_PAGES.md).
