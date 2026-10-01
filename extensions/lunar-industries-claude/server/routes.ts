import type { Router } from '@adonisjs/core/http'

const sessions = () => import('@bidule/ext-lunar-industries-claude/server/controllers/sessions_controller')

// Mounted under /api/ext/lunar-industries-claude, named ext.lunar-industries-claude.… (contract.ts lists them).
export default function routes(router: Router) {
  router.get('status', [sessions, 'status']).as('status')
  router.get('repos', [sessions, 'repos']).as('repos')
  router.get('templates', [sessions, 'templates']).as('templates')
  router.get('models', [sessions, 'models']).as('models')
  router.get('sessions', [sessions, 'index']).as('sessions.index')
  router.post('sessions', [sessions, 'start']).as('sessions.start')
  router.get('sessions/:id/events', [sessions, 'events']).as('sessions.events')
  router.get('sessions/:id/context', [sessions, 'context']).as('sessions.context')
  router.post('sessions/:id/messages', [sessions, 'send']).as('sessions.send')
  router.post('sessions/:id/decisions/:request', [sessions, 'decide']).as('sessions.decide')
  router.put('sessions/:id/mode', [sessions, 'mode']).as('sessions.mode')
  router.put('sessions/:id/model', [sessions, 'model']).as('sessions.model')
  router.put('sessions/:id/effort', [sessions, 'effort']).as('sessions.effort')
  router.put('sessions/:id/archive', [sessions, 'archive']).as('sessions.archive')
  router.put('sessions/:id/task', [sessions, 'task']).as('sessions.task')
  router.post('sessions/:id/interrupt', [sessions, 'interrupt']).as('sessions.interrupt')
  router.post('sessions/:id/stop', [sessions, 'stop']).as('sessions.stop')
  router.post('sessions/:id/watch', [sessions, 'watch']).as('sessions.watch')
  router.delete('sessions/:id/watch', [sessions, 'unwatch']).as('sessions.unwatch')
}
