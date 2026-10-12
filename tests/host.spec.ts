import { test } from '@japa/runner'
import type { ApiClient } from '@japa/api-client'
import app from '@adonisjs/core/services/app'
import testUtils from '@adonisjs/core/services/test_utils'
import { ExtensionHost } from '#extensions/host'

// The contract between Bidule's core and a store's extensions, checked in the core's real host (Bidule's
// `node ace test`), not in a fake context: what the core accepts of an extension built as docs/creer-un-store.md says.
// Its subject is tests/fixtures/store-probe, the smallest such extension, and any extension of this store linked in
// Bidule (`npm run store:link`). Run it with scripts/check-host.sh, which puts the probe in Bidule for the run.
const TOKEN = { 'x-bidule-token': 'dev' }
const PROBE = 'store-probe'

type Listed = { id: string; error: string | null; unofficial: boolean }
type Group = {
  id: string
  fields: { key: string; type: string; default?: unknown; options?: { value: string }[] }[]
}

test.group('Store · the contract with the core’s host', (group) => {
  group.each.setup(() => testUtils.db().withGlobalTransaction())

  // The store's extensions, as the core lists them: those its package marks `bidule.storeOnly`.
  const storeExtensions = async (client: ApiClient) => {
    const res = await client.get('/api/extensions').headers(TOKEN)
    res.assertStatus(200)
    const listed: Listed[] = res.body()
    return listed.filter((e) => e.unofficial)
  }

  test('the probe and the store’s extensions are listed as community ones, without an error', async ({
    client,
    assert,
  }) => {
    const extensions = await storeExtensions(client)
    assert.include(
      extensions.map((e) => e.id),
      PROBE,
      `${PROBE} is not listed as a community extension (scripts/check-host.sh copies it)`
    )
    for (const ext of extensions) assert.isNull(ext.error, `${ext.id}: ${ext.error}`)
  })

  test('their settings are in their own namespace, a choice’s default among its options', async ({
    client,
    assert,
  }) => {
    const ids = (await storeExtensions(client)).map((e) => e.id)
    const res = await client.get('/api/settings').headers(TOKEN)
    res.assertStatus(200)
    const groups: Group[] = res.body().groups
    assert.exists(
      groups.find((g) => g.id === PROBE),
      `${PROBE} has no section in the settings`
    )
    for (const id of ids) {
      // An extension without settings has no section.
      for (const field of groups.find((g) => g.id === id)?.fields ?? []) {
        assert.isTrue(field.key.startsWith(`${id}.`), `${field.key} is outside ${id}`)
        if (field.type === 'choice') {
          assert.isTrue(
            field.options?.some((o) => o.value === field.default) ?? false,
            `${field.key}: its default is not one of its options`
          )
        }
      }
    }
  })

  test('each one starts in the host', async ({ client, assert }) => {
    const host = await app.container.make(ExtensionHost)
    for (const { id } of await storeExtensions(client)) {
      await host.activate(id)
      assert.isTrue(host.isStarted(id), `${id} did not start`)
    }
  })

  test('a command it registers runs, and reads its own settings', async ({ client }) => {
    const res = await client.post(`/api/commands/${PROBE}.greet`).headers(TOKEN).json({ args: {} })
    res.assertStatus(200)
    res.assertBody({ result: { text: 'Bonjour le store', tone: 'short' } })
  })

  test('its routes are mounted under /api/ext/<id>, behind the token', async ({ client }) => {
    const res = await client.get(`/api/ext/${PROBE}/greeting`).headers(TOKEN)
    res.assertStatus(200)
    res.assertBody({ text: 'Bonjour le store', tone: 'short' })
    const refused = await client.get(`/api/ext/${PROBE}/greeting`)
    refused.assertStatus(401)
  })
})
