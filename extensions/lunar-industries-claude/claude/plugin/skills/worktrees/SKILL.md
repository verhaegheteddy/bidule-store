---
name: worktrees
user-invocable: false
description: La règle d'usage des worktrees et du créneau exécutable dans les sessions lancées depuis Bidule. À lire avant de toucher à un dépôt, quand l'utilisateur demande de "créer un worktree", "travailler en parallèle", "prendre ou libérer le créneau", ou quand un autre skill a besoin d'un répertoire de travail isolé.
---

# Worktrees et créneau exécutable

Chaque dépôt n'a qu'un checkout principal, donc une seule branche sortie. Plusieurs sessions qui
travaillent sur le même dépôt se prendraient leur branche : chaque branche a donc son propre
**worktree**, dans `<dépôt>/.claude/worktrees/<branche>/`, avec ses propres fichiers non versionnés
et ses propres dépendances.

## Deux règles

**Ne jamais changer de branche dans un checkout principal** (`git checkout <autre>`, `git switch`,
`git checkout -b`). Il est partagé avec les autres sessions et avec l'utilisateur. Le travail se
fait dans les worktrees ; la session reste à la racine du workspace et travaille dans chaque
worktree par son chemin (`git -C <chemin> …`). Ne pas utiliser `EnterWorktree`.

**Le checkout principal est le seul répertoire qui fait tourner l'application** (base locale, URL
de dev). Un seul travail à la fois peut y être testé : c'est le créneau exécutable, protégé par un
verrou que les sessions du terminal voient aussi.

## Les outils

- `mcp__workspace__list_repos` : les dépôts connus, leur chemin et leur branche cible.
- `mcp__workspace__worktree_add` (`repo`, `branch`, `base` facultatif) : crée le worktree, ou le
  retrouve s'il existe. Une branche existante est reprise ; une nouvelle part de
  `origin/<branche cible>` après un fetch. L'outil recopie les fichiers non versionnés et lance la
  préparation (installation des dépendances) réglées pour le dépôt, et renvoie le chemin.
- `mcp__workspace__worktree_list` (`repo`) et `mcp__workspace__worktree_remove` (`repo`, `branch`).
  La suppression est refusée tant qu'il reste des modifications non committées ; la branche et ses
  commits restent dans le dépôt.
- `mcp__workspace__slot_acquire` (`repos`) : prend le créneau de tous les dépôts demandés, ou
  d'aucun. `mcp__workspace__slot_release` le rend, `mcp__workspace__slot_status` dit qui le tient.
- `mcp__workspace__slot_checkout` (`repo`, `branch`) : sort la branche dans le checkout principal, à
  son dernier commit, quand la session tient le créneau du dépôt.
- `mcp__workspace__merge_branch` (`repo`, `source`, `target`) merge une branche dans une autre, dans
  le worktree de la cible, sans committer ; `mcp__workspace__push_branch` (`repo`, `branch`)
  committe un merge en cours et pousse la branche.

## Le protocole du créneau

1. Avant toute validation devant l'application, prendre le créneau de chaque dépôt à faire tourner.
2. S'il est libre, sortir la branche dans le checkout principal avec `slot_checkout` (seul cas où
   il change de branche, puisqu'on détient le créneau ; à relancer après chaque nouveau commit),
   laisser l'utilisateur tester, puis **rendre le créneau dès qu'il a validé** : `slot_release`
   remet aussi le checkout principal sur sa branche d'intégration.
3. S'il est pris, l'outil dit par quelle session. Prévenir l'utilisateur en une phrase, puis
   **continuer sur ce qui ne demande pas l'application** : compilation, lint, relecture,
   préparation de la MR. Ne jamais attendre en boucle.
4. En fin de session, rendre les créneaux encore tenus.
