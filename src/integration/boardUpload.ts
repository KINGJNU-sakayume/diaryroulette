/**
 * Uploads the Life Board tile list (src/lib/boardTiles.ts) to Life Hub: PUT /diaryroulette/v1/board, scope
 * `diaryroulette:board`. Only the tile list goes up, never the diary records.
 *
 * Rules (board docs/TILES.md):
 * - at most one request per 10 minutes (counted from the last attempt, success or not);
 * - only when the content (sha256 without `generated_at`) differs from the last success, except that a list
 *   unchanged for more than a day is sent again once (the board's "stale" clock is the time Life Hub received it);
 * - never when not connected, with no records at all (a new device must not overwrite another's list), or when
 *   this device's switch is off (Life Hub keeps one list per app, so two devices would overwrite each other).
 *
 * This file has its own request function on purpose: lifehub.ts's `api()` drops the tokens on 401/403, which
 * would also cut the inbox/sync connection when only the board scope is missing.
 */
import { boardBodyForHash, boardManifest, hasBoardRecords, type BoardManifest, type BoardState } from '../lib/boardTiles'
import {
  accessToken, boardNeedsReconnect, dropRejectedTokens, isConnected, LIFEHUB_ORIGIN, LifeHubError, readJson,
  setBoardNeedsReconnect, type Deps,
} from './lifehub'

export const BOARD_URL = LIFEHUB_ORIGIN + '/diaryroulette/v1/board'
export const MIN_INTERVAL_MS = 10 * 60 * 1000
export const DAILY_MS = 24 * 60 * 60 * 1000

const ENABLED_KEY = 'diaryroulette.board.enabled.v1'
const LAST_KEY = 'diaryroulette.board.last.v1'
const ATTEMPT_KEY = 'diaryroulette.board.attempt.v1'

type Store = Pick<Deps, 'storage'>

/** 「이 기기에서 보드에 올리기」: off unless the owner turned it on for this device. */
export function boardUploadEnabled(deps: Store): boolean {
  return deps.storage.getItem(ENABLED_KEY) === 'on'
}
export function setBoardUploadEnabled(deps: Store, on: boolean): void {
  if (on) deps.storage.setItem(ENABLED_KEY, 'on')
  else deps.storage.removeItem(ENABLED_KEY)
}

interface Last {
  sha: string
  at: number
}
function lastSuccess(deps: Store): Last | null {
  const v = readJson<Last>(deps.storage, LAST_KEY)
  return v && typeof v.sha === 'string' && typeof v.at === 'number' ? v : null
}
function lastAttempt(deps: Store): number | null {
  const n = Number(deps.storage.getItem(ATTEMPT_KEY))
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Milliseconds until another request is allowed (0 = now). A clock set back counts as "long ago". */
export function msUntilNextAttempt(deps: Store, now: number): number {
  const at = lastAttempt(deps)
  if (at === null) return 0
  const elapsed = now - at
  return elapsed < 0 || elapsed >= MIN_INTERVAL_MS ? 0 : MIN_INTERVAL_MS - elapsed
}

export type SkipReason = 'off' | 'not-connected' | 'reconnect' | 'no-records' | 'unchanged' | 'rejected'
export type Plan = { action: 'skip'; reason: SkipReason } | { action: 'wait'; ms: number } | { action: 'send' }
export interface PlanInput {
  enabled: boolean
  connected: boolean
  needsReconnect: boolean
  hasRecords: boolean
  sha: string
  lastSha: string | null
  lastSuccessAt: number | null
  lastAttemptAt: number | null
  /** Body Life Hub refused with 400/413 during this run: not sent again. */
  rejectedSha: string | null
  now: number
}
/** Pure: what to do with the current tile list. */
export function planUpload(i: PlanInput): Plan {
  if (!i.enabled) return { action: 'skip', reason: 'off' }
  if (!i.connected) return { action: 'skip', reason: 'not-connected' }
  if (i.needsReconnect) return { action: 'skip', reason: 'reconnect' }
  if (!i.hasRecords) return { action: 'skip', reason: 'no-records' }
  const due = i.sha !== i.lastSha || i.lastSuccessAt === null || i.now - i.lastSuccessAt > DAILY_MS
  if (!due) return { action: 'skip', reason: 'unchanged' }
  if (i.rejectedSha === i.sha) return { action: 'skip', reason: 'rejected' }
  const elapsed = i.lastAttemptAt === null ? Infinity : i.now - i.lastAttemptAt
  if (elapsed >= 0 && elapsed < MIN_INTERVAL_MS) return { action: 'wait', ms: MIN_INTERVAL_MS - elapsed }
  return { action: 'send' }
}

export type SendOutcome = 'stored' | 'unchanged' | 'ignored' | 'scope' | 'rejected' | 'retry'

/**
 * One PUT. 200 is a success (`unchanged`/`ignored` too). 403 is checked for `insufficient_scope` first and then
 * keeps the tokens: a browser can only read WWW-Authenticate if Life Hub exposes it, so an unreadable header
 * (null) is treated the same way instead of cutting the connection. A 403 whose header is readable and says
 * something else, or a 401 that survives a token refresh, follows the usual rule (tokens dropped).
 */
export async function sendBoard(manifest: BoardManifest, deps: Deps): Promise<SendOutcome> {
  const put = async (token: string) => {
    try {
      return await deps.fetch(BOARD_URL, {
        method: 'PUT',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(manifest),
      })
    } catch {
      throw new LifeHubError('network', 'Life Hub에 연결할 수 없어요.')
    }
  }
  let response = await put(await accessToken(deps))
  if (response.status === 401) response = await put(await accessToken(deps, true))
  if (response.status === 403) {
    const challenge = response.headers.get('WWW-Authenticate')
    if (challenge === null || /insufficient_scope/i.test(challenge)) return 'scope'
  }
  if (response.status === 401 || response.status === 403) {
    dropRejectedTokens(deps)
    throw new LifeHubError('not_connected', 'Life Hub 연결이 더 이상 유효하지 않아요. 다시 연결해 주세요.')
  }
  if (response.ok) {
    const body = (await response.json().catch(() => ({}))) as { unchanged?: unknown; ignored?: unknown } | null
    return body?.ignored === true ? 'ignored' : body?.unchanged === true ? 'unchanged' : 'stored'
  }
  if (response.status === 400 || response.status === 413) {
    // A bug on our side (or a device clock more than 5 minutes off for 400): the same body is not sent again.
    console.warn(`Life Board upload refused (${response.status})`, await response.text().catch(() => ''))
    return 'rejected'
  }
  return 'retry'
}

export type BoardResult =
  | { kind: 'skipped'; reason: SkipReason }
  | { kind: 'wait'; ms: number }
  | { kind: 'sent'; outcome: SendOutcome }
  | { kind: 'disconnected' }

/** Per page load: the body Life Hub refused (400/413). */
export const runState: { rejectedSha: string | null } = { rejectedSha: null }

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

/**
 * Decides and, if due, uploads. The state is read at this moment, so a delayed send never carries an old list.
 * Never throws: a failed upload must not stop anything else in the app.
 */
export async function evaluateBoardUpload(deps: Deps, readState: () => Promise<BoardState>): Promise<BoardResult> {
  try {
    const now = deps.now()
    const enabled = boardUploadEnabled(deps)
    const connected = isConnected(deps)
    const needsReconnect = boardNeedsReconnect(deps)
    // Cheap checks first, so nothing is read from IndexedDB when it cannot be sent anyway.
    if (!enabled) return { kind: 'skipped', reason: 'off' }
    if (!connected) return { kind: 'skipped', reason: 'not-connected' }
    if (needsReconnect) return { kind: 'skipped', reason: 'reconnect' }
    const left = msUntilNextAttempt(deps, now)
    if (left > 0) return { kind: 'wait', ms: left }

    const state = await readState()
    const manifest = boardManifest(state, new Date(now))
    const sha = hex(await deps.sha256(new TextEncoder().encode(boardBodyForHash(manifest))))
    const last = lastSuccess(deps)
    const plan = planUpload({
      enabled, connected, needsReconnect, hasRecords: hasBoardRecords(state), sha,
      lastSha: last?.sha ?? null, lastSuccessAt: last?.at ?? null, lastAttemptAt: lastAttempt(deps),
      rejectedSha: runState.rejectedSha, now,
    })
    if (plan.action === 'skip') return { kind: 'skipped', reason: plan.reason }
    if (plan.action === 'wait') return { kind: 'wait', ms: plan.ms }

    deps.storage.setItem(ATTEMPT_KEY, String(now))
    const outcome = await sendBoard(manifest, deps)
    if (outcome === 'stored' || outcome === 'unchanged' || outcome === 'ignored') {
      deps.storage.setItem(LAST_KEY, JSON.stringify({ sha, at: now } satisfies Last))
    } else if (outcome === 'scope') {
      setBoardNeedsReconnect(deps, true)
    } else if (outcome === 'rejected') {
      runState.rejectedSha = sha
    }
    return { kind: 'sent', outcome }
  } catch (e) {
    if (e instanceof LifeHubError && e.kind === 'not_connected') return { kind: 'disconnected' }
    // Network errors and server trouble: tried again at the next chance.
    return { kind: 'sent', outcome: 'retry' }
  }
}
