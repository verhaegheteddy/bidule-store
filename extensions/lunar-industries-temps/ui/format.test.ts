import { describe, expect, test } from 'vitest'
import { fmtShare, hm, shift, weekNumber, workText } from './format.ts'

describe('Lunar Industries - Temps: formats', () => {
  test('a share reads in days', () => {
    expect([0, 1, 7, 20].map(fmtShare)).toEqual(['0', '0,05', '0,35', '1'])
    expect(hm(545)).toBe('09:05')
  })

  test('the work days read as a range when they follow each other', () => {
    expect(workText([1, 2, 3, 4, 5])).toBe('lun. – ven.')
    expect(workText([1, 3, 5])).toBe('lun., mer., ven.')
    expect(workText([])).toBe('aucun')
    expect(weekNumber(new Date(2026, 8, 21))).toBe(39)
  })

  test('a border trades twentieths between its neighbours, each keeping one', () => {
    expect(shift([10, 10], 0, 1, 3)).toEqual([13, 7])
    expect(shift([10, 10], 0, 1, 15)).toEqual([19, 1])
    expect(shift([10, 10], 0, 1, 0)).toBeNull()
    // The last border trades with what is not given out yet, never past the day.
    expect(shift([8, 6], 1, null, 4)).toEqual([8, 10])
    expect(shift([8, 6], 1, null, 9)).toEqual([8, 12])
    expect(shift([8, 6], 1, null, -9)).toEqual([8, 1])
  })
})
