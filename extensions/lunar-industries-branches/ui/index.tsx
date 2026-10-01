import { useEffect } from 'react'
import { on, setPageCount, type ExtensionUi } from '@bidule/sdk'
import '../contract.ts'
import { api } from './api.ts'
import { BranchesPage } from './BranchesPage.tsx'
import { orphansOf } from './steps.ts'
import './branches.css'

const PATH = '/lunar-industries/branches'

// Always there: the tab counts the recent branches without a task, again whenever git reads the repos.
function Background() {
  useEffect(() => {
    const count = () =>
      void api.list().then(
        (l) => setPageCount(PATH, orphansOf(l.branches).length),
        () => undefined,
      )
    count()
    const offs = [on('git.changed', count), on('git.reviewed', count)]
    return () => offs.forEach((off) => off())
  }, [])
  return null
}

const ui: ExtensionUi = { pages: { branches: BranchesPage }, background: Background }
export default ui
