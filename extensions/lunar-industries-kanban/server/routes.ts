import type { Router } from '@adonisjs/core/http'

const kanban = () => import('@bidule/ext-lunar-industries-kanban/server/controllers/kanban_controller')

// Mounted under /api/ext/lunar-industries-kanban, named ext.lunar-industries-kanban.… (contract.ts lists them).
export default function routes(router: Router) {
  router.get('branches', [kanban, 'branches']).as('branches')
  router.put('tasks/:id/branches', [kanban, 'setBranches']).as('tasks.branches')
  router.get('review', [kanban, 'review']).as('review')
}
