import type { Router } from '@adonisjs/core/http'

const branches = () => import('@bidule/ext-lunar-industries-branches/server/controllers/branches_controller')

// Mounted under /api/ext/lunar-industries-branches, named ext.lunar-industries-branches.… (contract.ts lists them).
export default function routes(router: Router) {
  router.get('branches', [branches, 'index']).as('index')
  router.get('branches/links', [branches, 'links']).as('links')
  router.get('branches/jobs', [branches, 'jobs']).as('jobs')
  router.put('branches/link', [branches, 'link']).as('link')
  router.post('branches/pipeline', [branches, 'pipeline']).as('pipeline')
  router.post('branches/retry', [branches, 'retry']).as('retry')
  router.post('branches/jobs/:id/play', [branches, 'play']).as('play')
  router.post('branches/review', [branches, 'review']).as('review')
  router.put('repos/target', [branches, 'target']).as('target')
}
