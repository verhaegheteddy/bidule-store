# Bidule : le store

Ce dépôt public distribue [Bidule](https://github.com/verhaegheteddy/bidule) : les paquets et l'index viennent de
la CI de l'app. Il porte aussi le guide et l'outil de ceux qui tiennent leur propre store.

- **L'app** : les releases `vX.Y.Z` (installateurs Windows et macOS, Flatpak). L'app y cherche ses mises à jour.
- **Linux** : `flatpak install --user https://verhaegheteddy.github.io/bidule-store/flatpak/bidule.flatpakref`
  (dépôt Flatpak signé, sur les GitHub Pages de ce dépôt ; mises à jour avec celles du système).
- **Les extensions** : `index.json` et leurs paquets signés, dans les releases `<id>-<version>`. L'app les installe
  depuis Réglages › Extensions.

## Créer votre propre store

Bidule accepte d'autres stores que celui-ci (Réglages › Extensions › Stores) : un `index.json`, des paquets signés
avec votre clé. Le guide : [docs/creer-un-store.md](docs/creer-un-store.md) ; l'outil qui signe et indexe un paquet :
`tools/sign-package.mjs` (Node seul).

## Les modules communautaires

Les modules qui concurrencent les officiels (Kanban, Branches, Temps, Claude, Conteneurs…) ne sont pas dans ce dépôt :
chacun vit dans le store de son auteur, qui le construit, le signe avec la clé de son store et le publie. Ils ont leur
propre id et respectent les contrats des modules officiels ; on désactive l'officiel dans Réglages › Extensions pour
installer le leur.

Ce store peut suggérer le store d'un auteur : le champ `suggestedStores` de `index.json` donne son nom, une courte
description, l'adresse de son index et sa clé publique. Bidule le montre dans Réglages › Stores, sous « Stores
suggérés par Bidule », avec l'empreinte de sa clé, et l'utilisateur l'ajoute d'un clic. Rien n'est ajouté sans lui.
Pour que votre store soit suggéré, demandez-le par une issue ou une pull request sur ce dépôt, avec ces quatre
informations. Les sources de vos extensions doivent être publiques, et vos extensions doivent respecter les contrats
du cœur de Bidule avec leurs propres ids.
