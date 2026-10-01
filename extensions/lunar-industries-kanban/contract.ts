// Lunar Industries - Kanban: Simon's Kanban (quack-board), an unofficial one competing with Bidule's own (`kanban`).
// The board itself comes from the core's routes over the `tasks` role (/api/board, /api/tasks/…), as for any Kanban;
// the branches of the cards come from the `git` role, through the module's own routes, under
// /api/ext/lunar-industries-kanban:
//   GET branches                 { available, branches: KanbanBranch[] }   (available: someone holds the git role)
//   PUT tasks/:id/branches       { branches: BranchRef[] } → { branches: KanbanBranch[] }
//   GET review?repo&name         { url }  (the branch's review, else its pipeline, read on its forge now)
import type { GitBranch } from '@bidule/ext-git/contract'

export type BranchRef = { repo: string; name: string }

// A branch as the cards and the tray show it.
export type KanbanBranch = Pick<
  GitBranch,
  'repo' | 'repoLabel' | 'name' | 'taskId' | 'isDefault' | 'lastCommitAt' | 'reviewNumber' | 'reviewRef' | 'reviewState' | 'ci'
>

export type Branches = { available: boolean; branches: KanbanBranch[] }
