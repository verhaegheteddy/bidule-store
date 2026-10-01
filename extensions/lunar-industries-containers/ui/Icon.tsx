// Taken from quack-board's icons: 20 px (16 small), the text's colour.
const PATHS = {
  play: 'M7 5l12 7-12 7z',
  stop: 'M8 6h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z',
  restart: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  terminal: 'M6 4h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3zM7 9l3 3-3 3M13 15h4',
  logs: 'M5 6h14M5 10h14M5 14h10M5 18h7',
  down: 'm6 9 6 6 6-6',
  right: 'm9 6 6 6-6 6',
  left: 'm15 6-6 6 6 6',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  copy: 'M9 9h10v10H9zM5 15V5h10',
}
export type IconName = keyof typeof PATHS

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} fill="none" stroke="currentColor" strokeWidth={name === 'more' ? 3 : 2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
