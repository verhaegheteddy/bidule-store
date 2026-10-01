---
name: po-comment
description: Rédige et fait valider le commentaire de fin de tâche adressé au PO sur la page Notion de la tâche - quand il est utile, ce qu'il dit, son ton. Utilisé par task-to-staging après le déploiement en staging ; invocable aussi directement.
---

# Commentaire de fin de tâche

Le commentaire vient **après** le déploiement en staging : son destinataire est le PO, qui teste
sur staging.

Il n'a que **deux motifs valables**, et l'absence de commentaire est le cas normal :
- signaler un point qui **diffère** de ce que la tâche demandait (écart assumé, limite connue,
  choix pris là où la tâche laissait le champ libre) ;
- **remonter au PO** un point rencontré pendant le travail, sur lequel il doit se prononcer ou dont
  il doit être informé.

S'il n'y a ni écart ni point à remonter, ne rien publier et le dire dans la restitution.

Relire d'abord les commentaires déjà présents (`mcp__workspace__read_task`) si l'un d'eux attendait
une réponse : y répondre effectivement, sans répéter ce qui a déjà été dit.

## Ce qu'on n'écrit jamais

- ce qui a été implémenté : c'est le contenu de la tâche, que le PO a rédigée, y compris « ce point
  était déjà livré » ;
- comment utiliser la fonctionnalité, ni ce qu'il faut tester : il connaît le produit ;
- les détails d'implémentation (classes, composants, tables, fichiers) : parler du comportement
  observable dans le produit ;
- ce que la tâche porte déjà dans ses propriétés (l'environnement de staging) ;
- la suite à donner : signaler le point, c'est au PO de décider ;
- un symptôme que le PO aurait « pu constater », pour un défaut que personne n'avait remonté : dire
  simplement qu'il n'était pas remonté et qu'il est corrigé.

## Le ton et la longueur

Une discussion d'équipe, pas un rapport : phrases simples, première personne, détails concrets.
Deux ou trois points d'une à deux phrases chacun ; chaque point dit ce qu'il **implique pour le
lecteur** (pourquoi un changement visible n'est pas une régression, par exemple). Exemple :

> Le filtre de dates ne permet pas encore de choisir une période à cheval sur deux années civiles :
> j'ai limité la sélection à l'année en cours en attendant que ce soit nécessaire.

Ne mentionner personne, sauf pour répondre à une question précise qui attendait une réponse de
cette personne.

## Publication

Proposer le texte à l'utilisateur et attendre son accord : c'est un message visible par toute
l'équipe. Une fois validé, `mcp__workspace__comment_task` (l'outil demande aussi confirmation).
