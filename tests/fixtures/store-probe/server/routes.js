// Mounted under /api/ext/store-probe, behind the app's token; a request starts the extension first. Its code is only
// imported on the first request, as a controller would be.
export default function routes(router) {
  router
    .get('greeting', async ({ extension }) => (await import('./index.js')).greeting(extension.settings))
    .as('greeting')
}
