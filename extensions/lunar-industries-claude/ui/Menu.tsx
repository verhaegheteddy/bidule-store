import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

// A `menu floating` where it was asked (a right click, or above its button); a click elsewhere or Escape closes it.
export function FloatingMenu({
  at,
  onClose,
  className = '',
  label,
  children,
}: {
  at: CSSProperties
  onClose: () => void
  className?: string
  label: string
  children: ReactNode
}) {
  const menu = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  })
  useEffect(() => {
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus()
    const away = (e: Event) => !menu.current?.contains(e.target as Node) && close.current()
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      close.current()
    }
    // The arrows go from item to item.
    const arrows = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [])]
      if (!items.length) return
      e.preventDefault()
      const at = items.indexOf(document.activeElement as HTMLElement)
      items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
    }
    addEventListener('mousedown', away)
    addEventListener('keydown', esc, true)
    const el = menu.current
    el?.addEventListener('keydown', arrows)
    return () => {
      removeEventListener('mousedown', away)
      removeEventListener('keydown', esc, true)
      el?.removeEventListener('keydown', arrows)
    }
  }, [])
  return (
    <div ref={menu} className={`menu floating ${className}`} role="menu" aria-label={label} style={at}>
      {children}
    </div>
  )
}

// A button opening its menu above it (the message box sits at the bottom of the window).
export function MenuButton({
  label,
  children,
  menuClass,
  disabled,
  content,
}: {
  label: string
  children: ReactNode
  menuClass?: string
  disabled?: boolean
  content: (close: () => void) => ReactNode
}) {
  const [at, setAt] = useState<CSSProperties | null>(null)
  return (
    <>
      <button
        type="button"
        className="icon-btn lc-icon-sm"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={Boolean(at)}
        disabled={disabled}
        onMouseDown={(e) => at && e.stopPropagation()}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setAt(at ? null : { left: Math.max(8, r.left), bottom: innerHeight - r.top + 4 })
        }}
      >
        {children}
      </button>
      {at && (
        <FloatingMenu at={at} label={label} className={menuClass} onClose={() => setAt(null)}>
          {content(() => setAt(null))}
        </FloatingMenu>
      )}
    </>
  )
}
