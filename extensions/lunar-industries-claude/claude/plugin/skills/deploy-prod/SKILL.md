---
name: deploy-prod
description: Merge la branche cible (d'intégration) dans la branche de production du dépôt, pousse, et lance le job manuel de déploiement en production. À utiliser quand l'utilisateur demande de "déployer en prod", "mettre en production".
---

# Déploiement en production

La branche de production et le job de déploiement viennent des réglages de l'application
(`mcp__workspace__workspace_settings`, par dépôt) ; la branche d'intégration est la branche cible
des MR du dépôt. Si un réglage manque, le demander à l'utilisateur.

Avant de s'inquiéter d'un écart entre la production et l'intégration, lister les vrais commits
(`git log --oneline --no-merges <intégration>..<production>`) : l'essentiel de l'écart est en
général fait de merges déjà livrés. Un vrai commit né en production (un correctif urgent) devrait
être reporté dans la branche d'intégration : le signaler.

## Étapes

1. `mcp__workspace__merge_branch` (dépôt, `source` : la branche d'intégration, `target` : la
   branche de production) fait le merge dans le worktree de la branche de production, jamais dans
   le checkout principal, sans le committer. En cas de conflit, s'arrêter et laisser l'utilisateur
   trancher : la production ne se corrige pas pendant un merge. Puis
   `mcp__workspace__push_branch` (dépôt, branche de production) committe le merge et pousse.
2. Pousser ne déploie rien : le job de production est manuel. `mcp__workspace__wait_pipeline`
   attend que les jobs dont il dépend aient réussi. Le pipeline peut s'afficher réussi sans que le
   déploiement ait eu lieu : c'est l'état du job qui compte.
3. Si un job échoue, ne pas déployer : rapporter le job en échec et laisser l'utilisateur décider.
   Sinon, `mcp__workspace__play_job` avec l'identifiant du job de production, puis
   `mcp__workspace__wait_pipeline` pour attendre son issue.

Quand une migration de données accompagne la livraison, déployer l'API d'abord, jouer la
migration ensuite, et le front en dernier ; demander l'ordre à l'utilisateur en cas de doute.

## Restitution

Le commit du merge, l'adresse du pipeline, l'état des jobs dont dépend le déploiement, et
l'adresse du job lancé (ou la raison pour laquelle il ne l'a pas été).
