import { useEffect, useState } from 'react'
import type { Usage } from '../contract.ts'
import { api } from './api.ts'

const USAGE_EVERY_MS = 3000

// Kept across visits while the app runs: the meters show the last measure until the next one.
let keptUsage: Usage | null = null

// What the running containers use, asked every few seconds while `on` (the list or a container's view shows it):
// the engines are not asked for numbers nobody looks at.
export function useUsage(on: boolean): Usage | null {
  const [usage, setUsage] = useState<Usage | null>(keptUsage)
  useEffect(() => {
    if (!on) return
    let live = true
    let asking = false
    const tick = async () => {
      if (asking) return
      asking = true
      try {
        const u = (await api.usage({})) as Usage
        keptUsage = u
        if (live) setUsage(u)
      } catch {
        // No numbers this time; the next tick asks again.
      } finally {
        asking = false
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), USAGE_EVERY_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [on])
  return usage
}
