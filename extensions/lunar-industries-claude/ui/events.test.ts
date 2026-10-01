import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '../contract.ts'
import { diffLines, itemsOf, merge, notifyKinds, pendingOf, relTime, tokens, toolsSummary } from './events.ts'
import { effortOptions, effortsOf, modelOptions, summaryOf } from './models.ts'

const text = (seq: number): SessionEvent => ({ seq, kind: 'text', text: `ligne ${seq}` })
const tool = (seq: number, id: string, file?: string): SessionEvent => ({
  seq,
  kind: 'tool',
  id,
  name: 'Edit',
  detail: file ?? 'ls',
  change: file ? { file, before: 'a', after: 'b' } : null,
})
const result = (seq: number, id: string, ok = true): SessionEvent => ({ seq, kind: 'tool_result', id, ok, text: '' })

// Taken from quack-board (Simon's conversation): the lines of a session, in order, grouped as the page draws them.
describe('Lunar Industries - Claude', () => {
  it('adds the lines in the order of their number, skips those already there, stops at a gap', () => {
    const start = [text(1), text(2)]
    expect(merge(start, [text(2), text(3)]).list.map((e) => e.seq)).toEqual([1, 2, 3])
    const gap = merge(start, [text(3), text(5), text(6)])
    expect(gap.list.map((e) => e.seq)).toEqual([1, 2, 3])
    expect(gap.gap).toBe(true)
    expect(merge(start, [text(1)]).list).toBe(start)
  })

  it('groups consecutive tool calls with their results', () => {
    const items = itemsOf([text(1), tool(2, 'a', 'x.ts'), result(3, 'a'), tool(4, 'b'), text(5), tool(6, 'c')])
    expect(items.map((i) => i.kind)).toEqual(['text', 'tools', 'text', 'tools'])
    const first = items[1]
    if (first?.kind !== 'tools') throw new Error('tools expected')
    expect(first.tools.map((t) => [t.call.id, t.result?.ok ?? null])).toEqual([
      ['a', true],
      ['b', null],
    ])
    expect(toolsSummary(first.tools)).toEqual({ label: '2 outils utilisés · 1 fichier modifié', failed: false, running: true })
  })

  it('keeps the cards no decision answered yet', () => {
    const card = (seq: number, id: string): SessionEvent => ({
      seq,
      kind: 'permission',
      id,
      name: 'Bash',
      detail: 'rm -rf build',
      ask: 'tool',
      canAlways: true,
      plan: null,
      questions: [],
    })
    const events = [card(1, 'r1'), card(2, 'r2'), { seq: 3, kind: 'decision', id: 'r1', allow: true, always: false, answer: null } as SessionEvent]
    expect(pendingOf(events).map((c) => c.id)).toEqual(['r2'])
  })

  it('draws a change as diff lines', () => {
    expect(diffLines('a\nb', 'c')).toEqual([
      { sign: '-', text: 'a' },
      { sign: '-', text: 'b' },
      { sign: '+', text: 'c' },
    ])
    expect(diffLines('', 'new')).toEqual([{ sign: '+', text: 'new' }])
  })

  it('reads the notify setting', () => {
    expect([...notifyKinds('decision, Error ,, slot')]).toEqual(['decision', 'error', 'slot'])
    expect(notifyKinds(undefined).size).toBe(0)
  })

  it('offers the efforts the model takes', () => {
    const models = [
      { value: 'default', label: 'Défaut', description: '', efforts: ['low' as const, 'high' as const] },
      { value: 'haiku', label: 'Haiku', description: '', efforts: [] },
    ]
    expect(modelOptions(models).map((o) => o.value)).toEqual(['', 'haiku'])
    expect(effortsOf(models, null)).toEqual(['low', 'high'])
    expect(effortOptions(models, 'haiku')).toHaveLength(1)
    expect(summaryOf('Déploie en staging - avec le job. À utiliser quand…')).toBe('Déploie en staging')
  })

  it('says times and tokens shortly', () => {
    const now = Date.parse('2026-10-01T12:00:00Z')
    expect(relTime('2026-10-01T11:59:40Z', now)).toBe('à l’instant')
    expect(relTime('2026-10-01T11:55:00Z', now)).toMatch(/^il y a 5\smin/)
    expect(relTime(null, now)).toBe('—')
    expect(tokens(950)).toBe('950')
    expect(tokens(12_400)).toBe('12 k')
    expect(tokens(3_250_000)).toBe('3,3 M')
  })
})
