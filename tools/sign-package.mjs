#!/usr/bin/env node
// Signs a Bidule extension package and adds it to a store's index, with Node alone (no dependency).
//
//   node tools/sign-package.mjs --key <clé-privée.pem> --index <index.json> --url <URL de base> [--platform any] <paquet.tgz>
//
// The package is a .tgz already built (see docs/creer-un-store.md): its bidule.json and package.json are read inside
// it. The index gets, for that extension and version, the package's address (`<URL de base>/<nom du fichier>`), size,
// sha256 and ed25519 signature: the same format as the official store's (bidule's scripts/store-index.mjs). Every
// package of a store the user added is the community's (`unofficial: true`). The private key never goes in a repo.
import { createHash, createPrivateKey, sign } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'

// The files of a tar archive (ustar, as `tar` and npm's tar write it), by name without a leading `./`.
export function untar(data) {
  const files = new Map()
  let at = 0
  let longName = null
  while (at + 512 <= data.length) {
    const header = data.subarray(at, at + 512)
    if (header.every((b) => b === 0)) break
    const field = (from, length) => header.subarray(from, from + length).toString('utf8').replace(/\0.*$/s, '')
    const size = parseInt(field(124, 12).trim() || '0', 8)
    const type = field(156, 1)
    const prefix = field(345, 155)
    let name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100))
    longName = null
    const body = data.subarray(at + 512, at + 512 + size)
    if (type === 'L') longName = body.toString('utf8').replace(/\0.*$/s, '')
    else if (type === 'x') {
      // A pax header: its `path` names the next entry.
      const path = /\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))
      if (path) longName = path[1]
    } else if (type === '0' || type === '') {
      name = name.replace(/^\.\//, '')
      files.set(name, body)
    }
    at += 512 + Math.ceil(size / 512) * 512
  }
  return files
}

// Its group in the app, as Bidule's core decides it (kindOf): a mascot, a connector (a role), a module (a page).
export function kindOf(manifest) {
  const c = manifest.contributes ?? {}
  if (c.mascots?.length) return 'mascots'
  if (c.provides?.length) return 'connectors'
  if (c.pages?.length) return 'modules'
  return 'connectors'
}

// The package's entry in the index, signed with the private key (PEM).
export function entryOf(data, privateKeyPem, platform = 'any') {
  const files = untar(gunzipSync(data))
  const manifestFile = files.get('bidule.json')
  if (!manifestFile) throw new Error('Pas de bidule.json à la racine du paquet')
  const manifest = JSON.parse(manifestFile.toString('utf8'))
  const pkg = files.has('package.json') ? JSON.parse(files.get('package.json').toString('utf8')) : {}
  for (const field of ['id', 'version', 'title', 'engine']) {
    if (typeof manifest[field] !== 'string' || !manifest[field]) throw new Error(`bidule.json : ${field} manquant`)
  }
  const key = createPrivateKey(privateKeyPem)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('La clé doit être une clé privée ed25519')
  return {
    id: manifest.id,
    version: manifest.version,
    title: manifest.title,
    description: typeof pkg.description === 'string' ? pkg.description : '',
    engine: manifest.engine,
    dependencies: manifest.dependencies ?? {},
    permissions: manifest.permissions ?? [],
    kind: kindOf(manifest),
    unofficial: true,
    platform,
    size: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
    signature: sign(null, data, key).toString('base64'),
  }
}

// The index with this package added (the latest version describes the extension).
export function addToIndex(index, entry, url) {
  const out = index ?? { schema: 1, extensions: {} }
  const ext = (out.extensions[entry.id] ??= { title: entry.title, description: entry.description, versions: {} })
  ext.title = entry.title
  ext.description = entry.description
  const version = (ext.versions[entry.version] ??= {
    engine: entry.engine,
    dependencies: entry.dependencies,
    permissions: entry.permissions,
    kind: entry.kind,
    unofficial: entry.unofficial,
    released: new Date().toISOString().slice(0, 10),
    packages: {},
  })
  version.packages[entry.platform] = { url, size: entry.size, sha256: entry.sha256, signature: entry.signature }
  return out
}

function main(argv) {
  const args = { platform: 'any' }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) args[a.slice(2)] = argv[++i]
    else rest.push(a)
  }
  const [file] = rest
  if (!file || !args.key || !args.index || !args.url) {
    console.error(
      'Usage : node tools/sign-package.mjs --key <clé-privée.pem> --index <index.json> --url <URL de base> [--platform any] <paquet.tgz>'
    )
    process.exit(2)
  }
  const data = readFileSync(file)
  const entry = entryOf(data, readFileSync(args.key, 'utf8'), args.platform)
  const index = existsSync(args.index) ? JSON.parse(readFileSync(args.index, 'utf8')) : null
  const url = `${args.url.replace(/\/$/, '')}/${basename(file)}`
  writeFileSync(args.index, `${JSON.stringify(addToIndex(index, entry, url), null, 2)}\n`)
  console.log(`${entry.id} ${entry.version} (${entry.platform}) → ${url}`)
}

// Run as a command, not imported (its tests).
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2))
