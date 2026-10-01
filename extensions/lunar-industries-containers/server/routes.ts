import type { Router } from '@adonisjs/core/http'

const containers = () =>
  import('@bidule/ext-lunar-industries-containers/server/controllers/containers_controller')

// Mounted under /api/ext/lunar-industries-containers, named ext.lunar-industries-containers.… (typed client:
// ui/registry).
export default function routes(router: Router) {
  router.get('containers', [containers, 'index']).as('index')
  router.get('usage', [containers, 'usage']).as('usage')
  router.get('selection', [containers, 'selection']).as('selection')
  router.put('selection', [containers, 'select']).as('select')
  router.get('engines/:engine/containers/:id', [containers, 'show']).as('show')
  router.post('engines/:engine/containers/:id/action', [containers, 'act']).as('act')
  router.post('engines/:engine/containers/:id/terminal', [containers, 'terminal']).as('terminal')
  router.get('engines/:engine/containers/:id/logs', [containers, 'logs']).as('logs')
  router.get('engines/:engine/containers/:id/files', [containers, 'files']).as('files')
}
