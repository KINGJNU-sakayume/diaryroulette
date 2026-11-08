import type { BoardState } from '../lib/boardTiles'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TodayMissionRecord {
  key: 'todayMission'
  date: string // YYYY-MM-DD local
  missionId: string
  extraData?: Record<string, unknown>
}

export interface CooldownListRecord {
  key: 'cooldownList'
  entries: CooldownEntry[]
}

export interface CooldownEntry {
  missionId: string
  drawnAt: string // ISO datetime
}

export interface JournalEntry {
  id: string // YYYY-MM-DD
  missionId: string
  type: 'text' | 'canvas' | 'trash'
  content: string | null
  status: 'completed' | 'draft'
  createdAt: string // ISO
  completedAt: string | null
  extraData?: Record<string, unknown>
}

/** Fired after the diary records change, so the Life Board upload can look at what changed. */
export const BOARD_DATA_EVENT = 'board-data-changed'
function notifyBoardData(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(BOARD_DATA_EVENT))
}

// ─── DB singleton ─────────────────────────────────────────────────────────────

const DB_NAME = 'diary-roulette'
const DB_VERSION = 1

let dbPromise: Promise<IDBDatabase> | null = null

function getDB(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)

      req.onupgradeneeded = (e) => {
        const db = (e.target as IDBOpenDBRequest).result
        if (!db.objectStoreNames.contains('missions')) {
          db.createObjectStore('missions', { keyPath: 'key' })
        }
        if (!db.objectStoreNames.contains('journals')) {
          const js = db.createObjectStore('journals', { keyPath: 'id' })
          js.createIndex('by-status', 'status', { unique: false })
          js.createIndex('by-missionId', 'missionId', { unique: false })
        }
      }

      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  return dbPromise
}

// ─── Generic transaction helper ───────────────────────────────────────────────

function tx<T>(
  storeName: 'missions' | 'journals',
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return getDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(storeName, mode)
        const store = transaction.objectStore(storeName)
        const req = fn(store)
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
}

// ─── missions store ───────────────────────────────────────────────────────────

export async function getTodayMission(): Promise<TodayMissionRecord | undefined> {
  return tx<TodayMissionRecord | undefined>('missions', 'readonly', (s) => s.get('todayMission'))
}

export async function setTodayMission(record: TodayMissionRecord): Promise<void> {
  await tx<IDBValidKey>('missions', 'readwrite', (s) => s.put(record))
  notifyBoardData()
}

export async function getCooldownList(): Promise<CooldownEntry[]> {
  const record = await tx<CooldownListRecord | undefined>('missions', 'readonly', (s) =>
    s.get('cooldownList'),
  )
  return record?.entries ?? []
}

export async function setCooldownList(entries: CooldownEntry[]): Promise<void> {
  const record: CooldownListRecord = { key: 'cooldownList', entries }
  await tx<IDBValidKey>('missions', 'readwrite', (s) => s.put(record))
}

// ─── journals store ───────────────────────────────────────────────────────────

export async function getJournal(id: string): Promise<JournalEntry | undefined> {
  return tx<JournalEntry | undefined>('journals', 'readonly', (s) => s.get(id))
}

export async function saveJournal(entry: JournalEntry): Promise<void> {
  await tx<IDBValidKey>('journals', 'readwrite', (s) => s.put(entry))
  notifyBoardData()
}

export async function getAllJournals(): Promise<JournalEntry[]> {
  return tx<JournalEntry[]>('journals', 'readonly', (s) => s.getAll())
}

export async function getJournalsByStatus(
  status: 'completed' | 'draft',
): Promise<JournalEntry[]> {
  return getDB().then(
    (db) =>
      new Promise<JournalEntry[]>((resolve, reject) => {
        const transaction = db.transaction('journals', 'readonly')
        const index = transaction.objectStore('journals').index('by-status')
        const req = index.getAll(status)
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
}

export async function deleteJournal(id: string): Promise<void> {
  await tx<undefined>('journals', 'readwrite', (s) => s.delete(id))
  notifyBoardData()
}

export async function clearAllData(): Promise<void> {
  const db = await getDB()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(['missions', 'journals'], 'readwrite')
    transaction.objectStore('missions').clear()
    transaction.objectStore('journals').clear()
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
  notifyBoardData()
}

// ─── Atomic import ────────────────────────────────────────────────────────────
// 단일 readwrite 트랜잭션으로 전체 데이터를 교체한다.
// 어느 한 put이라도 실패하면 IndexedDB가 자동으로 전체 트랜잭션을 abort → 기존
// 데이터 손실 없이 롤백된다. 기존 importFromJSON의 "clear 후 순차 put" 패턴은
// 중간 실패 시 반쯤 깨진 상태를 남겼으나, 이 함수는 all-or-nothing을 보장한다.
export async function atomicImport(payload: {
  todayMission: TodayMissionRecord | null
  cooldownList: CooldownEntry[]
  journals: JournalEntry[]
}): Promise<void> {
  const db = await getDB()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(['missions', 'journals'], 'readwrite')
    const missionsStore = transaction.objectStore('missions')
    const journalsStore = transaction.objectStore('journals')

    // 기존 데이터 전부 제거
    missionsStore.clear()
    journalsStore.clear()

    // todayMission (optional)
    if (payload.todayMission) {
      missionsStore.put(payload.todayMission)
    }

    // cooldownList는 항상 하나의 레코드
    const cooldownRecord: CooldownListRecord = {
      key: 'cooldownList',
      entries: payload.cooldownList,
    }
    missionsStore.put(cooldownRecord)

    // 모든 journal 엔트리
    for (const journal of payload.journals) {
      journalsStore.put(journal)
    }

    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('Transaction aborted'))
  })
  notifyBoardData()
}

// ─── Life Board ───────────────────────────────────────────────────────────────

/** What the board tiles are built from: ids, missions and statuses only, no diary content. */
export async function readBoardState(): Promise<BoardState> {
  const [todayMission, journals] = await Promise.all([getTodayMission(), getAllJournals()])
  return {
    todayMission: todayMission ? { date: todayMission.date, missionId: todayMission.missionId } : null,
    journals: journals.map((j) => ({ id: j.id, missionId: j.missionId, status: j.status })),
  }
}
