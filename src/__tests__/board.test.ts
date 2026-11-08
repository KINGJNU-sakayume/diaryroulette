import { describe, expect, it } from 'vitest'
import sampleRaw from '../../board/sample.json?raw'
import { validateManifest } from './vendor/board-schema.js'
import {
  boardBodyForHash, boardManifest, buildBoardTiles, hasBoardRecords, TILE_IDS, type BoardState,
} from '../lib/boardTiles'
import { missions } from '../data/missions'

// board js/config.js 의 값과 같게(출처: board da62c8c). 빼면 href 가 있는 타일이 모두 오류로 빠진다.
const POLICY = {
  imageOrigins: [
    'https://kingjnu-sakayume.github.io', 'https://image.aladin.co.kr', 'https://upload.wikimedia.org', 'https://i.scdn.co',
    'https://is1-ssl.mzstatic.com', 'https://is2-ssl.mzstatic.com', 'https://is3-ssl.mzstatic.com', 'https://is4-ssl.mzstatic.com',
    'https://is5-ssl.mzstatic.com', 'https://image.tmdb.org', 'https://t1.daumcdn.net', 'https://search1.kakaocdn.net',
  ],
  linkOrigins: ['https://kingjnu-sakayume.github.io'],
}

// 날짜는 로컬 시각 기준이라 로컬 생성자로 만든다(ISO 문자열은 시간대에 따라 날짜가 달라진다).
const at = (m: number, d: number, h = 12) => new Date(2026, m - 1, d, h, 0, 0)
const M = missions
/** 지어낸 상태: 11/3, 11/5·11/6·11/7 완료, 오늘(11/8)은 미션만 뽑음 */
export const SAMPLE_STATE: BoardState = {
  todayMission: { date: '2026-11-08', missionId: M[3].id },
  journals: [
    { id: '2026-11-03', missionId: M[0].id, status: 'completed' },
    { id: '2026-11-05', missionId: M[1].id, status: 'completed' },
    { id: '2026-11-06', missionId: M[2].id, status: 'completed' },
    { id: '2026-11-07', missionId: M[9].id, status: 'completed' },
  ],
}
const EMPTY: BoardState = { todayMission: null, journals: [] }
const tileOf = (s: BoardState, now: Date, id: string) => buildBoardTiles(s, now).find((t) => t.id === id)!
const data = (s: BoardState, now: Date, id: string) => tileOf(s, now, id).data as Record<string, unknown>

describe('규격 v1 검사', () => {
  it('예시 출력이 board schema 를 통과한다(errors 0개, 타일 수 일치)', () => {
    const manifest = boardManifest(SAMPLE_STATE, at(11, 8))
    const result = validateManifest(manifest, POLICY)
    expect(result.errors).toEqual([])
    expect(result.tiles).toHaveLength(manifest.tiles.length)
    expect(result.tiles).toHaveLength(3)
    expect(result.app).toBe('diaryroulette')
  })

  it('board/sample.json 은 함수 출력과 같다', () => {
    const sample = JSON.parse(sampleRaw)
    // generated_at 은 시간대에 따라 달라지므로 비교에서 뺀다(형식은 아래 검사가 본다).
    const expected = JSON.parse(JSON.stringify(boardManifest(SAMPLE_STATE, at(11, 8))))
    expect({ ...sample, generated_at: undefined }).toEqual({ ...expected, generated_at: undefined })
    const result = validateManifest(sample, POLICY)
    expect(result.errors).toEqual([])
    expect(result.tiles).toHaveLength(sample.tiles.length)
  })

  it('기록만 있는 모든 상태(초안만, 미션만, 지난 미션)도 통과한다', () => {
    const states: BoardState[] = [
      { todayMission: null, journals: [{ id: '2026-11-08', missionId: M[0].id, status: 'draft' }] },
      { todayMission: { date: '2026-11-08', missionId: M[0].id }, journals: [] },
      { todayMission: { date: '2026-11-01', missionId: M[0].id }, journals: [] },
      SAMPLE_STATE,
    ]
    for (const s of states) {
      const manifest = boardManifest(s, at(11, 8))
      const r = validateManifest(manifest, POLICY)
      expect(r.errors).toEqual([])
      expect(r.tiles).toHaveLength(manifest.tiles.length)
    }
  })

  it('JSON 크기는 64 KiB 이하', () => {
    const many: BoardState = { todayMission: null, journals: M.slice(0, 40).map((m, i) => ({ id: `2026-10-${String(i + 1).padStart(2, '0')}`, missionId: m.id, status: 'completed' })) }
    expect(new TextEncoder().encode(JSON.stringify(boardManifest(many, at(11, 8)))).length).toBeLessThan(64 * 1024)
  })
})

describe('타일 구성', () => {
  const tiles = buildBoardTiles(SAMPLE_STATE, at(11, 8))

  it('id 는 고정이고 순서가 정해져 있다', () => {
    expect(tiles.map((t) => t.id)).toEqual(['today', 'streak', 'recent'])
    expect(TILE_IDS).toEqual({ today: 'today', streak: 'streak', recent: 'recent' })
  })

  it('sizes / size / default / 톤', () => {
    const by = Object.fromEntries(tiles.map((t) => [t.id, t]))
    expect([by.today.sizes, by.today.size, by.today.default, by.today.form]).toEqual([['2x1', '4x1'], '2x1', true, 'line'])
    expect([by.streak.sizes, by.streak.size, by.streak.default, by.streak.form]).toEqual([['1x1', '2x1'], '1x1', false, 'num'])
    expect([by.recent.sizes, by.recent.size, by.recent.default, by.recent.form]).toEqual([['2x1', '2x2', '4x2'], '2x2', false, 'list'])
    for (const t of tiles) {
      expect(t.tone).toBe('type')
      expect(t.sizes).toContain(t.size)
      expect(t.href).toBe('https://kingjnu-sakayume.github.io/diaryroulette/')
      expect(t).not.toHaveProperty('accent')
    }
  })

  it('today: 뽑은 날짜가 라벨에 들어가고 상태가 배지로 나온다', () => {
    expect(data(SAMPLE_STATE, at(11, 8), 'today')).toMatchObject({ label: '11/8 미션', title: M[3].title, pill: '아직 안 씀' })
    const draft: BoardState = { ...SAMPLE_STATE, journals: [...SAMPLE_STATE.journals, { id: '2026-11-08', missionId: M[3].id, status: 'draft' }] }
    expect(data(draft, at(11, 8), 'today').pill).toBe('쓰는 중')
    const done: BoardState = { ...SAMPLE_STATE, journals: [...SAMPLE_STATE.journals, { id: '2026-11-08', missionId: M[3].id, status: 'completed' }] }
    expect(data(done, at(11, 8), 'today').pill).toBe('완료')
  })

  it('today: 앱을 열지 않은 다음 날에도 지난 미션이 오늘로 읽히지 않는다', () => {
    // 11/9 에 만든 목록: 11/8 미션은 오늘 것이 아니므로 제목으로 나오지 않고 날짜는 11/9
    const d = data(SAMPLE_STATE, at(11, 9), 'today')
    expect(d.label).toBe('11/9 미션')
    expect(d.title).toBe('아직 뽑지 않았어요')
    expect(d.sub).toBe('마지막 일기 11/7')
    expect(d).not.toHaveProperty('pill')
  })

  it('새벽 2시 전은 전날 일기로 친다', () => {
    expect(data(SAMPLE_STATE, at(11, 9, 1), 'today').label).toBe('11/8 미션')
    expect(data(SAMPLE_STATE, at(11, 9, 2), 'today').label).toBe('11/9 미션')
  })

  it('streak: 기준일과 함께 보낸다', () => {
    expect(data(SAMPLE_STATE, at(11, 8), 'streak')).toEqual({ label: '연속 기록', value: '3', unit: '일', caption: '11/7까지' })
    const wrote: BoardState = { ...SAMPLE_STATE, journals: [...SAMPLE_STATE.journals, { id: '2026-11-08', missionId: M[3].id, status: 'completed' }] }
    expect(data(wrote, at(11, 8), 'streak')).toMatchObject({ value: '4', caption: '11/8까지' })
    // 이틀 건너뛰면 끊긴다
    expect(data(SAMPLE_STATE, at(11, 10), 'streak')).toMatchObject({ value: '0', caption: '11/10 기준' })
  })

  it('recent: 최신순 5개와 상세 12개, 일기 내용은 없다', () => {
    const many: BoardState = { todayMission: null, journals: M.slice(0, 14).map((m, i) => ({ id: `2026-10-${String(i + 10).padStart(2, '0')}`, missionId: m.id, status: 'completed' })) }
    const t = tileOf(many, at(11, 8), 'recent')
    const rows = (t.data as { rows: Array<{ title: string; value: string }> }).rows
    expect(rows).toHaveLength(5)
    expect(rows[0].value).toBe('10/23')
    expect(t.detail!.rows).toHaveLength(12)
    expect(JSON.stringify(boardManifest(many, at(11, 8)))).not.toContain('content')
  })

  it('recent: 완료한 일기가 없으면 muted 행', () => {
    const t = tileOf({ todayMission: { date: '2026-11-08', missionId: M[0].id }, journals: [] }, at(11, 8), 'recent')
    expect((t.data as { rows: unknown[] }).rows).toEqual([{ title: '아직 완료한 일기가 없어요', muted: true }])
    expect(t.detail).toBeUndefined()
  })

  it('알 수 없는 미션 id 는 행에서 뺀다', () => {
    const s: BoardState = { todayMission: null, journals: [{ id: '2026-11-07', missionId: 'nope-1', status: 'completed' }, { id: '2026-11-06', missionId: M[0].id, status: 'completed' }] }
    const rows = (tileOf(s, at(11, 8), 'recent').data as { rows: Array<{ value: string }> }).rows
    expect(rows.map((r) => r.value)).toEqual(['11/6'])
  })
})

describe('빈 상태', () => {
  it('기록이 없으면 타일이 없고 업로드 대상도 아니다', () => {
    expect(hasBoardRecords(EMPTY)).toBe(false)
    expect(buildBoardTiles(EMPTY, at(11, 8))).toEqual([])
    const r = validateManifest(boardManifest(EMPTY, at(11, 8)), POLICY)
    expect(r.errors).toEqual([])
    expect(r.tiles).toHaveLength(0)
  })
})

describe('글자 규칙', () => {
  it('긴 글자는 길이 제한 안으로 자르고, 빈 글자 필드는 아예 없다', () => {
    const long = 'ㄱ'.repeat(500)
    const original = M[0].title
    M[0].title = long
    try {
      const manifest = boardManifest({ todayMission: { date: '2026-11-08', missionId: M[0].id }, journals: [{ id: '2026-11-07', missionId: M[0].id, status: 'completed' }] }, at(11, 8))
      const r = validateManifest(manifest, POLICY)
      expect(r.errors).toEqual([])
      expect(r.tiles).toHaveLength(3)
      const walk = (v: unknown): void => {
        if (typeof v === 'string') expect(v.trim()).not.toBe('')
        else if (Array.isArray(v)) v.forEach(walk)
        else if (v && typeof v === 'object') Object.values(v).forEach(walk)
      }
      walk(manifest)
      expect(((manifest.tiles[0].data as { title: string }).title).length).toBeLessThanOrEqual(160)
    } finally {
      M[0].title = original
    }
  })

  it('이름은 30자 이내', () => {
    for (const t of buildBoardTiles(SAMPLE_STATE, at(11, 8))) expect(t.name.length).toBeLessThanOrEqual(30)
  })
})

describe('결정성', () => {
  it('같은 입력이면 같은 출력', () => {
    const a = JSON.stringify(boardManifest(SAMPLE_STATE, at(11, 8)))
    const b = JSON.stringify(boardManifest(structuredClone(SAMPLE_STATE), at(11, 8)))
    expect(a).toBe(b)
  })
  it('해시용 본문은 generated_at 에 영향받지 않고, 내용이 바뀌면 달라진다', () => {
    const a = boardBodyForHash(boardManifest(SAMPLE_STATE, at(11, 8, 12)))
    const b = boardBodyForHash(boardManifest(SAMPLE_STATE, at(11, 8, 15)))
    expect(a).toBe(b)
    expect(a).not.toContain('generated_at')
    expect(boardBodyForHash(boardManifest(SAMPLE_STATE, at(11, 9)))).not.toBe(a)
  })
})
