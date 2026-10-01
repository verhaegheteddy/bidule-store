import type { ExtensionUi } from '@bidule/sdk'
import '../contract.ts'
import { Background } from './Background.tsx'
import { ClaudePage } from './ClaudePage.tsx'
import { openNewSession, START_SKILL } from './newSession.tsx'
import { SettingsPanel } from './SettingsPanel.tsx'
import { openSession, refreshSessions } from './state.ts'

// A new session (from a task when asked), opened on the page once started.
async function start(options: { taskId?: string | null; skill?: string | null }) {
  const id = await openNewSession(options)
  if (!id) return null
  refreshSessions()
  openSession(id)
  return { session: id }
}

const ui: ExtensionUi = {
  pages: { claude: ClaudePage },
  background: Background,
  settings: SettingsPanel,
  commands: {
    // The Kanban's right click: a session from the task, or the team's skill that takes it to staging.
    'lunar-industries-claude.newSession': (args) => start({ taskId: (args as { taskId?: string } | undefined)?.taskId ?? null }),
    'lunar-industries-claude.startTask': (args) =>
      start({ taskId: (args as { taskId?: string } | undefined)?.taskId ?? null, skill: START_SKILL }),
  },
}
export default ui
