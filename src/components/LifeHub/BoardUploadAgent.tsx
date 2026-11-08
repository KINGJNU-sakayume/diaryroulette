import { useEffect } from 'react'
import { BOARD_DATA_EVENT, readBoardState } from '../../db/indexedDB'
import { browserDeps } from '../../integration/lifehub'
import { evaluateBoardUpload } from '../../integration/boardUpload'
import { BOARD_EVALUATE_EVENT, setLifeHubState } from '../../integration/lifehubStore'

/** A burst of saves (the editor autosaves every few seconds) is looked at once. */
const DEBOUNCE_MS = 5000

/**
 * Runs while the app is open: looks at the Life Board tiles when the app starts, when diary records change,
 * when the tab comes back, and when this device's switch is turned on. The upload rules live in
 * integration/boardUpload.ts; nothing here can stop another part of the app.
 */
export default function BoardUploadAgent() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let running = false
    const evaluate = async () => {
      if (running) return
      running = true
      try {
        const deps = browserDeps()
        const result = await evaluateBoardUpload(deps, readBoardState)
        if (result.kind === 'sent' && result.outcome === 'scope') setLifeHubState({ boardReconnect: true })
        else if (result.kind === 'sent' && result.outcome !== 'retry' && result.outcome !== 'rejected') setLifeHubState({ boardReconnect: false })
        else if (result.kind === 'disconnected') setLifeHubState({ connected: false, reconnect: true })
        // Not allowed yet (10 minutes): look again when the time is up, with the then-current records.
        if (result.kind === 'wait') schedule(result.ms + 1000)
      } catch {
        // The board is optional; a failure here must not touch the rest of the app.
      } finally {
        running = false
      }
    }
    const schedule = (ms: number) => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => void evaluate(), ms)
    }
    const onChange = () => schedule(DEBOUNCE_MS)
    const onNow = () => void evaluate()
    const onVisible = () => {
      if (document.visibilityState === 'visible') schedule(DEBOUNCE_MS)
    }
    window.addEventListener(BOARD_DATA_EVENT, onChange)
    window.addEventListener(BOARD_EVALUATE_EVENT, onNow)
    document.addEventListener('visibilitychange', onVisible)
    void evaluate()
    return () => {
      if (timer !== undefined) clearTimeout(timer)
      window.removeEventListener(BOARD_DATA_EVENT, onChange)
      window.removeEventListener(BOARD_EVALUATE_EVENT, onNow)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])
  return null
}
