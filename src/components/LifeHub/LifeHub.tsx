import { useCallback, useEffect, useState } from 'react'
import { Link2, RefreshCw, Unlink } from 'lucide-react'
import { getMission } from '../../data/missions'
import { getEffectiveDateString } from '../../lib/date'
import {
  APP_URL, autoApplyEnabled, beginConnect, browserDeps, completeConnect, connectAvailable, disconnect, isAuthCallback,
  isConnected, LifeHubError, needsReconnect, rejectLocally, rememberReceipt, setAutoApply, sync,
} from '../../integration/lifehub'
import { boardUploadEnabled, setBoardUploadEnabled } from '../../integration/boardUpload'
import { APPLIED_EVENT, applyProposals, chooseMission, dayRefs, readDay } from '../../integration/lifehubApply'
import { formatSyncTime, getLifeHubState, openSettings, requestBoardUpload, requestLifeHubSync, setLifeHubState, SYNC_EVENT, useLifeHub, type Waiting } from '../../integration/lifehubStore'

// The one-time code exchange must not run twice (React StrictMode runs effects twice in development).
let callbackOnce: Promise<void> | null = null

/**
 * Runs while the app is open: finishes a Life Hub sign-in that just returned, then (on start and on request)
 * sends decisions, shares today's state, and applies Life Hub missions by the app's own rules.
 */
export function LifeHubAgent() {
  const [notice, setNotice] = useState('')
  const run = useCallback(async () => {
    const deps = browserDeps()
    if (!isConnected(deps) || getLifeHubState().syncing) return
    setLifeHubState({ syncing: true, error: '' })
    try {
      const today = getEffectiveDateString()
      const first = await sync(dayRefs(await readDay(today)), deps)
      const applied = await applyProposals(first.proposals, today, autoApplyEnabled(deps), deps)
      // Send what was just decided and the new state right away.
      const settled = first.proposals.length !== applied.waiting.length ? await sync(dayRefs(applied.day), deps) : first
      const open = new Set(settled.proposals.map((p) => p.key))
      setLifeHubState({ waiting: applied.waiting.filter((w) => open.has(w.proposal.key)), conflicts: settled.conflicts, lastSyncedAt: Date.now(), connected: true })
      if (applied.saved) setNotice(`오늘의 미션을 정했어요: 「${applied.saved.title}」 (Claude에서 뽑음)`)
    } catch (e) {
      if (e instanceof LifeHubError && e.kind === 'not_connected') setLifeHubState({ connected: false, reconnect: needsReconnect(deps), waiting: [] })
      setLifeHubState({ error: e instanceof Error ? e.message : String(e) })
    } finally {
      setLifeHubState({ syncing: false })
    }
  }, [])

  useEffect(() => {
    const onRequest = () => void run()
    window.addEventListener(SYNC_EVENT, onRequest)
    void (async () => {
      if (isAuthCallback(location.search)) {
        callbackOnce ??= completeConnect(location.search, browserDeps())
        try {
          await callbackOnce
          setLifeHubState({ connected: true, reconnect: false, boardReconnect: false, error: '' })
          setNotice('Life Hub에 연결했어요.')
        } catch (e) {
          setLifeHubState({ error: e instanceof Error ? e.message : String(e) })
        }
        history.replaceState(null, '', APP_URL + '#/')
        openSettings()
      }
      await run()
    })()
    return () => window.removeEventListener(SYNC_EVENT, onRequest)
  }, [run])

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(''), 4500)
    return () => clearTimeout(t)
  }, [notice])
  if (!notice) return null
  return (
    <div role="status" className="fixed inset-x-4 bottom-24 z-50 mx-auto max-w-md rounded-xl bg-ink px-4 py-3 text-center text-sm text-page shadow-lg">
      {notice}
    </div>
  )
}

const WAIT_NOTE: Record<Waiting['reason'], string> = {
  pending: 'Claude 대화에서 뽑았어요.',
  review: 'Claude 카드에서 여기서 확인해 달라고 했어요.',
  'auto-off': '자동 반영이 꺼져 있어 여기서 확인해요.',
  resting: '이 미션은 아직 쉬는 중이라 오늘은 고를 수 없어요.',
  future: '아직 그날이 아니에요.',
}

/** Home: a mission Life Hub drew for today that still needs the owner. */
export function LifeHubTodayBanner({ today, hasMission }: { today: string; hasMission: boolean }) {
  const hub = useLifeHub()
  const [busy, setBusy] = useState(false)
  const item = hub.waiting.find((w) => w.proposal.date === today && w.reason !== 'future')
  const mission = item && getMission(item.proposal.missionId)
  if (hasMission || !item || !mission) return null

  const drop = () => setLifeHubState({ waiting: getLifeHubState().waiting.filter((w) => w.proposal.key !== item.proposal.key) })
  async function accept() {
    if (!item || !mission || busy) return
    setBusy(true)
    try {
      const day = await readDay(today)
      if (day.todayMissionId) return
      await chooseMission(mission, day)
      rememberReceipt(item.proposal.key, item.proposal.date, browserDeps())
      drop()
      window.dispatchEvent(new CustomEvent(APPLIED_EVENT))
      requestLifeHubSync()
    } finally {
      setBusy(false)
    }
  }
  function reject() {
    if (!item) return
    rejectLocally(item.proposal.key, browserDeps())
    drop()
    requestLifeHubSync()
  }
  return (
    <section aria-label="Life Hub 제안" className="panel mt-6 p-4">
      <p className="text-xs font-bold text-accent">Life Hub</p>
      <p className="mt-1 text-[15px] text-ink">
        Claude가 뽑은 오늘의 미션: <strong className="font-serif">{mission.title}</strong>
      </p>
      <p className="mt-1 text-sm text-muted">{WAIT_NOTE[item.reason]}</p>
      <div className="mt-3 flex items-center gap-3">
        {item.reason !== 'resting' && (
          <button type="button" className="btn-primary px-4 py-2 text-sm" disabled={busy} onClick={() => void accept()}>
            이걸로 할게요
          </button>
        )}
        <button type="button" className="text-sm text-muted underline underline-offset-2" onClick={reject}>
          거절
        </button>
      </div>
    </section>
  )
}

function StatusLine({ tone, children }: { tone: 'ok' | 'warn'; children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-sm text-ink-mid">
      <span className={`h-2 w-2 shrink-0 rounded-full ${tone === 'ok' ? 'bg-success' : 'bg-danger'}`} aria-hidden="true" />
      {children}
    </p>
  )
}

/**
 * Settings → Life Hub (공통 규격). A: 연결 전, B: 연결됨, C: 확인 필요(Life Hub가 이 기기의 연결을 거부함).
 * 이 앱은 제안만 받으므로 「고급」 영역이 없다.
 */
export function LifeHubSettings() {
  const hub = useLifeHub()
  const [auto, setAuto] = useState(() => autoApplyEnabled(browserDeps()))
  const [board, setBoard] = useState(() => boardUploadEnabled(browserDeps()))
  const canConnect = typeof location !== 'undefined' && connectAvailable(location)

  async function connect() {
    try {
      location.assign(await beginConnect(browserDeps()))
    } catch (e) {
      setLifeHubState({ error: e instanceof Error ? e.message : String(e) })
    }
  }
  function confirmDisconnect() {
    if (!confirm('이 기기에서 Life Hub 연결을 해제할까요? 일기는 그대로 남아요.')) return
    disconnect(browserDeps())
    setLifeHubState({ connected: false, reconnect: false, boardReconnect: false, waiting: [], error: '' })
  }
  const disconnectButton = (
    <button type="button" className="btn-secondary flex-1 py-2" onClick={confirmDisconnect}>
      <Unlink className="h-4 w-4" /> 연결 해제
    </button>
  )

  // C: 확인 필요
  if (!hub.connected && hub.reconnect)
    return (
      <div className="flex flex-col gap-3">
        <StatusLine tone="warn">확인 필요</StatusLine>
        <div className="rounded-lg bg-danger-soft px-3 py-3 text-sm text-danger">
          <p>Life Hub 연결이 끊겼습니다. 다시 연결해 주세요. 이 기기의 기록은 그대로입니다.</p>
          <button type="button" className="btn-primary mt-3 py-2" disabled={!canConnect} onClick={() => void connect()}>
            <Link2 className="h-4 w-4" /> 다시 연결
          </button>
          {!canConnect && <p className="mt-2 text-xs">배포된 주소에서만 연결할 수 있어요.</p>}
        </div>
        <div className="flex">{disconnectButton}</div>
      </div>
    )

  // A: 연결 전
  if (!hub.connected)
    return (
      <div className="flex flex-col gap-3">
        <div>
          <p className="text-sm text-ink">Claude가 제안한 기록을 받습니다.</p>
          <p className="mt-1 text-xs text-muted">미션 목록과 오늘 상태(쉬는 미션·오늘 미션)만 공유하고 일기 내용은 보내지 않아요.</p>
        </div>
        <button type="button" className="btn-primary w-full py-2.5" disabled={!canConnect} onClick={() => void connect()}>
          <Link2 className="h-4 w-4" /> Life Hub 연결
        </button>
        {!canConnect && <p className="text-sm text-muted">배포된 주소에서만 연결할 수 있어요.</p>}
        {hub.error && <p role="alert" className="text-sm text-danger">{hub.error}</p>}
      </div>
    )

  // B: 연결됨
  const status = hub.syncing
    ? '연결됨 · 동기화 중…'
    : hub.error
      ? '연결됨 · 잠시 뒤 다시 시도'
      : hub.lastSyncedAt
        ? `연결됨 · ${formatSyncTime(hub.lastSyncedAt)} 동기화`
        : '연결됨 · 아직 동기화 전'
  return (
    <div className="flex flex-col gap-3">
      <div>
        <StatusLine tone="ok">{status}</StatusLine>
        {hub.error && !hub.syncing && <p role="status" className="mt-1 text-xs text-muted">{hub.error}</p>}
      </div>
      <div className="flex gap-2">
        <button type="button" className="btn-secondary flex-1 py-2" disabled={hub.syncing} onClick={() => requestLifeHubSync(false)}>
          <RefreshCw className="h-4 w-4" /> 지금 동기화
        </button>
        {disconnectButton}
      </div>
      <label className="flex items-start gap-2 text-sm text-ink">
        <input
          type="checkbox"
          className="mt-1"
          checked={auto}
          onChange={(e) => {
            setAutoApply(browserDeps(), e.target.checked)
            setAuto(e.target.checked)
            if (e.target.checked) requestLifeHubSync()
          }}
        />
        <span>
          Claude에서 승인한 기록은 바로 반영
          <small className="block text-xs text-muted">Claude 카드에서 「일기 쓰기」를 누른 미션을 앱을 열 때 오늘의 미션으로 정해요.</small>
        </span>
      </label>
      <label className="flex items-start gap-2 text-sm text-ink">
        <input
          type="checkbox"
          className="mt-1"
          checked={board}
          onChange={(e) => {
            setBoardUploadEnabled(browserDeps(), e.target.checked)
            setBoard(e.target.checked)
            if (e.target.checked) requestBoardUpload()
          }}
        />
        <span>
          이 기기에서 보드에 올리기
          <small className="block text-xs text-muted">
            Life Board에 보일 오늘의 미션·연속 기록·최근 일기 목록을 올려요(일기 내용은 올리지 않아요). 기록은 기기 안에만 있고 Life Hub는 최신 목록 하나만 보관해서, 여러 기기에서 켜면 마지막에 올린 기기의 것으로 바뀌어요.
          </small>
        </span>
      </label>
      {board && hub.boardReconnect && (
        <div role="status" className="rounded-lg bg-danger-soft px-3 py-3 text-sm text-danger">
          <p>보드에 올리려면 Life Hub에 다시 연결해 주세요. 지금 연결에는 보드 권한이 없어요. 수신함과 동기화는 그대로 쓸 수 있어요.</p>
          <button type="button" className="btn-primary mt-3 py-2" disabled={!canConnect} onClick={() => void connect()}>
            <Link2 className="h-4 w-4" /> 다시 연결
          </button>
          {!canConnect && <p className="mt-2 text-xs">배포된 주소에서만 연결할 수 있어요.</p>}
        </div>
      )}
      {hub.conflicts > 0 && (
        <p role="status" className="text-sm text-muted">{`${hub.conflicts}개 제안은 Life Hub와 상태가 달라요. 일기 룰렛의 기록은 그대로예요.`}</p>
      )}
    </div>
  )
}
