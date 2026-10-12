// node --test tools/sign-package.test.mjs : the package is read, signed and indexed as Bidule checks it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { addToIndex, entryOf } from './sign-package.mjs'

// `prepare` adds to the extension's folder before it is packed.
function fixture(prepare = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sign-package-'))
  const src = join(dir, 'src')
  mkdirSync(join(src, 'ui'), { recursive: true })
  const manifest = {
    id: 'lunar-notes',
    version: '0.2.0',
    title: 'Lunar - Notes',
    engine: '^0.1.2',
    permissions: ['shell'],
    contributes: { pages: [{ id: 'notes', path: '/lunar/notes', title: 'Notes' }] },
  }
  writeFileSync(join(src, 'bidule.json'), JSON.stringify(manifest))
  writeFileSync(join(src, 'package.json'), JSON.stringify({ name: '@bidule/ext-lunar-notes', description: 'Des notes' }))
  writeFileSync(join(src, 'ui/index.js'), 'export default {}')
  prepare(src)
  const file = join(dir, 'lunar-notes-0.2.0.tgz')
  execFileSync('tar', ['czf', file, '-C', src, 'bidule.json', 'package.json', 'ui'])
  return { dir, file }
}

test('a package is read, signed with the private key and indexed', () => {
  const { dir, file } = fixture()
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const data = readFileSync(file)
  const entry = entryOf(data, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())
  assert.equal(entry.id, 'lunar-notes')
  assert.equal(entry.kind, 'modules')
  assert.equal(entry.description, 'Des notes')
  assert.equal(entry.unofficial, true)
  assert.equal(entry.sha256, createHash('sha256').update(data).digest('hex'))
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  assert.ok(verify(null, data, createPublicKey(pem), Buffer.from(entry.signature, 'base64')))
  const index = addToIndex(null, entry, 'https://store.test/lunar-notes-0.2.0.tgz')
  const v = index.extensions['lunar-notes'].versions['0.2.0']
  assert.deepEqual(v.packages.any, {
    url: 'https://store.test/lunar-notes-0.2.0.tgz',
    size: data.length,
    sha256: entry.sha256,
    signature: entry.signature,
  })
  assert.deepEqual([v.engine, v.permissions, v.kind, v.unofficial], ['^0.1.2', ['shell'], 'modules', true])
  rmSync(dir, { recursive: true, force: true })
})

test('the command writes the index beside the package', () => {
  const { dir, file } = fixture()
  const { privateKey } = generateKeyPairSync('ed25519')
  const key = join(dir, 'private.pem')
  writeFileSync(key, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  const index = join(dir, 'index.json')
  const script = fileURLToPath(new URL('./sign-package.mjs', import.meta.url))
  execFileSync(process.execPath, [script, '--key', key, '--index', index, '--url', 'https://store.test/', file])
  const written = JSON.parse(readFileSync(index, 'utf8'))
  assert.equal(written.schema, 1)
  assert.equal(written.extensions['lunar-notes'].versions['0.2.0'].packages.any.url, 'https://store.test/lunar-notes-0.2.0.tgz')
  rmSync(dir, { recursive: true, force: true })
})

test('a key that is not ed25519 is refused', () => {
  const { dir, file } = fixture()
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 })
  assert.throws(() => entryOf(readFileSync(file), privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()), /ed25519/)
  rmSync(dir, { recursive: true, force: true })
})

// An entry as entryOf makes it, without a package.
const entry = (extra = {}) => ({
  id: 'lunar-notes',
  version: '0.2.0',
  title: 'Lunar - Notes',
  description: '',
  engine: '^0.1.2',
  dependencies: {},
  permissions: ['shell', 'network'],
  kind: 'modules',
  unofficial: true,
  platform: 'any',
  size: 1,
  sha256: 's',
  signature: 'x',
  ...extra,
})

test('a package with a link is refused: Bidule would leave it out', () => {
  const { dir, file } = fixture((src) => symlinkSync('index.js', join(src, 'ui/lien.js')))
  const { privateKey } = generateKeyPairSync('ed25519')
  assert.throws(
    () => entryOf(readFileSync(file), privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()),
    /liens ou des fichiers spéciaux.*ui\/lien\.js/
  )
  rmSync(dir, { recursive: true, force: true })
})

test('the command says a refusal in a sentence, exits with 1, and replaces nothing', () => {
  const { dir, file } = fixture()
  const { privateKey } = generateKeyPairSync('ed25519')
  const key = join(dir, 'private.pem')
  writeFileSync(key, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  const index = join(dir, 'index.json')
  const script = fileURLToPath(new URL('./sign-package.mjs', import.meta.url))
  const args = [script, '--key', key, '--index', index, '--url', 'https://store.test/', file]
  execFileSync(process.execPath, args)
  const before = readFileSync(index, 'utf8')
  // The same version, published with other permissions.
  const published = JSON.parse(before)
  published.extensions['lunar-notes'].versions['0.2.0'].permissions = []
  writeFileSync(index, JSON.stringify(published))
  const run = spawnSync(process.execPath, args, { encoding: 'utf8' })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /^Impossible : lunar-notes 0\.2\.0 est déjà publiée avec un autre manifeste/)
  assert.doesNotMatch(run.stderr, /remplacé|at /)
  assert.deepEqual(JSON.parse(readFileSync(index, 'utf8')), published)
  rmSync(dir, { recursive: true, force: true })
})

test('a pre-release is refused: Bidule never offers one', () => {
  assert.throws(() => addToIndex(null, entry({ version: '0.2.0-beta' }), 'u'), /préversion/)
})

test('a version already published with another manifest is refused', () => {
  const index = addToIndex(null, entry(), 'u')
  assert.throws(() => addToIndex(index, entry({ permissions: ['shell'] }), 'u'), /autre manifeste \(permissions\)/)
  assert.throws(() => addToIndex(index, entry({ engine: '^0.2.0' }), 'u'), /autre manifeste \(engine\)/)
  // The same permissions in another order are the same manifest.
  assert.doesNotThrow(() => addToIndex(index, entry({ permissions: ['network', 'shell'] }), 'u'))
})

test('another system’s package is added to a published version', () => {
  const index = addToIndex(null, entry({ platform: 'linux-x64' }), 'linux')
  addToIndex(index, entry({ platform: 'win32-x64' }), 'win')
  const { packages } = index.extensions['lunar-notes'].versions['0.2.0']
  assert.deepEqual(Object.keys(packages).sort(), ['linux-x64', 'win32-x64'])
})
