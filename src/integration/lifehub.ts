/**
 * 일기 룰렛 ↔ Life Hub connection.
 *
 * - Connect: OAuth 2.1 authorization code + PKCE (S256). The owner signs in on Life Hub; 일기 룰렛 receives only
 *   a `diaryroulette:inbox` token for the `/diaryroulette` resource. Public client, no secret
 *   (public/lifehub-client.json).
 * - Shares with Life Hub only public mission ids/titles and today's state (missions resting in the cooldown,
 *   the mission already drawn today), so a Claude card can spin the roulette from what is actually available.
 *   Never diary text.
 * - Pulls `daily_mission` proposals; lifehubApply.ts decides with the app's own rules what is saved.
 *
 * Network and storage are injected so the flow is testable without a browser.
 */
import { missions, type Mission } from '../data/missions'
import { CATEGORIES } from '../data/categories'

export const LIFEHUB_ORIGIN = 'https://life-hub-api.213303.workers.dev'
export const APP_URL = 'https://kingjnu-sakayume.github.io/diaryroulette/'
export const CLIENT_ID = APP_URL + 'lifehub-client.json'
export const RESOURCE = LIFEHUB_ORIGIN + '/diaryroulette'
/** `diaryroulette:board` lets the app upload its Life Board tiles. Connections made before it was added lack it. */
export const SCOPE = 'diaryroulette:inbox diaryroulette:board'
const API = LIFEHUB_ORIGIN + '/diaryroulette/v1'

type KV = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export interface Deps {
  fetch: typeof fetch
  storage: KV
  session: KV
  now: () => number
  random: (bytes: number) => Uint8Array
  sha256: (data: Uint8Array) => Promise<Uint8Array>
}
export function browserDeps(): Deps {
  return {
    fetch: (input, init) => fetch(input, init),
    storage: localStorage,
    session: sessionStorage,
    now: () => Date.now(),
    random: (n) => crypto.getRandomValues(new Uint8Array(n)),
    sha256: async (d) => new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(d))),
  }
}

export type LifeHubErrorKind = 'not_connected' | 'denied' | 'state' | 'network' | 'server'
export class LifeHubError extends Error {
  kind: LifeHubErrorKind
  constructor(kind: LifeHubErrorKind, message: string) {
    super(message)
    this.kind = kind
  }
}

/* ---------- proposal contract (mirrors life-hub src/adapters/diaryroulette.js) ---------- */

export interface Proposal {
  key: string
  source: string
  date: string
  missionId: string
  /** 'approved' = the owner pressed 「일기 쓰기」 in a Claude card; 일기 룰렛 has not saved it yet. */
  status: 'pending' | 'approved'
  needsAppReview: boolean
}
const KEY = /^(claude|chatgpt|codex|manual):[A-Za-z0-9_.:-]{8,128}$/
const MISSION_ID = /^[a-z0-9_-]{1,40}$/
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const validDate = (v: unknown) => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const d = new Date(v + 'T00:00:00Z')
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}

/** One item from the hub, validated again here; null for anything outside the contract. */
export function parseProposal(item: unknown): Proposal | null {
  if (!obj(item) || typeof item.key !== 'string' || !KEY.test(item.key)) return null
  if (item.status !== 'pending' && item.status !== 'approved') return null
  const c = item.final_candidate ?? item.candidate
  if (!obj(c) || c.schema_version !== 1 || c.candidate_type !== 'daily_mission' || typeof c.source !== 'string' ||
    `${c.source}:${c.idempotency_key}` !== item.key || !obj(c.payload)) return null
  const p = c.payload
  if (Object.keys(p).some((k) => k !== 'date' && k !== 'mission_id') || !validDate(p.date) ||
    typeof p.mission_id !== 'string' || !MISSION_ID.test(p.mission_id)) return null
  return { key: item.key, source: c.source, date: p.date as string, missionId: p.mission_id, status: item.status,
    needsAppReview: item.needs_app_review === true }
}

/* ---------- OAuth ---------- */

const TOKENS_KEY = 'diaryroulette.lifehub.tokens.v1';
const RECONNECT_KEY = 'diaryroulette.lifehub.reconnect.v1';
const PENDING_AUTH_KEY = 'diaryroulette.lifehub.pending-auth.v1';
const BOARD_RECONNECT_KEY = 'diaryroulette.board.reconnect.v1';
const AUTH_MAX_AGE_MS = 10 * 60 * 1000;
interface Tokens {
  access_token: string;
  access_expires_at: number;
  refresh_token: string;
}
interface PendingAuth {
  state: string;
  verifier: string;
  created_at: number;
}
export type Outcome = 'confirmed' | 'rejected' | 'conflict' | 'missing';

export function readJson<T>(store: KV, key: string): T | null {
  try {
    const raw = store.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
const b64url = (bytes: Uint8Array) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export function connectAvailable(loc: { origin: string; pathname: string }): boolean {
  const app = new URL(APP_URL);
  return loc.origin === app.origin && (loc.pathname === app.pathname || loc.pathname === app.pathname + 'index.html');
}
export function isConnected(deps: Pick<Deps, 'storage'>): boolean {
  return typeof readJson<Tokens>(deps.storage, TOKENS_KEY)?.refresh_token === 'string';
}
/** Life Hub refused the stored tokens: the owner has to sign in again (settings state 「확인 필요」). */
export function needsReconnect(deps: Pick<Deps, 'storage'>): boolean {
  return deps.storage.getItem(RECONNECT_KEY) === '1';
}
export function dropRejectedTokens(deps: Pick<Deps, 'storage'>): void {
  deps.storage.removeItem(TOKENS_KEY);
  deps.storage.setItem(RECONNECT_KEY, '1');
}
/** The stored sign-in lacks the board scope: the tile upload waits until the owner connects again (tokens are kept). */
export function boardNeedsReconnect(deps: Pick<Deps, 'storage'>): boolean {
  return deps.storage.getItem(BOARD_RECONNECT_KEY) === '1';
}
export function setBoardNeedsReconnect(deps: Pick<Deps, 'storage'>, on: boolean): void {
  if (on) deps.storage.setItem(BOARD_RECONNECT_KEY, '1');
  else deps.storage.removeItem(BOARD_RECONNECT_KEY);
}
export function isAuthCallback(search: string): boolean {
  const q = new URLSearchParams(search);
  return q.has('state') && (q.has('code') || q.has('error'));
}

export async function beginConnect(deps: Deps): Promise<string> {
  const verifier = b64url(deps.random(32));
  const state = b64url(deps.random(16));
  const challenge = b64url(await deps.sha256(new TextEncoder().encode(verifier)));
  deps.session.setItem(PENDING_AUTH_KEY, JSON.stringify({ state, verifier, created_at: deps.now() } satisfies PendingAuth));
  const q = new URLSearchParams({
    response_type: 'code', client_id: CLIENT_ID, redirect_uri: APP_URL, scope: SCOPE, state,
    code_challenge: challenge, code_challenge_method: 'S256', resource: RESOURCE,
  });
  return LIFEHUB_ORIGIN + '/authorize?' + q.toString();
}

async function tokenRequest(deps: Deps, params: Record<string, string>): Promise<Tokens> {
  let response: Response;
  try {
    response = await deps.fetch(LIFEHUB_ORIGIN + '/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CLIENT_ID, ...params }).toString(),
    });
  } catch {
    throw new LifeHubError('network', 'Life Hub에 연결할 수 없어요. 네트워크를 확인해 주세요.');
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    if (body.error === 'invalid_grant') {
      dropRejectedTokens(deps);
      throw new LifeHubError('not_connected', 'Life Hub 연결이 만료됐어요. 다시 연결해 주세요.');
    }
    throw new LifeHubError('server', `Life Hub 인증 서버 오류 (${response.status})`);
  }
  if (typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string' || String(body.token_type).toLowerCase() !== 'bearer')
    throw new LifeHubError('server', 'Life Hub 응답 형식이 올바르지 않아요.');
  const tokens: Tokens = {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    access_expires_at: deps.now() + (typeof body.expires_in === 'number' ? body.expires_in : 300) * 1000,
  };
  deps.storage.setItem(TOKENS_KEY, JSON.stringify(tokens));
  deps.storage.removeItem(RECONNECT_KEY);
  return tokens;
}

export async function completeConnect(search: string, deps: Deps): Promise<void> {
  const q = new URLSearchParams(search);
  const pending = readJson<PendingAuth>(deps.session, PENDING_AUTH_KEY);
  deps.session.removeItem(PENDING_AUTH_KEY);
  if (!pending || q.get('state') !== pending.state || deps.now() - pending.created_at > AUTH_MAX_AGE_MS)
    throw new LifeHubError('state', '연결 요청이 만료됐거나 이 브라우저에서 시작되지 않았어요. 다시 연결해 주세요.');
  if (q.has('iss') && q.get('iss') !== LIFEHUB_ORIGIN) throw new LifeHubError('state', '다른 서버의 응답이라 연결하지 않았어요.');
  if (q.has('error'))
    throw new LifeHubError('denied', q.get('error') === 'access_denied' ? 'Life Hub 연결을 거절했어요.' : 'Life Hub 연결에 실패했어요.');
  const code = q.get('code');
  if (!code) throw new LifeHubError('state', '인증 코드가 없어요.');
  await tokenRequest(deps, {
    grant_type: 'authorization_code', code, redirect_uri: APP_URL, code_verifier: pending.verifier, resource: RESOURCE,
  });
  // A fresh sign-in asks for the board scope, so a past "needs the scope" verdict no longer holds.
  setBoardNeedsReconnect(deps, false);
}

export async function accessToken(deps: Deps, force = false): Promise<string> {
  const tokens = readJson<Tokens>(deps.storage, TOKENS_KEY);
  if (!tokens?.refresh_token) throw new LifeHubError('not_connected', 'Life Hub에 연결되어 있지 않아요.');
  if (!force && tokens.access_expires_at - 60_000 > deps.now()) return tokens.access_token;
  return (await tokenRequest(deps, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token })).access_token;
}

async function api(deps: Deps, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<Response> {
  const send = async (token: string) => {
    try {
      return await deps.fetch(API + path, {
        method,
        headers: { Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new LifeHubError('network', 'Life Hub에 연결할 수 없어요. 네트워크를 확인해 주세요.');
    }
  };
  let response = await send(await accessToken(deps));
  if (response.status === 401) response = await send(await accessToken(deps, true));
  if (response.status === 401 || response.status === 403) {
    dropRejectedTokens(deps);
    throw new LifeHubError('not_connected', 'Life Hub 연결이 더 이상 유효하지 않아요. 다시 연결해 주세요.');
  }
  return response;
}

export function disconnect(deps: Deps): void {
  const tokens = readJson<Tokens>(deps.storage, TOKENS_KEY);
  setBoardNeedsReconnect(deps, false);
  deps.storage.removeItem(TOKENS_KEY);
  deps.storage.removeItem(RECONNECT_KEY);
  if (tokens?.refresh_token)
    void deps
      .fetch(LIFEHUB_ORIGIN + '/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: tokens.refresh_token, token_type_hint: 'refresh_token', client_id: CLIENT_ID }).toString(),
      })
      .catch(() => undefined);
}


/* ---------- decisions, outbox and settings ---------- */

const OUTCOMES_KEY = 'diaryroulette.lifehub.outcomes.v1'
const RECEIPTS_KEY = 'diaryroulette.lifehub.receipts.v1'
const REJECTIONS_KEY = 'diaryroulette.lifehub.rejections.v1'
const AUTO_APPLY_KEY = 'diaryroulette.lifehub.auto-apply.v1'
const MISSIONS_REF_KEY = 'diaryroulette.lifehub.missions-ref.v1'
const STATE_REF_KEY = 'diaryroulette.lifehub.state-ref.v1'

export function outcomes(deps: Pick<Deps, 'storage'>): Record<string, Outcome> {
  const map = readJson<Record<string, Outcome>>(deps.storage, OUTCOMES_KEY)
  return map && typeof map === 'object' && !Array.isArray(map) ? map : {}
}
function receiptMap(deps: Pick<Deps, 'storage'>): Record<string, string> {
  const map = readJson<Record<string, string>>(deps.storage, RECEIPTS_KEY)
  return map && typeof map === 'object' && !Array.isArray(map) ? map : {}
}
function rejectionList(deps: Pick<Deps, 'storage'>): string[] {
  const list = readJson<string[]>(deps.storage, REJECTIONS_KEY)
  return Array.isArray(list) ? list.filter((k) => typeof k === 'string') : []
}
/** The proposal became the day's mission (or already was): sent as a receipt on the next sync. */
export function rememberReceipt(key: string, date: string, deps: Pick<Deps, 'storage'>): void {
  deps.storage.setItem(RECEIPTS_KEY, JSON.stringify({ ...receiptMap(deps), [key]: date }))
}
/** The owner said no, or the app's last check did (a past day, another mission that day). */
export function rejectLocally(key: string, deps: Pick<Deps, 'storage'>): void {
  const list = rejectionList(deps)
  if (!list.includes(key)) deps.storage.setItem(REJECTIONS_KEY, JSON.stringify([...list, key]))
}
export function decidedKeys(deps: Pick<Deps, 'storage'>): Set<string> {
  return new Set([...Object.keys(receiptMap(deps)), ...rejectionList(deps)])
}

/** 「Claude에서 승인된 항목 자동 반영」: on unless the owner turned it off on this device. */
export function autoApplyEnabled(deps: Pick<Deps, 'storage'>): boolean {
  return deps.storage.getItem(AUTO_APPLY_KEY) !== 'off'
}
export function setAutoApply(deps: Pick<Deps, 'storage'>, on: boolean): void {
  if (on) deps.storage.removeItem(AUTO_APPLY_KEY)
  else deps.storage.setItem(AUTO_APPLY_KEY, 'off')
}

/* ---------- reference lists for the Claude card ---------- */

/** Bump when the mission list changes, so Life Hub gets the new one. */
export const MISSIONS_REF_REVISION = 1
export interface RefItem {
  id: string
  label: string
  group: string
}
export const missionRefs = (list: Mission[] = missions): RefItem[] =>
  list.map((m) => ({ id: m.id, label: m.title.slice(0, 80), group: CATEGORIES[m.category].label }))

/** Today's state for the card: missions resting in the cooldown, and the mission already chosen today. */
export function stateRefs(restingIds: string[], today: { date: string; missionId: string } | null): RefItem[] {
  const title = (id: string) => missions.find((m) => m.id === id)?.title.slice(0, 80)
  const out: RefItem[] = []
  if (today && title(today.missionId)) out.push({ id: today.missionId, label: title(today.missionId)!, group: 'today:' + today.date })
  for (const id of restingIds)
    if (id !== today?.missionId && title(id)) out.push({ id, label: title(id)!, group: 'resting' })
  return out
}

/** 'stored', 'newer' (409: Life Hub already holds a newer revision of this kind) or 'failed'. */
async function putRefs(kind: string, revision: number, items: RefItem[], deps: Deps): Promise<'stored' | 'newer' | 'failed'> {
  const response = await api(deps, 'PUT', '/refs/' + kind, { revision, items })
  return response.ok ? 'stored' : response.status === 409 ? 'newer' : 'failed'
}
/** Sends the mission list once per revision and today's state whenever it changed. */
export async function uploadRefs(state: RefItem[], deps: Deps): Promise<{ missions: boolean; state: boolean }> {
  const sent = { missions: false, state: false }
  if (deps.storage.getItem(MISSIONS_REF_KEY) !== String(MISSIONS_REF_REVISION) &&
    (await putRefs('missions', MISSIONS_REF_REVISION, missionRefs(), deps)) !== 'failed') {
    deps.storage.setItem(MISSIONS_REF_KEY, String(MISSIONS_REF_REVISION))
    sent.missions = true
  }
  const body = JSON.stringify(state)
  const last = readJson<{ revision: number; body: string }>(deps.storage, STATE_REF_KEY)
  if (last?.body !== body) {
    const revision = Math.max(deps.now(), (last?.revision ?? 0) + 1)
    // A 409 for today's state means another device (or a clock ahead of ours) sent a later revision: not
    // recorded as sent, so the next sync sends this state again with a later time.
    if ((await putRefs('state', revision, state, deps)) === 'stored') {
      deps.storage.setItem(STATE_REF_KEY, JSON.stringify({ revision, body }))
      sent.state = true
    }
  }
  return sent
}

/* ---------- sync ---------- */

export interface SyncResult {
  proposals: Proposal[]
  receiptsSent: number
  rejectionsSent: number
  conflicts: number
  waiting: number
}
/** Sends decisions, shares today's state, then fetches open proposals not decided here. Saves nothing. */
export async function sync(state: RefItem[], deps: Deps): Promise<SyncResult> {
  const done = outcomes(deps)
  const result: SyncResult = { proposals: [], receiptsSent: 0, rejectionsSent: 0, conflicts: 0, waiting: 0 }
  const record = (key: string, response: Response, ok: Outcome) => {
    if (response.ok) done[key] = ok
    else if (response.status === 409) done[key] = 'conflict'
    else if (response.status === 404) done[key] = 'missing'
    else {
      result.waiting++
      return false
    }
    deps.storage.setItem(OUTCOMES_KEY, JSON.stringify(done))
    return response.ok
  }
  for (const [key, date] of Object.entries(receiptMap(deps))) {
    if (done[key]) continue
    if (record(key, await api(deps, 'POST', '/receipts', { key, entity_type: 'daily_mission', entity_id: date }), 'confirmed'))
      result.receiptsSent++
  }
  for (const key of rejectionList(deps)) {
    if (done[key]) continue
    if (record(key, await api(deps, 'POST', '/rejections', { key }), 'rejected')) result.rejectionsSent++
  }
  await uploadRefs(state, deps).catch(() => undefined)
  const response = await api(deps, 'GET', '/candidates?status=open&limit=100')
  if (!response.ok) throw new LifeHubError('server', `Life Hub 제안을 가져오지 못했어요 (${response.status})`)
  const body = (await response.json().catch(() => null)) as { candidates?: unknown } | null
  if (!body || !Array.isArray(body.candidates)) throw new LifeHubError('server', 'Life Hub 응답 형식이 올바르지 않아요.')
  const decided = decidedKeys(deps)
  for (const item of body.candidates) {
    const p = parseProposal(item)
    if (p && !decided.has(p.key)) result.proposals.push(p)
  }
  result.conflicts = Object.values(done).filter((v) => v === 'conflict').length
  return result
}
