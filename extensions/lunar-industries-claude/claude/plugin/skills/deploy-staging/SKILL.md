---
name: deploy-staging
description: Merge une branche de travail dans la branche de staging du dépôt, pousse, attend le pipeline et lance le job manuel de déploiement sur l'environnement de staging voulu, puis passe la tâche au statut de test. À utiliser quand l'utilisateur demande de "déployer en staging", "mettre sur staging-02", ou quand task-to-staging arrive à cette étape.
---

# Déploiement en staging

Les branches, les jobs et les environnements viennent des réglages de l'application :
`mcp__workspace__workspace_settings` donne, pour chaque dépôt, la branche de staging, le modèle du
nom du job de déploiement (`{env}` y est remplacé par l'environnement), les environnements et celui
par défaut, et le statut Notion d'une tâche en test. Ne rien supposer qui n'y figure pas ; si un
réglage manque, le demander à l'utilisateur.

La branche de staging est une branche d'intégration : on y **merge** les branches de travail pour
les tester. Ce n'est pas la cible des MR, qui restent ouvertes.

## Environnement

L'environnement par défaut du dépôt, sauf si l'utilisateur en précise un autre. S'il n'est pas dans
la liste réglée, le signaler et proposer ceux qui existent. Quand plusieurs dépôts sont déployés
pour une même tâche, ils partent **tous sur le même environnement**, sans quoi le test ne veut rien
dire.

## Étape 1 — Merger dans la branche de staging

`mcp__workspace__merge_branch` (dépôt, `source` : la branche de travail, `target` : la branche de
staging) fait le merge dans le worktree de la branche de staging, qu'il crée au besoin et met à jour
depuis origin, jamais dans le checkout principal. Il ne committe pas le merge : il renvoie le chemin
du worktree et les fichiers en conflit.

En cas de conflit, résoudre en union fidèle des deux côtés, sans refactoring au passage. Le cas le
plus fréquent : la branche de staging contient un correctif récent sur du code que la branche de
travail a déplacé ; la bonne résolution est la structure de la branche de travail avec le contenu
du correctif, reporté à son nouvel emplacement. Ne jamais prendre un côté en bloc sans avoir lu les
deux. Une branche de travail très en retard sur la branche cible se rattrape chez elle (merger la
branche cible dans la branche de travail), pas dans la branche de staging. En cas de doute,
s'arrêter et laisser l'utilisateur trancher.

## Étape 2 — Vérifier avant de committer le merge

Lancer les vérifications du dépôt (compilation, build, lint, formatage) telles que ses
`package.json` et `CLAUDE.md` les décrivent, dans le worktree. Un merge sans conflit peut casser la
compilation (un identifiant renommé d'un côté et utilisé de l'autre) : c'est ici qu'on le voit. Ne
pas reformater tout le dépôt ni modifier la configuration du lint.

Une fois les conflits résolus, ajouter les fichiers résolus à l'index (`git -C <worktree> add`),
sans committer : l'étape suivante committe le merge avec son message classique
(`Merge branch '<branche-de-travail>' into <branche de staging>`).

## Étape 3 — Pousser

`mcp__workspace__push_branch` (dépôt, branche de staging) committe le merge puis pousse. Il refuse
tant qu'il reste un conflit ou une modification non committée. C'est la seule poussée de ce flux.

## Étape 4 — Attendre le pipeline, puis déployer

`mcp__workspace__wait_pipeline` (dépôt, branche de staging, job de déploiement) attend que le
pipeline du dernier commit soit prêt : les jobs dont dépend le déploiement ont réussi et le job
manuel attend. Vérifier que le commit du pipeline est bien celui qu'on vient de pousser. Si un job
échoue, **ne pas déployer** : rapporter le job en échec et laisser l'utilisateur décider.

Puis `mcp__workspace__play_job` avec l'identifiant du job de déploiement (donné par
`mcp__workspace__branch_state`), et de nouveau `mcp__workspace__wait_pipeline` pour attendre son
issue.

## Étape 5 — Passer la tâche en test

Seulement si la tâche est connue (l'utilisateur la nomme, ou elle a été établie plus tôt). Ne pas
partir à sa recherche. `mcp__workspace__set_task_status` avec le statut de test réglé.

## Restitution

Le commit du merge, l'adresse du pipeline, l'état de chaque étape et l'adresse du job de
déploiement. Rappeler que la MR vers la branche cible reste ouverte.
