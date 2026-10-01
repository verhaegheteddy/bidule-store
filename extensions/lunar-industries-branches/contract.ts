// Lunar Industries - Branches: Simon's Branches page (quack-board), an unofficial module competing with Bidule's own
// (`branches`). Each branch of the user's repos with the step it is at (task, review, CI, merge) and what to do next;
// the forge is the `git` role's (forgeOf). Types only: the interface reads this file.
//
// Its routes, under /api/ext/lunar-industries-branches:
//   GET  branches                      Listing
//   GET  branches/links?repo&name      Links (read on the forge now)
//   GET  branches/jobs?repo&name       { jobs: Job[] }
//   PUT  branches/link                 { repo, name, taskId | null } → { ok }
//   POST branches/pipeline             { repo, name } → { ok }
//   POST branches/retry                { repo, name } → { ok }
//   POST branches/jobs/:id/play        { repo, name } → { ok }
//   POST branches/review               { repo, name, target } → { ok }
//   PUT  repos/target                  { repo, target | null } → { ok }
import type { GitBranch } from '@bidule/ext-git/contract'

export type ForgeKind = 'github' | 'gitlab'

// A branch as the page lists it: the git role's, with its repo's forge and the issue its name carries.
export type ListedBranch = GitBranch & { forge: ForgeKind | null; issueNumber: number | null }

// A repo: its forge, the branches its reviews can go to (its default one, then its integration ones), and the one
// chosen for it (null: none of its own).
export type ListedRepo = {
  path: string
  label: string
  forge: ForgeKind | null
  targets: string[]
  reviewTarget: string | null
}

export type Listing = {
  branches: ListedBranch[]
  repos: ListedRepo[]
  // Réglages: where a repo's reviews go when it has not chosen (and has that branch).
  defaultTarget: string | null
}

// Where a branch's review, pipeline and issue are, read on the forge for the branch shown.
export type Links = {
  reviewUrl: string | null
  pipelineUrl: string | null
  issueUrl: string | null
}

export type Job = { id: number; name: string; stage: string; status: string; manual: boolean }

declare module '@bidule/sdk/contracts' {
  interface Events {
    // A repo's review target changed (Réglages or the page).
    'lunar-industries-branches.changed': Record<string, never>
  }
}
