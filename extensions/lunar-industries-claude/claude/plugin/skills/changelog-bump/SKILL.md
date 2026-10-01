---
name: changelog-bump
description: Rédige l'entrée de CHANGELOG.md à partir des merges depuis la dernière release, monte la version (package.json et son lock, par npm) et committe le tout. À utiliser quand l'utilisateur demande de "faire le changelog", "bumper la version" ou de préparer une release.
---

# Changelog et montée de version

## Étapes

1. **État des lieux.** Dans le dépôt concerné, lire la version de `package.json` et la dernière
   entrée de `CHANGELOG.md`. Vérifier que l'arbre de travail est propre. Ne pas changer de branche
   dans le checkout principal : si le dépôt n'est pas sur la branche voulue, travailler dans le
   worktree de cette branche (skill `worktrees`).

2. **Changements depuis la dernière release.** Le dernier commit qui a touché le changelog :
   `git log -1 --format=%H -- CHANGELOG.md`, puis `git log --oneline <commit>..HEAD`. Ce sont les
   merges de branches de travail qui font foi, pas les commits intermédiaires ni les merges
   techniques entre branches d'intégration ; au besoin, lire les commits et le diff d'une branche
   pour comprendre ce qu'elle apporte.

3. **L'entrée**, en tête de `CHANGELOG.md` :

   ```markdown
   ## X.Y.Z - AAAA-MM-JJ

   -   Added: ...
   -   Changed: ...
   -   Fixed: ...
   ```

   En français, une ligne par changement fonctionnel, préfixée selon sa nature. Reprendre
   l'indentation déjà utilisée dans le fichier. Date du jour, version montée à l'étape 4.

4. **La version.** Un correctif (patch) par défaut ; mineure ou majeure seulement si c'est demandé
   ou si un changement cassant est évident. Si la dernière entrée du changelog est plus récente que
   la version de `package.json`, monter au-delà pour les remettre d'accord, et le signaler. Passer
   par `npm version X.Y.Z --no-git-tag-version` ; ne jamais modifier `package-lock.json` à la main.

5. **Le commit** : changelog, `package.json` et lock ensemble, message
   `chore: changelog and bump version`. Ne pas pousser.

## Restitution

La nouvelle version, les entrées ajoutées et le commit.
