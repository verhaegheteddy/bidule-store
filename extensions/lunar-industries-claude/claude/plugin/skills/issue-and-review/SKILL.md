---
name: issue-and-review
description: Démarre une tâche Notion dans un ou plusieurs dépôts - issue si besoin, branche nommée selon les réglages, MR (GitLab) ou PR (GitHub) en brouillon vers la branche cible, worktree pour travailler, puis poussée de la branche et acceptation de la MR. À utiliser quand l'utilisateur demande de "créer la MR", "commencer la tâche", "créer une branche pour la tâche", "pousser la branche", "merger la MR" ou "accepter la PR", ou quand un autre skill en a besoin.
---

# Issue, branche et MR d'une tâche

L'application fait ce travail comme sa fenêtre « Démarrer… », pour GitLab comme pour GitHub, avec
ses outils `mcp__workspace__*` : ne pas créer la branche ni la MR à la main.

## Étapes

1. Lire la tâche avec `mcp__workspace__read_task` (identifiant Notion ou référence comme
   `ID-101`). Si les dépôts concernés ne sont pas évidents, les proposer à l'utilisateur plutôt
   que de trancher seul (`mcp__workspace__list_repos` donne ceux que l'application connaît).

2. Si la tâche a déjà des branches liées (champ `branches` de la tâche), les réutiliser : ne pas
   démarrer une seconde fois.

3. Sinon, appeler `mcp__workspace__start_task` avec la tâche et les dépôts. Pour chacun, l'outil :
   - crée l'issue quand le nommage des branches l'exige ou que l'utilisateur la demande
     (`issue: true`) ;
   - nomme la branche selon les réglages (`mcp__workspace__workspace_settings` donne le nommage) ;
   - crée la branche sur la forge depuis la branche de départ (par défaut, la branche cible des MR
     du dépôt), puis la MR en brouillon vers cette branche. Sur GitHub, la PR en brouillon ne peut
     être créée qu'après un premier commit : l'outil le signale, et la PR s'ouvre à l'étape 6 ;
   - crée la branche locale sans toucher au checkout principal, et la lie à la tâche.

   L'outil demande confirmation à l'utilisateur. Son résultat dit, dépôt par dépôt, ce que chaque
   étape a fait ou pourquoi elle a échoué : ne pas refaire à la main une étape en échec, rapporter
   l'erreur.

4. Créer le worktree de chaque branche avec `mcp__workspace__worktree_add` (voir le skill
   `worktrees`), puis y travailler. Les commits sont en anglais, sujet seul, au format
   Conventional Commits.

5. Pousser la branche avec `mcp__workspace__push_branch` (dépôt, branche), seulement quand un autre
   skill du flux le demande ou que l'utilisateur le veut ; sinon, l'utilisateur pousse lui-même.

6. Une branche sans MR ni PR (sur GitHub après le démarrage, ou une branche créée avec
   `mcp__workspace__worktree_add`) : une fois un premier commit poussé, ouvrir la MR ou la PR avec
   `mcp__workspace__create_review`. L'outil vérifie que la branche est poussée et, sur GitHub,
   qu'elle a un commit de plus que sa cible ; il renvoie la MR déjà ouverte s'il y en a une.

7. Accepter la MR ou la PR (la merger dans sa branche cible sur la forge), seulement quand
   l'utilisateur le demande : `mcp__workspace__merge_review` (dépôt, branche). Une MR en brouillon
   est refusée ; `ready: true` la sort d'abord du brouillon, avec l'accord de l'utilisateur.

## Restitution

Pour chaque dépôt : la branche, l'issue et la MR (numéro et adresse), et le chemin du worktree.
Signaler toute étape en échec avec son message.
