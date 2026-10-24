import * as React from 'react'

/** Smoothly tweens between numeric values (respects reduced-motion). */
export function AnimatedNumber({ value, format, durationMs = 650 }: { value: number | null; format: (v: number | null) => string; durationMs?: number }) {
  const [display, setDisplay] = React.useState<number | null>(value)
  const fromRef = React.useRef<number | null>(value)
  const frame = React.useRef<number | null>(null)

  React.useEffect(() => {
    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const from = fromRef.current
    if (value === null || from === null || reduce || from === value) {
      fromRef.current = value
      setDisplay(value)
      return
    }
    const start = performance.now()
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / durationMs)
      const eased = 1 - Math.pow(1 - p, 3)
      const v = from + (value - from) * eased
      setDisplay(p >= 1 ? value : v)
      if (p < 1) frame.current = requestAnimationFrame(tick)
      else fromRef.current = value
    }
    frame.current = requestAnimationFrame(tick)
    return () => {
      if (frame.current) cancelAnimationFrame(frame.current)
      fromRef.current = value
    }
  }, [value, durationMs])

  return <span className="tabular">{format(display === null ? null : Number.isInteger(value ?? 0) ? Math.round(display) : display)}</span>
}
