import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BOARD_URL, DAILY_MS, MIN_INTERVAL_MS, boardUploadEnabled, evaluateBoardUpload, planUpload, runState,
  setBoardUploadEnabled, type PlanInput,
} from '../integration/boardUpload'
import {
  LIFEHUB_ORIGIN, SCOPE, beginConnect, boardNeedsReconnect, completeConnect, isConnected, needsReconnect, type Deps,
} from '../integration/lifehub'
import type { BoardState } from '../lib/boardTiles'
import { missions } from '../data/missions'

class MemoryStorage {
  map = new Map<string, string>()
  getItem(k: string) { return this.map.get(k) ?? null }
  setItem(k: string, v: string) { this.map.set(k, String(v)) }
  removeItem(k: string) { this.map.delete(k) }
}
const M = missions
const T0 = new Date(2026, 10, 8, 12).getTime()
const STATE: BoardState = {
  todayMission: { date: '2026-11-08', missionId: M[0].id },
  journals: [{ id: '2026-11-07', missionId: M[1].id, status: 'completed' }],
}
const EMPTY: BoardState = { todayMission: null, journals: [] }

interface Hub {
  puts: Array<{ url: string; auth: string; type: string; body: { tiles: unknown[]; generated_at: string } }>
  tokenCalls: number
  /** next PUT answers, in order; the last repeats */
  answers: Array<{ status: number; body?: unknown; challenge?: string | null }>
}
function fakeHub(answers: Hub['answers'] = [{ status: 200, body: {} }]) {
  const hub: Hub = { puts: [], tokenCalls: 0, answers }
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname === '/oauth/token') {
      hub.tokenCalls++
      return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', token_type: 'bearer', expires_in: 3600 }), { status: 200 })
    }
    const h = new Headers(init?.headers)
    hub.puts.push({ url: String(input), auth: h.get('Authorization') ?? '', type: h.get('Content-Type') ?? '', body: JSON.parse(String(init?.body)) })
    const a = hub.answers[Math.min(hub.puts.length - 1, hub.answers.length - 1)]
    const headers = new Headers()
    if (a.challenge) headers.set('WWW-Authenticate', a.challenge)
    return new Response(a.body === undefined ? '{}' : JSON.stringify(a.body), { status: a.status, headers })
  }) as typeof fetch
  return { hub, f }
}
function makeDeps(f: typeof fetch, t = { now: T0 }) {
  let n = 0
  const deps: Deps = {
    fetch: f, storage: new MemoryStorage(), session: new MemoryStorage(), now: () => t.now,
    random: (k) => Uint8Array.from({ length: k }, () => (n++ * 31 + 7) % 256),
    sha256: async (d) => new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(d))),
  }
  return { deps, t }
}
async function connect(deps: Deps) {
  const url = new URL(await beginConnect(deps))
  await completeConnect(`?code=c&state=${url.searchParams.get('state')}&iss=${encodeURIComponent(LIFEHUB_ORIGIN)}`, deps)
}
async function setup(answers?: Hub['answers'], opts: { enable?: boolean } = {}) {
  const { hub, f } = fakeHub(answers)
  const { deps, t } = makeDeps(f)
  await connect(deps)
  if (opts.enable !== false) setBoardUploadEnabled(deps, true)
  return { hub, deps, t }
}
const read = (s: BoardState) => async () => s

beforeEach(() => {
  runState.rejectedSha = null
  vi.restoreAllMocks()
})

describe('연결 요청', () => {
  it('scope 에 diaryroulette:board 가 들어 있다', async () => {
    const { deps } = makeDeps(fakeHub().f)
    const q = new URL(await beginConnect(deps)).searchParams
    expect(SCOPE.split(' ')).toContain('diaryroulette:board')
    expect(q.get('scope')).toContain('diaryroulette:board')
    expect(q.get('scope')).toContain('diaryroulette:inbox')
  })
})

describe('업로드 요청', () => {
  it('저장: 올바른 주소·헤더·본문, 성공을 기록', async () => {
    const { hub, deps } = await setup()
    const r = await evaluateBoardUpload(deps, read(STATE))
    expect(r).toEqual({ kind: 'sent', outcome: 'stored' })
    expect(hub.puts).toHaveLength(1)
    expect(hub.puts[0].url).toBe(BOARD_URL)
    expect(BOARD_URL).toBe('https://life-hub-api.213303.workers.dev/diaryroulette/v1/board')
    expect(hub.puts[0].auth).toBe('Bearer at')
    expect(hub.puts[0].type).toBe('application/json')
    expect(hub.puts[0].body.tiles).toHaveLength(3)
    expect(hub.puts[0].body.generated_at).toBe(new Date(T0).toISOString().replace(/\.\d{3}Z$/, 'Z'))
  })

  it('unchanged / ignored 도 성공', async () => {
    for (const body of [{ unchanged: true }, { ignored: true }]) {
      const { hub, deps, t } = await setup([{ status: 200, body }])
      const r = await evaluateBoardUpload(deps, read(STATE))
      expect(r).toEqual({ kind: 'sent', outcome: 'unchanged' in body ? 'unchanged' : 'ignored' })
      // 성공으로 기록돼 내용이 같으면 다시 보내지 않는다
      t.now += MIN_INTERVAL_MS + 1
      expect(await evaluateBoardUpload(deps, read(STATE))).toEqual({ kind: 'skipped', reason: 'unchanged' })
      expect(hub.puts).toHaveLength(1)
    }
  })

  it('403 insufficient_scope: 토큰을 지우지 않고 재연결 안내만, 다시 시도하지 않는다', async () => {
    const { hub, deps, t } = await setup([{ status: 403, challenge: 'Bearer error="insufficient_scope", scope="diaryroulette:board"' }])
    const r = await evaluateBoardUpload(deps, read(STATE))
    expect(r).toEqual({ kind: 'sent', outcome: 'scope' })
    expect(isConnected(deps)).toBe(true)
    expect(needsReconnect(deps)).toBe(false)
    expect(boardNeedsReconnect(deps)).toBe(true)
    t.now += 3 * MIN_INTERVAL_MS
    expect(await evaluateBoardUpload(deps, read(STATE))).toEqual({ kind: 'skipped', reason: 'reconnect' })
    expect(hub.puts).toHaveLength(1)
  })

  it('403 인데 헤더를 읽을 수 없으면(CORS) 같은 규칙: 토큰 유지', async () => {
    const { deps } = await setup([{ status: 403, challenge: null }])
    expect(await evaluateBoardUpload(deps, read(STATE))).toEqual({ kind: 'sent', outcome: 'scope' })
    expect(isConnected(deps)).toBe(true)
  })

  it('재연결하면 플래그가 풀리고 다시 올린다', async () => {
    const { hub, deps, t } = await setup([{ status: 403, challenge: 'Bearer error="insufficient_scope"' }, { status: 200, body: {} }])
    await evaluateBoardUpload(deps, read(STATE))
    expect(boardNeedsReconnect(deps)).toBe(true)
    await connect(deps)
    expect(boardNeedsReconnect(deps)).toBe(false)
    t.now += MIN_INTERVAL_MS + 1
    expect(await evaluateBoardUpload(deps, read(STATE))).toEqual({ kind: 'sent', outcome: 'stored' })
    expect(hub.puts).toHaveLength(2)
  })

  it('다른 403(읽을 수 있는 다른 헤더): 기존 규칙대로 토큰을 지운다', async () => {
    const { deps } = await setup([{ status: 403, challenge: 'Bearer error="invalid_token"' }])
    expect(await evaluateBoardUpload(deps, read(STATE))).toEqual({ kind: 'disconnected' })
    expect(isConnected(deps)).toBe(false)
    expect(needsReconnect(deps)).toBe(true)
  })

  it('401 은 토큰을 새로 받아 한 번 다시 보내고, 그래도 401 이면 연결을 끊는다', async () => {
    const { hub, deps } = await setup([{ status: 401 }, { status: 401 }])
    expect(await evaluateBoardUpload(deps, read(STATE))).toEqual({ kind: 'disconnected' })
    expect(hub.puts).toHaveLength(2)
    expect(isConnected(deps)).toBe(false)
    const ok = await setup([{ status: 401 }, { status: 200, body: {} }])
    expect(await evaluateBoardUpload(ok.deps, read(STATE))).toEqual({ kind: 'sent', outcome: 'stored' })
    expect(isConnected(ok.deps)).toBe(true)
  })

  it('400 은 같은 내용으로 다시 보내지 않고 콘솔에만 남긴다', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { hub, deps, t } = await setup([{ status: 400 }])
    expect(await evaluateBoardUpload(deps, read(STATE))).toEqual({ kind: 'sent', outcome: 'rejected' })
    expect(warn).toHaveBeenCalled()
    t.now += MIN_INTERVAL_MS + 1
    expect(await evaluateBoardUpload(deps, read(STATE))).toEqual({ kind: 'skipped', reason: 'rejected' })
    expect(hub.puts).toHaveLength(1)
    expect(isConnected(deps)).toBe(true)
    // 내용이 바뀌면 다시 보낸다
    const changed: BoardState = { ...STATE, journals: [...STATE.journals, { id: '2026-11-06', missionId: M[2].id, status: 'completed' }] }
    expect((await evaluateBoardUpload(deps, read(changed))).kind).toBe('sent')
    expect(hub.puts).toHaveLength(2)
  })

  it('413 도 마찬가지', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { hub, deps, t } = await setup([{ status: 413 }])
    await evaluateBoardUpload(deps, read(STATE))
    t.now += MIN_INTERVAL_MS + 1
    await evaluateBoardUpload(deps, read(STATE))
    expect(hub.puts).toHaveLength(1)
  })

  it('5xx·네트워크 오류는 성공으로 치지 않고 다음 기회에 다시(10분 뒤)', async () => {
    const { hub, deps, t } = await setup([{ status: 503 }, { status: 200, body: {} }])
    expect(await evaluateBoardUpload(deps, read(STATE))).toEqual({ kind: 'sent', outcome: 'retry' })
    expect(await evaluateBoardUpload(deps, read(STATE))).toEqual({ kind: 'wait', ms: MIN_INTERVAL_MS })
    t.now += MIN_INTERVAL_MS
    expect(await evaluateBoardUpload(deps, read(STATE))).toEqual({ kind: 'sent', outcome: 'stored' })
    expect(hub.puts).toHaveLength(2)

    const failing = makeDeps((async (input: string | URL | Request) => {
      if (new URL(String(input)).pathname === '/oauth/token') return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', token_type: 'bearer', expires_in: 3600 }))
      throw new TypeError('offline')
    }) as typeof fetch)
    await connect(failing.deps)
    setBoardUploadEnabled(failing.deps, true)
    expect(await evaluateBoardUpload(failing.deps, read(STATE))).toEqual({ kind: 'sent', outcome: 'retry' })
    expect(isConnected(failing.deps)).toBe(true)
  })
})

describe('빈도와 중복 방지', () => {
  it('10분에 한 번 이하: 변경이 잦아도 남은 시간만큼 기다린 뒤 그때의 내용을 보낸다', async () => {
    const { hub, deps, t } = await setup()
    await evaluateBoardUpload(deps, read(STATE))
    const changed: BoardState = { ...STATE, journals: [...STATE.journals, { id: '2026-11-08', missionId: M[0].id, status: 'draft' }] }
    t.now += 60_000
    expect(await evaluateBoardUpload(deps, read(changed))).toEqual({ kind: 'wait', ms: MIN_INTERVAL_MS - 60_000 })
    expect(hub.puts).toHaveLength(1)
    t.now += MIN_INTERVAL_MS - 60_000
    const latest: BoardState = { ...changed, journals: [{ id: '2026-11-08', missionId: M[0].id, status: 'completed' }, ...STATE.journals] }
    expect((await evaluateBoardUpload(deps, read(latest))).kind).toBe('sent')
    expect(hub.puts).toHaveLength(2)
    const pill = (hub.puts[1].body.tiles[0] as { data: { pill: string } }).data.pill
    expect(pill).toBe('완료')
  })

  it('내용이 같으면(generated_at 만 다르면) 보내지 않는다', async () => {
    const { hub, deps, t } = await setup()
    await evaluateBoardUpload(deps, read(STATE))
    t.now += 2 * MIN_INTERVAL_MS
    expect(await evaluateBoardUpload(deps, read(STATE))).toEqual({ kind: 'skipped', reason: 'unchanged' })
    expect(hub.puts).toHaveLength(1)
  })

  it('같은 날 안에서 내용이 같으면 시간이 지나도 보내지 않고, 날짜가 바뀌면 새 내용으로 보낸다', async () => {
    const { hub, deps, t } = await setup()
    await evaluateBoardUpload(deps, read(STATE))
    t.now += 5 * 3600_000
    expect(await evaluateBoardUpload(deps, read(STATE))).toEqual({ kind: 'skipped', reason: 'unchanged' })
    t.now = T0 + DAILY_MS + 1
    expect((await evaluateBoardUpload(deps, read(STATE))).kind).toBe('sent')
    expect(hub.puts).toHaveLength(2)
  })

  it('하루 규칙(planUpload): 내용이 같아도 마지막 성공이 24시간을 넘으면 보낸다', () => {
    const base: PlanInput = {
      enabled: true, connected: true, needsReconnect: false, hasRecords: true, sha: 'a', lastSha: 'a',
      lastSuccessAt: T0, lastAttemptAt: T0, rejectedSha: null, now: T0 + DAILY_MS - 1,
    }
    expect(planUpload(base)).toEqual({ action: 'skip', reason: 'unchanged' })
    expect(planUpload({ ...base, now: T0 + DAILY_MS + 1 })).toEqual({ action: 'send' })
    expect(planUpload({ ...base, sha: 'b', now: T0 + 1000 })).toEqual({ action: 'wait', ms: MIN_INTERVAL_MS - 1000 })
  })

  it('앱이 닫힌 사이에 바뀐 것은 다음 실행에서 바로 나간다', async () => {
    const { hub, deps, t } = await setup()
    await evaluateBoardUpload(deps, read(STATE))
    // 10분 안에 닫힘(변경은 못 보냄) → 한참 뒤 다시 열림: 저장된 sha 와 비교해 다르면 보낸다
    t.now += 30 * 60_000
    const changed: BoardState = { ...STATE, journals: [...STATE.journals, { id: '2026-11-08', missionId: M[0].id, status: 'draft' }] }
    expect((await evaluateBoardUpload(deps, read(changed))).kind).toBe('sent')
    expect(hub.puts).toHaveLength(2)
  })
})

describe('올리지 않는 경우', () => {
  it('기기 토글이 꺼져 있으면(기본) 보내지 않고 저장소도 읽지 않는다', async () => {
    const { hub, deps } = await setup(undefined, { enable: false })
    expect(boardUploadEnabled(deps)).toBe(false)
    const reader = vi.fn(async () => STATE)
    expect(await evaluateBoardUpload(deps, reader)).toEqual({ kind: 'skipped', reason: 'off' })
    expect(reader).not.toHaveBeenCalled()
    expect(hub.puts).toHaveLength(0)
  })

  it('Life Hub 에 연결돼 있지 않으면 보내지 않는다', async () => {
    const { hub, f } = fakeHub()
    const { deps } = makeDeps(f)
    setBoardUploadEnabled(deps, true)
    expect(await evaluateBoardUpload(deps, read(STATE))).toEqual({ kind: 'skipped', reason: 'not-connected' })
    expect(hub.puts).toHaveLength(0)
  })

  it('기록이 하나도 없으면(새 기기) 빈 목록으로 덮어쓰지 않는다', async () => {
    const { hub, deps } = await setup()
    expect(await evaluateBoardUpload(deps, read(EMPTY))).toEqual({ kind: 'skipped', reason: 'no-records' })
    expect(hub.puts).toHaveLength(0)
  })

  it('저장소를 읽다 실패해도 던지지 않는다', async () => {
    const { deps } = await setup()
    const r = await evaluateBoardUpload(deps, async () => { throw new Error('idb') })
    expect(r).toEqual({ kind: 'sent', outcome: 'retry' })
  })
})
