import type { Router } from '@adonisjs/core/http'

const days = () => import('@bidule/ext-lunar-industries-temps/server/controllers/days_controller')

// Mounted under /api/ext/lunar-industries-temps, named ext.lunar-industries-temps.… (contract.ts lists them).
export default function routes(router: Router) {
  router.get('days/:day', [days, 'show']).as('days.show')
  router.post('days/:day/recompute', [days, 'recompute']).as('days.recompute')
  router.post('days/:day/edit', [days, 'edit']).as('days.edit')
  router.post('days/:day/absent', [days, 'absent']).as('days.absent')
  router.post('days/:day/send', [days, 'send']).as('days.send')
  router.put('days/:day/draft', [days, 'replace']).as('drafts.replace')
  router.delete('days/:day/draft', [days, 'discard']).as('drafts.discard')
  router.patch('days/:day/draft/:id', [days, 'resolve']).as('drafts.resolve')
  router.get('weeks/:day', [days, 'week']).as('weeks.show')
  router.get('months/:year/:month', [days, 'month']).as('months.show')
  router.get('summary', [days, 'summary']).as('summary')
}
