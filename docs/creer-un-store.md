# Créer un store d'extensions pour Bidule

Bidule installe ses extensions depuis des **stores** : le sien (ce dépôt), et ceux qu'une personne ajoute dans
Réglages › Extensions › Stores. Un store, c'est un fichier `index.json` servi en https, des paquets `.tgz` qu'il
référence, et une paire de clés ed25519 : la clé privée signe les paquets, la clé publique est donnée à ceux qui
ajoutent le store. Bidule refuse tout paquet dont l'empreinte ne correspond pas à l'index ou dont la signature ne vient
pas de la clé du store qui le propose.

Ce que Bidule garantit à ses utilisateurs :

- une extension proposée par le store de Bidule (ou livrée avec l'app) ne vient **jamais** d'un autre store : un
  store ajouté ne peut pas remplacer `matrix` ou `kanban`, il est ignoré pour ces ids (Réglages le signale) ;
- tout ce qui vient d'un store ajouté est marqué **Communautaire**, avec le nom du store ;
- une extension communautaire tourne avec les mêmes droits que l'app : n'invitez à ajouter votre store que des
  personnes qui vous font confiance, et ne publiez que ce que vous avez relu.

## 1. Les clés

Une paire ed25519, une fois pour toutes. La clé privée ne quitte jamais votre machine (ni dépôt, ni CI publique ;
dans une CI, un secret chiffré).

```sh
openssl genpkey -algorithm ed25519 -out store-private.pem
openssl pkey -in store-private.pem -pubout -out store-public.pem
chmod 600 store-private.pem
```

Sans openssl, avec Node :

```sh
node -e "const {generateKeyPairSync:g}=require('crypto');const {privateKey:k,publicKey:p}=g('ed25519');
require('fs').writeFileSync('store-private.pem',k.export({type:'pkcs8',format:'pem'}),{mode:0o600});
require('fs').writeFileSync('store-public.pem',p.export({type:'spki',format:'pem'}))"
```

`store-public.pem` (`-----BEGIN PUBLIC KEY-----…`) est ce que vous publiez et ce que les gens collent dans Bidule.

## 2. Une extension

Une extension est un dossier dont le nom est son **id** (`[a-z][a-z0-9-]*`). Choisissez un préfixe à vous
(`lunar-industries-…`) : un id déjà pris par Bidule serait ignoré.

```
<id>/
  bidule.json            le manifeste
  package.json           "name": "@bidule/ext-<id>", "type": "module", "exports": { "./server/*": "./server/*.js" }
  server/index.js        export async function activate(ctx) { … }        (facultatif)
  server/routes.js       export default function routes(router) { … }    (facultatif)
  server/controllers/…   chargés à la première requête
  database/migrations/…  migrations Lucid (AdonisJS), tables préfixées `<id>_` avec des tirets bas (facultatif)
  ui/index.js            l'interface : export default { pages, settings, commands, background, kanban… } (facultatif)
  ui/style.css           ses styles (facultatif)
  node_modules/          ses propres dépendances npm, installées pour le paquet
```

Le manifeste, au minimum :

```jsonc
{
  "id": "lunar-notes",
  "version": "0.1.0",                       // semver
  "title": "Lunar - Notes",
  "engine": "^0.1.2",                       // versions du cœur de Bidule acceptées : *, 1.2.3, >=1.2.3, ^1.2.3
  "dependencies": {},                       // autres extensions, par id et plage de versions
  "permissions": [],                        // "shell" : lancer des commandes dans un terminal (demandé à l'install)
  "contributes": {
    "pages": [{ "id": "notes", "path": "/lunar/notes", "title": "Notes", "order": 70 }],
    "commands": [{ "id": "lunar-notes.open", "title": "Ouvrir les notes" }],
    "events": ["lunar-notes.changed"],
    "settings": { "title": "Lunar - Notes", "fields": [{ "key": "lunar-notes.folder", "type": "text", "title": "Dossier", "default": "" }] },
    "requires": [], "uses": []              // rôles : tasks, timeLog, git, chat, terminal…
  }
}
```

Règles que Bidule vérifie au chargement (une extension qui les enfreint est affichée en erreur et ne fait rien) :

- l'`id` est le nom du dossier, et `package.json` s'appelle `@bidule/ext-<id>` ;
- commandes, événements et réglages commencent par `<id>.` (sauf ceux des rôles qu'elle tient) ;
- un chemin de page commence par `/` et n'est ni `/` ni `/reglages`, ni celui d'une autre extension ;
- `engine` doit accepter la version du cœur de l'app.

### Le serveur

Du JavaScript ESM pour Node 24, compilé depuis TypeScript si vous voulez (esbuild, `format: 'esm'`), chaque fichier à
sa place (`server/…`, `database/…`) et les imports relatifs en `.js`. `activate(ctx)` reçoit le contexte de
l'extension : `ctx.commands`, `ctx.events`, `ctx.settings`, `ctx.secrets` (trousseau du système), `ctx.db` (Lucid),
`ctx.use(rôle)` / `ctx.has(rôle)`, `ctx.dataDir()`, `ctx.logger`. Ses routes sont montées sous `/api/ext/<id>` ;
un contrôleur s'importe par son nom de paquet : `import('@bidule/ext-<id>/server/controllers/notes_controller')`.
Les paquets du cœur (`@adonisjs/core`, `@vinejs/vine`, `@adonisjs/lucid`…) sont fournis par l'app : ne les mettez
pas dans vos dépendances.

### L'interface

Un module ES (`ui/index.js`, plus ses morceaux s'il en a, et `ui/style.css`), construit avec React (Vite en mode
bibliothèque, par exemple). Ces modules viennent de l'app et **doivent rester externes** (jamais embarqués) :

```
react, react/jsx-runtime, react/jsx-dev-runtime, react/compiler-runtime, react-dom, react-dom/client, @bidule/sdk
```

Avec Vite : `build: { lib: { entry: 'ui/index.tsx', formats: ['es'], fileName: 'index', cssFileName: 'style' },
rollupOptions: { external: [ …la liste ci-dessus… ] } }`. Le reste (vos bibliothèques) est embarqué. L'export par
défaut décrit ce que l'extension ajoute : ses pages (`pages: { <id de page>: Composant }`), le panneau de ses réglages,
les commandes qui s'exécutent dans l'interface, un composant `background` toujours monté, ce qu'elle ajoute aux cartes
du Kanban.

### Le paquet

Un `.tgz` dont la racine contient directement `bidule.json` (pas de dossier englobant) :

```sh
cd build/lunar-notes && npm install --omit=dev && tar czf ../../lunar-notes-0.1.0.tgz *
```

Avec du code natif (un fichier `.node`, un programme par système), faites un paquet par système et donnez sa
plateforme (`linux-x64`, `win32-x64`, `darwin-arm64`…) ; sinon la plateforme est `any`.

## 3. L'index

`index.json`, tel que Bidule le lit :

```jsonc
{
  "schema": 1,
  "extensions": {
    "lunar-notes": {
      "title": "Lunar - Notes",
      "description": "Des notes à côté des tâches",
      "versions": {
        "0.1.0": {
          "engine": "^0.1.2",
          "dependencies": {},
          "permissions": [],
          "kind": "modules",              // connectors (tient ou enrichit un rôle), modules (une page), mascots
          "unofficial": true,
          "released": "2026-10-01",
          "packages": {
            "any": {                      // ou une plateforme : linux-x64, win32-x64, darwin-arm64…
              "url": "https://github.com/moi/mon-store/releases/download/lunar-notes-0.1.0/lunar-notes-0.1.0.tgz",
              "size": 12345,              // octets
              "sha256": "…",              // hexadécimal, du .tgz
              "signature": "…"            // ed25519 du .tgz, en base64
            }
          }
        }
      }
    }
  }
}
```

L'app propose la version la plus récente dont `engine` accepte son cœur et qui a un paquet pour son système (ou
`any`). Gardez les anciennes versions : une app plus ancienne en a besoin.

`tools/sign-package.mjs` (dans ce dépôt, Node seul, sans dépendance) remplit tout ça pour un paquet déjà construit :

```sh
node tools/sign-package.mjs --key ~/store-private.pem --index index.json \
  --url https://github.com/moi/mon-store/releases/download/lunar-notes-0.1.0 [--platform any] lunar-notes-0.1.0.tgz
```

Il lit `bidule.json` et `package.json` dans le paquet, calcule taille, sha256 et signature, et ajoute la version à
l'index (en le créant s'il n'existe pas). Ses tests : `node --test tools/sign-package.test.mjs`.

## 4. Héberger

N'importe quel serveur https fait l'affaire. Sur GitHub :

1. un dépôt public avec `index.json` sur la branche principale : son adresse brute est l'index du store,
   `https://raw.githubusercontent.com/<vous>/<dépôt>/main/index.json` ;
2. une release par version d'extension (`lunar-notes-0.1.0`), qui porte le `.tgz` : son adresse de téléchargement va
   dans `--url` ;
3. le dépôt peut aussi publier `store-public.pem`, pour que les gens copient la clé.

Le nom du fichier d'une release ne doit pas contenir d'espace (GitHub les change en points, et l'adresse de l'index ne
correspondrait plus).

Pour essayer en local avant de publier, Bidule accepte un index en `http` sur cette machine seulement :
`python3 -m http.server 8765` dans le dossier de l'index, puis `http://127.0.0.1:8765/index.json`.

## 5. L'ajouter dans Bidule

Réglages › Extensions › Stores › **Ajouter un store** : un nom, l'adresse de l'index, la clé publique (le contenu de
`store-public.pem`). Bidule lit l'index aussitôt et refuse un store qui ne répond pas. Ses extensions apparaissent dans
la liste, marquées « Communautaire · <nom du store> ». Retirer un store laisse en place ce qui en a été installé, sans
plus de mises à jour.
