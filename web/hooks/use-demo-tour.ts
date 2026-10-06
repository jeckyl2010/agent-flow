import { useEffect, useRef } from 'react'
import type { TourStop } from '@/lib/mock-scenario'

/**
 * Plays a tour of the views through the demo: at each stop's moment the views it names open and
 * the others close. The viewer's first click, scroll or key ends it for good: from then on the
 * views are theirs. A restart (time running back) plays it again, unless it was ended.
 */
export function useDemoTour(
  stops: readonly TourStop[],
  enabled: boolean,
  currentTime: number,
  show: (stop: TourStop) => void,
): void {
  const endedRef = useRef(false)
  const shownRef = useRef(-1)
  const lastTimeRef = useRef(0)
  const showRef = useRef(show)
  showRef.current = show

  useEffect(() => {
    const end = () => { endedRef.current = true }
    const options = { capture: true, once: true }
    window.addEventListener('pointerdown', end, options)
    window.addEventListener('wheel', end, options)
    window.addEventListener('keydown', end, options)
    return () => {
      window.removeEventListener('pointerdown', end, options)
      window.removeEventListener('wheel', end, options)
      window.removeEventListener('keydown', end, options)
    }
  }, [])

  useEffect(() => {
    if (currentTime < lastTimeRef.current) shownRef.current = -1 // restarted
    lastTimeRef.current = currentTime
    if (!enabled || endedRef.current) return
    const index = stops.findLastIndex(s => s.at <= currentTime)
    if (index === -1 || index === shownRef.current) return
    shownRef.current = index
    showRef.current(stops[index])
  }, [stops, enabled, currentTime])
}
