# Bidule : le store

Ce dépôt public distribue [Bidule](https://github.com/verhaegheteddy/bidule) : rien n'y est écrit à la main, tout
vient de la CI de l'app.

- **L'app** : les releases `vX.Y.Z` (installateurs Windows et macOS, Flatpak). L'app y cherche ses mises à jour.
- **Linux** : `flatpak install --user https://verhaegheteddy.github.io/bidule-store/flatpak/bidule.flatpakref`
  (dépôt Flatpak signé, sur les GitHub Pages de ce dépôt ; mises à jour avec celles du système).
- **Les extensions** : `index.json` et leurs paquets signés, dans les releases `<id>-<version>`. L'app les installe
  depuis Réglages › Extensions.
