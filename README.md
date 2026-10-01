# Bidule : le store

Ce dépôt public distribue [Bidule](https://github.com/verhaegheteddy/bidule) : les paquets et l'index viennent de
la CI de l'app ; seules les sources des modules non officiels (`extensions/`) s'écrivent ici.

- **L'app** : les releases `vX.Y.Z` (installateurs Windows et macOS, Flatpak). L'app y cherche ses mises à jour.
- **Linux** : `flatpak install --user https://verhaegheteddy.github.io/bidule-store/flatpak/bidule.flatpakref`
  (dépôt Flatpak signé, sur les GitHub Pages de ce dépôt ; mises à jour avec celles du système).
- **Les extensions** : `index.json` et leurs paquets signés, dans les releases `<id>-<version>`. L'app les installe
  depuis Réglages › Extensions.

## Les modules non officiels

`extensions/<id>` : les sources des modules qui concurrencent les officiels (Kanban, Branches, Temps, Claude,
Conteneurs…), sur le même modèle qu'une extension de Bidule, avec leur propre id et `"bidule": { "storeOnly": true }`
dans leur `package.json`. Ils respectent les contrats des modules officiels ; on désactive l'officiel dans
Réglages › Extensions pour installer le leur. Ils se construisent, se signent et se publient par le workflow
Extensions de Bidule ; on y travaille en clonant ce dépôt dans le checkout de Bidule (`bidule-store/`) puis
`npm run store:link` (voir `docs/distribution.md` de Bidule).
