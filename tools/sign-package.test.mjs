// node --test tools/sign-package.test.mjs : the package is read, signed and indexed as Bidule checks it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { addToIndex, entryOf } from './sign-package.mjs'

function fixture() {
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
