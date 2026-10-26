# Connexion par pseudo ou adresse e-mail

Le frontend utilise Supabase Auth directement pour une adresse e-mail. Un pseudo passe par la fonction Supabase `username-login`, qui recherche le compte en privé puis délègue la vérification du mot de passe à Supabase Auth. Le navigateur ne reçoit aucun annuaire d’adresses e-mail.

## Activer la partie cloud

Appliquer d’abord `supabase/migrations/20261026160000_username_auth.sql` dans le SQL Editor du projet, puis exécuter `supabase/tests/username_auth.sql`, qui doit terminer par `passed` et annule ses données de test. Ne pas rejouer les anciennes migrations. La fonction attend une colonne `public.profiles.username` normalisée et unique. La migration attribue un pseudo aux comptes existants à partir du nom affiché, en ajoutant un suffixe en cas de doublon ; elle ne change ni les rôles ni les mots de passe. Le pseudo obtenu est visible et modifiable dans « Moi ».

Ces fichiers sont préparés dans le dépôt. Ils n’ont pas été appliqués au projet distant depuis cette session : le connecteur Supabase n’est pas disponible et aucun PostgreSQL local n’est démarré. Déployer la migration et la fonction avant de publier le nouveau formulaire d’inscription.

Depuis un terminal Supabase CLI connecté au projet :

```sh
npx supabase functions deploy username-login --project-ref bogagjweldkzbgdvpxsw
```

Si le CLI n’est pas encore connecté, commencer par `npx supabase login`. Le CLI déploie la fonction ; le `git push` du frontend Cloudflare ne la déploie pas. Le nom du compte dans l’application, le pseudo de connexion et le compte du tableau de bord Supabase sont distincts. Pour créer un compte comme Yann, une adresse e-mail reste nécessaire à l’inscription.

La section `[functions.username-login]` de `supabase/config.toml` utilise `verify_jwt = false`, car la connexion précède l’existence d’une session utilisateur. Le mot de passe reste vérifié par Auth ; aucun rôle ne vient de la requête du navigateur. Les [règles d’authentification des Edge Functions](https://supabase.com/docs/guides/functions/auth) décrivent cette séparation.

La fonction utilise les variables serveur Supabase standard `SUPABASE_URL`, `SUPABASE_ANON_KEY` et `SUPABASE_SERVICE_ROLE_KEY`. Aucune clé privilégiée ne doit être ajoutée aux variables `VITE_`, au frontend, aux exemples de requêtes ou aux journaux. Les clients privilégié et public sont distincts et ne conservent aucune session.

Les origines autorisées par défaut sont `https://bcpst-qcm.pages.dev`, `http://localhost:5173`, `http://localhost:4173` et leurs équivalents `127.0.0.1`. Pour un domaine personnalisé ou une Preview, fournir la liste complète des origines exactes dans la variable serveur `ALLOWED_ORIGINS`, séparées par des virgules, puis redéployer. Cette liste remplace les valeurs par défaut.

```sh
npx supabase secrets set ALLOWED_ORIGINS=https://bcpst-qcm.pages.dev,http://localhost:5173,http://localhost:4173 --project-ref bogagjweldkzbgdvpxsw
```

Le préflight est traité et la liste d’en-têtes CORS provient de la même version du SDK que la fonction. Voir [CORS pour les Edge Functions](https://supabase.com/docs/guides/functions/cors).

## Contrat et vérification

La fonction accepte uniquement `POST` JSON avec `identifier` et `password`. Le pseudo est normalisé en minuscules et doit contenir de 3 à 24 caractères ASCII : lettres, chiffres, point, tiret ou underscore, avec une lettre ou un chiffre au début. Le mot de passe n’est ni normalisé ni journalisé.

Une réussite renvoie seulement `access_token` et `refresh_token`, produits par Auth. Le frontend doit installer ces jetons avec `auth.setSession`. Un pseudo absent ou désactivé effectue également une tentative Auth avec une adresse aléatoire non existante. Un refus garde le même message pour un pseudo inconnu, un mauvais mot de passe ou un compte non autorisé. Une panne de configuration, de base ou d’Auth renvoie une indisponibilité distincte. Cette uniformité ne constitue pas une garantie cryptographique d’égalité des temps de réponse.

La fonction n’émet aucun lien administratif, ne change aucun mot de passe, ne désactive aucun facteur MFA et ne fabrique pas de JWT. Elle utilise le même [flux Auth par mot de passe](https://supabase.com/docs/reference/javascript/auth-signinwithpassword) que la connexion e-mail. Les politiques d’accès et éventuelles exigences MFA du projet restent à conserver et à tester.

Après déploiement, vérifier : connexion par e-mail existante, connexion par pseudo avec différentes casses, mauvais mot de passe, pseudo inconnu, compte désactivé, absence de clé privilégiée dans le build et absence d’e-mail dans les réponses d’échec. Tester depuis le domaine Pages réel ; les tests Node ne prouvent pas le déploiement distant.

## Limites de tentatives

Auth conserve ses protections habituelles. La fonction ajoute un frein en mémoire de vingt tentatives par minute et par pseudo sur une instance chaude, avec une mémoire bornée. Ce frein ne remplace pas une limite distribuée : un redémarrage ou une autre instance possède son propre compteur.

Les requêtes Auth partant d’une fonction peuvent partager son quota IP. Aucun en-tête IP fourni par le navigateur n’est relayé. Le relais `Sb-Forwarded-For` exige une clé secrète moderne, une activation explicite du projet et une source IP serveur de confiance ; les clés `anon` et `service_role` historiques ne suffisent pas. À plus forte charge, prévoir ce relais dans un proxy vérifié ou une limitation distribuée. Voir les [limites et le relais IP Supabase Auth](https://supabase.com/docs/guides/auth/rate-limits).
