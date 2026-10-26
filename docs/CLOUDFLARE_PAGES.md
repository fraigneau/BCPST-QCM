# Préparer Cloudflare Pages

Le site à publier est le contenu statique de `dist/`. Supabase fournit Auth, PostgreSQL, Storage et les RPC métier. Aucun serveur Express, base SQLite, Pages Function ou Worker Node.js ne doit être publié.

Ce guide prépare une configuration à relire avant publication. La présence de `wrangler.jsonc` ne crée pas de projet Cloudflare et n’envoie aucun fichier.

## Vérifier avant de connecter Git

1. Appliquer et vérifier les migrations Supabase de `supabase/migrations` dans leur ordre de nom, sans rejouer celles déjà enregistrées.
2. Vérifier le compte administrateur personnel, les permissions SQL et la banque initiale. Voir [Supabase](SUPABASE_SETUP.md).
   Pour la version avec connexion par pseudo, appliquer aussi sa migration et déployer la fonction Supabase `username-login` avant de publier le frontend. Voir [USERNAME_LOGIN.md](USERNAME_LOGIN.md).
3. Configurer `.env.local` pour le backend `supabase`, avec l’URL et la clé publishable du projet.
4. Exécuter depuis la racine :

```sh
npm install
npm test
npm run build
npm run pages:check
npm run preview
```

Tester <http://localhost:4173> avec deux profils de navigateur. Ce preview statique doit fonctionner sans lancer `npm run dev` et sans requête métier à `/api`. Un écran de connexion seul ne suffit pas : terminer un solo, créer un salon et jouer avec deux comptes. Les paramètres `VITE_` sont intégrés lors du build ; les changer exige une reconstruction.

`pages:check` contrôle les variables publiques, leur présence dans le build, le routage SPA, les en-têtes et l’absence de fichiers serveur, de base locale ou de secrets reconnaissables dans `dist`. Il ne se connecte pas à Cloudflare et ne remplace ni les tests SQL ni un audit de sécurité.

## Paramètres du projet Pages

Pour un premier essai sans dépôt Git, Cloudflare accepte aussi un envoi direct du dossier `dist/` : **Workers & Pages → Create application → Get started → Drag and drop your files**, puis choisir le nom et publier les fichiers compilés. Les variables Supabase sont déjà intégrées au build local ; aucune variable de build Cloudflare n’est nécessaire pour cet envoi. À chaque modification, reconstruire et envoyer de nouveau `dist/`. Un projet créé en Direct Upload ne peut pas ensuite être converti en intégration Git ; il faut en créer un autre si l’on veut les publications automatiques. Voir [Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/).

Après validation du résultat local, le propriétaire peut créer un projet **Pages** avec intégration GitHub ou GitLab et sélectionner le dépôt. Choisir le projet Pages statique, avec les réglages suivants :

| Paramètre | Valeur |
| --- | --- |
| Nom | `qcm-bcpst` |
| Branche de production | La branche validée du dépôt |
| Répertoire racine | Racine du dépôt, `/` |
| Commande de build | `npm run build` |
| Répertoire de sortie | `dist` |
| Version Node | `24.18.0`, fournie par `.node-version` |
| Commande de démarrage | Aucune |

Pages construit les fichiers lors des mises à jour de la branche connectée. La sélection du répertoire de sortie et des variables de build est décrite dans la [configuration de build Cloudflare](https://developers.cloudflare.com/pages/configuration/build-configuration/). La version Node peut être fixée par `.node-version`, conformément à la [documentation de l’image de build](https://developers.cloudflare.com/pages/configuration/build-image/).

Le fichier `wrangler.jsonc` fixe le nom, la sortie `./dist` et la date de compatibilité `2026-10-22`. Il ne contient ni secret ni option `nodejs_compat`. Ne pas y ajouter `server/index.ts` comme point d’entrée. Les champs Pages sont documentés dans la [configuration Wrangler pour Pages](https://developers.cloudflare.com/pages/functions/wrangler-configuration/).

## Variables Production et Preview

Le dépôt contient `.env.production` avec le projet Supabase de QCM BCPST et sa clé publishable publique. Vite charge ce fichier pendant `npm run build`, même lorsqu’aucun `.env.local` n’est présent dans le clone Cloudflare. Ces valeurs sont prévues pour être visibles dans le navigateur ; ce fichier ne doit jamais contenir de mot de passe ni de clé secrète. Le build refuse désormais une configuration cloud absente ou invalide.

Pour utiliser un autre projet Supabase, définir ces trois variables de build dans l’environnement concerné. Les variables Cloudflare ont priorité sur `.env.production` :

| Variable | Valeur |
| --- | --- |
| `VITE_BACKEND` | `supabase` |
| `VITE_SUPABASE_URL` | URL HTTPS du projet Supabase |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Clé publique commençant par `sb_publishable_` |

Le fichier `.env.local` n’est pas dans Git et n’est pas envoyé à Pages. Une variable ajoutée après un premier build ne modifie pas ses fichiers : reconstruire le déploiement concerné. Ne jamais ajouter de clé `sb_secret_`, de jeton `service_role`, de chaîne PostgreSQL ou de mot de passe aux variables `VITE_`.

Pour séparer les essais de la production, utiliser un projet Supabase distinct pour Preview et y appliquer les mêmes migrations. Si Preview et Production utilisent le même projet, leurs questions, comptes et scores sont partagés ; ne pas traiter cette Preview comme une base jetable.

## URL et confirmation Supabase Auth

Une fois le domaine final connu, configurer **Authentication → URL Configuration** dans Supabase :

- **Site URL** : origine HTTPS finale, par exemple `https://qcm-bcpst.pages.dev`, ou le domaine personnalisé réellement retenu.
- **Redirect URLs** : URL de retour exacte utilisée par l’application sur ce domaine, et les seules URL Preview autorisées. Ajouter séparément `http://localhost:5173` et `http://localhost:4173` pour les essais locaux si nécessaire.
- Pour une Preview, recopier son origine complète et son chemin de retour, par exemple `https://identifiant.qcm-bcpst.pages.dev`. Éviter une autorisation générale `https://*.pages.dev/**`.

L’inscription utilise la confirmation e-mail selon les réglages Auth. Tant que le client ne fournit pas de redirection explicite, le lien de confirmation revient à la Site URL ; autoriser une Preview ne redirige pas automatiquement ses e-mails vers elle. Vérifier le lien réellement reçu. Conserver la production en Site URL et utiliser un projet Supabase de test lorsque la confirmation doit être essayée sur Preview. Voir les [règles de redirection Supabase](https://supabase.com/docs/guides/auth/redirect-urls).

## Routage, cache et sécurité

Vite copie `public/_redirects` et `public/_headers` dans `dist`. Le retour `/* /index.html 200` permet aux routes Vue, par exemple `/practice` et `/game/...`, de fonctionner après rechargement ou accès direct. Il ne fournit aucune API : une requête erronée à `/api` peut recevoir du HTML, et doit être considérée comme un défaut de configuration du frontend. La syntaxe est celle des [redirections Pages](https://developers.cloudflare.com/pages/configuration/redirects/).

La CSP autorise les scripts du site, les connexions HTTPS/WebSocket aux projets `*.supabase.co`, les images locales ou Supabase et les URL `data:`/`blob:` nécessaires aux illustrations. Les styles inline sont permis pour les propriétés dynamiques Vue ; les scripts inline et `eval` ne le sont pas. Aucun CDN de polices ou de scripts n’est requis. Si un domaine Supabase personnalisé est ajouté plus tard, adapter la CSP et le contrôle Pages avant publication.

Le HTML et les routes de l’application utilisent `no-cache` ; les assets nommés par hash dans `/assets/` sont conservés un an avec `immutable`. Les règles n’ajoutent pas plusieurs valeurs `Cache-Control` contradictoires au même chemin. Les en-têtes incluent `nosniff`, le refus d’intégration dans une iframe et HSTS sans `preload` ni extension automatique aux sous-domaines. Leur application aux fichiers statiques est décrite dans la [documentation des en-têtes Pages](https://developers.cloudflare.com/pages/configuration/headers/).

Le serveur Vite de preview ne reproduit pas `_headers`. Vérifier sur la Preview Pages les en-têtes des réponses HTML et des assets, ainsi que l’absence de violation CSP dans la console. Ne pas ajouter une règle « Cache Everything » sur le domaine de l’application.

## Recette de la Preview Pages

Avant d’ouvrir l’application aux élèves :

1. Ouvrir directement `/connexion`, `/practice` et une URL de partie autorisée, puis recharger : pas de 404 de route Vue.
2. Se connecter avec son compte personnel et confirmer les droits attendus. Les boutons de démonstration doivent être absents.
3. Vérifier connexion, confirmation e-mail, rechargement et déconnexion. Aucun jeton ne doit être ajouté aux URL ou aux captures partagées.
4. Terminer un solo : absence de chrono, 100 points par bonne réponse, correction et progression persistantes après rechargement.
5. Jouer sur deux appareils avec deux comptes : code, même question, délai de 30 secondes, correction commune et classement final.
6. Passer un téléphone en arrière-plan puis revenir : l’état doit reprendre avec l’échéance PostgreSQL, sans recommencer le chrono.
7. Tester un contributeur : brouillon, image, proposition, refus ou validation administrateur. Vérifier l’affichage des images signées.
8. Contrôler dans l’onglet Réseau que les appels métier vont à Supabase, pas à `localhost`, une IP privée ou `/api`.
9. Tester les tailles téléphone, le clavier et le lancement depuis l’écran d’accueil sur Android et iPhone réels.

Le moteur cloud n’utilise pas de Cron ni de processus de jeu permanent. L’horloge PostgreSQL décide de l’expiration et chaque lecture d’état peut faire avancer les transitions dues. Sans joueur connecté, cette avancée est différée jusqu’au prochain appel ; la reprise applique les échéances conservées. Le polling d’environ une seconde implique un léger délai d’affichage entre appareils.

## Données existantes et retour arrière

Les comptes, sessions, mots de passe, scores et fichiers de `data/` ne sont pas publiés et ne sont pas automatiquement migrés. L’initialisation SQL cloud fournit une banque distincte de 50 questions attribuées à un administrateur ; ne pas fusionner des identités sur la seule égalité d’e-mail.

Revenir à un déploiement frontend précédent ne restaure pas PostgreSQL ni Storage. Sauvegarder les données cloud et relire la compatibilité des migrations avant une mise à jour. Aucune publication, migration distante ou restauration n’est déclenchée par ce guide.
