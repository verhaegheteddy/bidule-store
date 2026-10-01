import { useEffect } from 'react'
import { setPageCount, useOn } from '@bidule/sdk'
import { api } from './api.ts'

const PAGE = '/lunar-industries/temps'

// Always mounted: the Temps tab counts the days still to validate or fill among the last seven (Simon's nav badge).
export function Background() {
  const count = () =>
    void api.summary().then(
      (s) => setPageCount(PAGE, s.pendingDays),
      () => setPageCount(PAGE, null)
    )
  useEffect(count, [])
  useOn('lunar-industries-temps.changed', count)
  return null
}
