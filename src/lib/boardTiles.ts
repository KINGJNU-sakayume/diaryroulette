/**
 * Life Board 타일 목록(manifest v1)을 앱 상태에서 만든다. 순수 함수: 네트워크·저장소·무작위 없이 입력만으로
 * 결과가 정해진다(같은 입력이면 같은 출력이어야 업로드의 중복 전송 방지가 동작한다).
 *
 * - 규격: board 저장소 docs/TILES.md, 검증 코드 js/schema.js (이 저장소에는 테스트용 복사본만 둔다)
 * - 일기 내용은 담지 않는다. 미션 제목·날짜·카테고리명만 보낸다.
 * - 타일 글자는 앱을 다시 열 때까지 보드에 그대로 남으므로 "오늘"·"어제" 같은 말 대신 날짜(11/8)를 쓴다.
 */
import { getMission } from '../data/missions'
import { CATEGORIES } from '../data/categories'
import { addDays, getEffectiveDateString, parseDateId } from './date'
import { computeStreaks } from './streak'

export const BOARD_APP = 'diaryroulette'
export const BOARD_APP_URL = 'https://kingjnu-sakayume.github.io/diaryroulette/'

/** 타일 id는 사용자 배치가 이 값으로 저장되므로 한 번 정하면 바꾸지 않는다. */
export const TILE_IDS = { today: 'today', streak: 'streak', recent: 'recent' } as const

export interface BoardState {
  /** 저장된 오늘의 미션 기록(날짜는 일기 기준 'YYYY-MM-DD') */
  todayMission: { date: string; missionId: string } | null
  /** 일기 목록(내용 없이 id·미션·상태만) */
  journals: Array<{ id: string; missionId: string; status: 'completed' | 'draft' }>
}

export type Row = { title: string; value?: string; sub?: string; muted?: boolean }
export interface BoardTile {
  id: string
  name: string
  tone: 'type'
  form: 'line' | 'num' | 'list'
  sizes: string[]
  size: string
  default: boolean
  href: string
  detail?: { title: string; rows: Row[] }
  data: Record<string, unknown>
}
export interface BoardManifest {
  version: 1
  app: typeof BOARD_APP
  generated_at: string
  tiles: BoardTile[]
}

/** board js/schema.js 의 최대 길이 중 이 앱이 쓰는 것 */
const MAX = { text: 80, long: 160, rowValue: 24, unit: 8, name: 30 } as const
const TILE_ROWS = 5
const DETAIL_ROWS = 12

/** 앞뒤 공백을 떼고 JavaScript `.length` 기준으로 자른다. 비면 undefined(필드를 뺀다). */
function clip(s: string | undefined, max: number): string | undefined {
  const t = (s ?? '').trim()
  if (!t) return undefined
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t
}

/** '2026-11-08' → '11/8' */
function md(dateId: string): string {
  const d = parseDateId(dateId)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** 기록이 하나도 없으면(새 기기 등) 업로드하지 않는다. */
export function hasBoardRecords(state: BoardState): boolean {
  return state.journals.length > 0 || state.todayMission !== null
}

function todayTile(state: BoardState, today: string, completed: string[]): BoardTile {
  const journal = state.journals.find((j) => j.id === today)
  const missionId = journal?.missionId ?? (state.todayMission?.date === today ? state.todayMission.missionId : null)
  const mission = getMission(missionId)
  const data: Record<string, unknown> = { label: `${md(today)} 미션` }
  if (mission) {
    data.title = clip(mission.title, MAX.long)
    data.pill = journal?.status === 'completed' ? '완료' : journal ? '쓰는 중' : '아직 안 씀'
    const sub = clip(CATEGORIES[mission.category].label, MAX.long)
    if (sub) data.sub = sub
  } else {
    data.title = '아직 뽑지 않았어요'
    const last = completed[0]
    if (last) data.sub = `마지막 일기 ${md(last)}`
  }
  return {
    id: TILE_IDS.today,
    name: clip('일기 룰렛 · 오늘의 미션', MAX.name)!,
    tone: 'type',
    form: 'line',
    sizes: ['2x1', '4x1'],
    size: '2x1',
    default: true,
    href: BOARD_APP_URL,
    data,
  }
}

function streakTile(today: string, completed: string[]): BoardTile {
  const { current } = computeStreaks(completed, today)
  // 연속 일수를 마지막으로 센 날. 오늘 아직 안 썼으면 어제까지 이어진 것이다.
  const through = completed.includes(today) ? today : addDays(today, -1)
  return {
    id: TILE_IDS.streak,
    name: clip('일기 룰렛 · 연속 기록', MAX.name)!,
    tone: 'type',
    form: 'num',
    sizes: ['1x1', '2x1'],
    size: '1x1',
    default: false,
    href: BOARD_APP_URL,
    data: {
      label: '연속 기록',
      value: String(current),
      unit: clip('일', MAX.unit),
      caption: current > 0 ? `${md(through)}까지` : `${md(today)} 기준`,
    },
  }
}

function recentTile(state: BoardState, completed: string[]): BoardTile {
  const status = new Map(state.journals.map((j) => [j.id, j]))
  const rows: Row[] = []
  for (const id of completed) {
    const mission = getMission(status.get(id)?.missionId)
    if (!mission) continue
    const row: Row = { title: clip(mission.title, MAX.text)!, value: clip(md(id), MAX.rowValue) }
    const sub = clip(CATEGORIES[mission.category].label, MAX.text)
    if (sub) row.sub = sub
    rows.push(row)
    if (rows.length >= DETAIL_ROWS) break
  }
  const empty: Row[] = [{ title: '아직 완료한 일기가 없어요', muted: true }]
  return {
    id: TILE_IDS.recent,
    name: clip('일기 룰렛 · 최근 일기', MAX.name)!,
    tone: 'type',
    form: 'list',
    sizes: ['2x1', '2x2', '4x2'],
    size: '2x2',
    default: false,
    href: BOARD_APP_URL,
    ...(rows.length > 0 ? { detail: { title: '최근에 쓴 일기', rows } } : {}),
    data: { label: '최근에 쓴 일기', rows: rows.length > 0 ? rows.slice(0, TILE_ROWS) : empty },
  }
}

/**
 * 타일 목록. 기록이 하나도 없으면 빈 목록(업로드는 이 경우 따로 막는다).
 * 날짜는 입력 `now`로 판단한다(새벽 2시 전은 전날 일기).
 */
export function buildBoardTiles(state: BoardState, now: Date): BoardTile[] {
  if (!hasBoardRecords(state)) return []
  const today = getEffectiveDateString(now)
  // 오늘(일기 기준) 이후의 id는 센 적이 없으므로 제외하고, 최신순으로 둔다.
  const completed = state.journals
    .filter((j) => j.status === 'completed' && j.id <= today)
    .map((j) => j.id)
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
  return [todayTile(state, today, completed), streakTile(today, completed), recentTile(state, completed)]
}

/** `generated_at`은 입력 `now`(올리는 순간의 시각)를 초 단위 ISO로. */
export function boardManifest(state: BoardState, now: Date): BoardManifest {
  return {
    version: 1,
    app: BOARD_APP,
    generated_at: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    tiles: buildBoardTiles(state, now),
  }
}

/** 내용 비교(sha256)용 본문. `generated_at`을 뺀다. 키 순서는 위 생성 코드가 고정한다. */
export function boardBodyForHash(manifest: BoardManifest): string {
  return JSON.stringify({ version: manifest.version, app: manifest.app, tiles: manifest.tiles })
}
