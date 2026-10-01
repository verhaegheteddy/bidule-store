---
name: task-to-staging
description: Déroule une tâche Notion de bout en bout jusqu'à la mise en staging - lecture de la tâche, plan validé, issue et MR, implémentation dans des worktrees, validation en local par l'utilisateur, déploiement en staging et commentaire au PO. À utiliser quand l'utilisateur demande de "traiter la tâche ID-xxx", "faire la tâche X", "implémenter cette demande de A à Z".
---

# De la tâche au staging

S'appuie sur les skills `issue-and-review`, `worktrees`, `deploy-staging` et `po-comment`, et
éventuellement `changelog-bump`.

**L'utilisateur valide à trois moments** : le plan avant l'implémentation, le résultat en local
avant le déploiement, et le texte du commentaire avant qu'il parte sur Notion. Ne jamais franchir
une de ces barrières de sa propre initiative.

1. **Lire la tâche** avec `mcp__workspace__read_task` (identifiant, référence comme `ID-101`, ou
   l'identifiant d'une adresse Notion collée). Le contenu de la page porte l'essentiel de la
   demande ; les commentaires, souvent des précisions ou des changements d'avis plus récents.

   Si la tâche est ambiguë ou incomplète, poser les questions **maintenant**, avant de planifier.
   Si un comportement décrit comme anormal peut être voulu, demander si c'est un bug avant de le
   qualifier. Quand l'ambiguïté porte sur l'interface, raisonner d'abord depuis l'utilisateur final
   et son métier, puis recommander ; garder les questions fermées pour ce que seuls l'utilisateur
   ou le PO peuvent savoir. Une action explicite de l'utilisateur qui n'affiche rien est un bug :
   éviter les cas particuliers silencieux.

   Si la tâche est déjà en cours ou plus loin, le signaler : le travail a peut-être commencé
   ailleurs.

2. **Les dépôts concernés** : les déduire de la tâche (`mcp__workspace__list_repos`), et proposer
   le périmètre à l'utilisateur en cas de doute. Ne rien sortir dans les checkouts principaux : le
   travail se fera dans des worktrees (skill `worktrees`).

3. **Le plan.** Explorer le code des dépôts, puis passer en mode Plan et rédiger le plan en
   français : dépôt par dépôt, ce qu'on change, dans quels fichiers, et pourquoi. Rendre explicites
   les points où la tâche laissait le choix, avec l'option retenue et sa raison : ils nourriront le
   commentaire au PO. Soumettre le plan en sortant du mode Plan. **Ne rien implémenter avant que
   l'utilisateur l'ait validé.**

4. **Issue, branche et MR** : appliquer le skill `issue-and-review` pour les dépôts concernés. Une
   fois démarrée, la tâche passe d'elle-même au premier statut « en cours ».

5. **Implémenter** dans les worktrees, en suivant le plan validé. Si l'implémentation montre que le
   plan était faux ou incomplet, s'arrêter et le dire plutôt que dévier en silence. Respecter les
   conventions de chaque dépôt (son `CLAUDE.md`). Ne jamais démarrer ni arrêter soi-même le serveur
   de dev : l'utilisateur le gère. Ne pas pousser : seuls les skills `issue-and-review` et
   `deploy-staging` le font, quand leur flux l'exige.

6. **Valider en local.** Prendre le créneau exécutable de chaque dépôt à faire tourner (skill
   `worktrees`). S'il est pris, prévenir l'utilisateur et continuer sur ce qui ne demande pas
   l'application. Une fois le créneau obtenu, sortir la branche dans le checkout principal
   (`mcp__workspace__slot_checkout`), puis demander à l'utilisateur de vérifier le résultat sur son
   environnement local, en lui donnant de quoi tester : où regarder, quel comportement attendre,
   quels cas particuliers essayer. Traiter ses retours sur la même branche, dans son worktree, puis
   relancer `slot_checkout` et redemander, tant que ce n'est pas bon. **Rendre le créneau dès qu'il a
   validé** (`mcp__workspace__slot_release`, qui remet le checkout principal sur sa branche
   d'intégration), et ne pas passer à l'étape suivante sans son accord explicite.

7. **Déployer en staging** : appliquer le skill `deploy-staging` pour chaque dépôt, tous sur le
   même environnement. Si un pipeline échoue, ne pas déployer : rapporter et laisser l'utilisateur
   décider.

8. **Commenter** : appliquer le skill `po-comment`.

## Restitution finale

La tâche traitée (référence et titre), les dépôts avec pour chacun l'issue, la branche et la MR,
l'environnement de staging et l'état de chaque déploiement, et le commentaire publié, s'il y en a
un.
