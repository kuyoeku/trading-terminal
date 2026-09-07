// Copyright (c) 2026 Juan Ignacio Molina Estrada
// SPDX-License-Identifier: FSL-1.1-Apache-2.0
/**
 * Bark delivery.
 *
 * The terminal talks to the Bark server directly from the client — the same
 * shape as Telegram. There is no Pairlens relay, which is what makes this
 * work in a standalone install.
 *
 * ## Where the address lives, and why not in the rule
 *
 * A Bark URL is a push address, not a credential: anyone who can see it can
 * send a notification, and that is the whole of the product. It does not go
 * in the keychain or the vault. Notification rules still must not carry it,
 * because they ride the sync bus to the App Server under the `automation`
 * domain. The address is a plain localStorage record on this device. It is
 * deliberately NOT emitted on the sync channel — the coordinator drops
 * unknown keys — because a phone that only this machine pushes to is
 * meaningless on another device anyway.
 *
 * ## CORS and desktop CSP
 *
 * Official `api.day.app` is in the desktop CSP baseline
 * (`apps/desktop/src-tauri/src/csp.rs`). A self-hosted origin is granted on
 * connect, the same way a webhook host is granted on commit. A server that
 * refuses the browser Origin (no CORS, or a dead host) fails the test send
 * with a named error rather than a silent channel.
 */

import type { NotificationMessage } from '@pairlens/notification-engine/types'
import {
  computeUngrantedHostList,
  grantNetworkHosts,
  isDesktopNetworkGoverned,
} from '@/lib/plugins/network-grants'

// ── Storage ──────────────────────────────────────────────────────────

/** localStorage key for the Bark connection (origin + device key). */
export const BARK_CONNECTION_KEY = 'pairlens:bark-connection'

/** Official Bark push host. Self-hosted installs replace this. */
export const DEFAULT_BARK_ORIGIN = 'https://api.day.app'

export const OFFICIAL_BARK_HOST = 'api.day.app'

/**
 * Grant key for a self-hosted Bark server. The colon keeps it out of the
 * plugin-id namespace, the same trick webhook grants use.
 */
const BARK_GRANT_KEY = 'core:notification-bark'

export type BarkEndpoint = {
  origin: string
  deviceKey: string
}

export type BarkConnection = {
  origin: string
  deviceKey: string
  connectedAt: number
}

// ── Errors ───────────────────────────────────────────────────────────

/**
 * A non-success Bark response. `message` is Bark's own English text and is
 * the most useful thing we can put in front of the user, so it survives to
 * the surface rather than being flattened into "delivery failed".
 */
export class BarkApiError extends Error {
  readonly code: number
  readonly description: string
  constructor(code: number, description: string) {
    super(`Bark API error ${code}: ${description}`)
    this.name = 'BarkApiError'
    this.code = code
    this.description = description
  }
}

/** The user has not connected Bark yet (or disconnected it elsewhere). */
export class BarkNotConnectedError extends Error {
  readonly code = 'bark-not-connected'
  constructor(message = 'Bark is not connected. Add a device key in Settings') {
    super(message)
    this.name = 'BarkNotConnectedError'
  }
}

// ── Parsing ──────────────────────────────────────────────────────────

/** A device key is 16–80 url-safe characters. Checked before it is spent. */
export function looksLikeDeviceKey(key: string): boolean {
  return /^[A-Za-z0-9_-]{16,80}$/.test(key.trim())
}

/**
 * Turn what the user pasted into an origin + device key.
 *
 * Bark shows `https://api.day.app/<key>/`. People also paste just the key,
 * a self-hosted origin, or a full push URL that already has a title on it.
 * The first path segment is the key; everything after it is ignored.
 */
export function parseBarkEndpoint(input: string): BarkEndpoint | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  if (looksLikeDeviceKey(trimmed)) {
    return { origin: DEFAULT_BARK_ORIGIN, deviceKey: trimmed }
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null

  const key = url.pathname.split('/').filter(Boolean)[0]
  if (!key || !looksLikeDeviceKey(key)) return null
  return { origin: url.origin, deviceKey: key }
}

// ── Message formatting ───────────────────────────────────────────────

/** Apple's practical body budget, with room for the rule footer. */
const MAX_BODY_LENGTH = 1600

const TIME_SENSITIVE = new Set(['warning', 'error'])

export type BarkPayload = {
  title: string
  body: string
  group: string
  level: 'active' | 'timeSensitive'
}

/**
 * Render a notification as a Bark JSON body.
 *
 * Title stays the alert headline. The body carries the detail plus a
 * footer naming the rule and the market so a phone that collects alerts
 * from several rules stays readable. Truncation trims the body — never
 * the title, which is what the lock screen shows.
 */
export function formatBarkPayload(message: NotificationMessage): BarkPayload {
  const context = [message.payload.pair, message.payload.market]
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    .join(' · ')
  const footerParts = [message.ruleName, context].filter(
    (v) => typeof v === 'string' && v.trim() !== '',
  )
  const footer = footerParts.length ? `\n\n${footerParts.join(' · ')}` : ''

  const room = MAX_BODY_LENGTH - footer.length
  let body = message.body ?? ''
  if (body.length > room) {
    body = body.slice(0, Math.max(0, room - 1)) + '…'
  }

  return {
    title: message.title,
    body: `${body}${footer}`,
    group: 'Pairlens',
    level: TIME_SENSITIVE.has(message.severity) ? 'timeSensitive' : 'active',
  }
}

// ── Connection record ────────────────────────────────────────────────

/**
 * Parsed snapshot, memoized on the raw string.
 *
 * `useSyncExternalStore` compares snapshots by identity, so a fresh
 * `JSON.parse` per call would re-render forever. Re-parsing only when the
 * stored text actually changed also makes the read cheap enough to do on
 * every delivery.
 */
let snapshotRaw: string | null = null
let snapshotValue: BarkConnection | null = null

export function loadBarkConnection(): BarkConnection | null {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(BARK_CONNECTION_KEY)
  } catch {
    return null
  }
  if (raw === snapshotRaw) return snapshotValue

  snapshotRaw = raw
  snapshotValue = null
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as BarkConnection
      if (
        typeof parsed.origin === 'string' &&
        parsed.origin.startsWith('http') &&
        typeof parsed.deviceKey === 'string' &&
        looksLikeDeviceKey(parsed.deviceKey)
      ) {
        snapshotValue = parsed
      }
    } catch {
      // Corrupted record — treated as not connected.
    }
  }
  return snapshotValue
}

// ── Change notification ──────────────────────────────────────────────

const listeners = new Set<() => void>()

/** Subscribe to connect/disconnect changes, in this window or another. */
export function subscribeBarkConnection(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1 && typeof window !== 'undefined') {
    window.addEventListener('storage', onStorage)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && typeof window !== 'undefined') {
      window.removeEventListener('storage', onStorage)
    }
  }
}

function onStorage(event: StorageEvent) {
  if (event.key !== null && event.key !== BARK_CONNECTION_KEY) return
  notifyConnectionChanged()
}

function notifyConnectionChanged(): void {
  for (const listener of listeners) listener()
}

function storeBarkConnection(connection: BarkConnection): void {
  try {
    localStorage.setItem(BARK_CONNECTION_KEY, JSON.stringify(connection))
  } catch {
    // Quota — the connection still works for this session; it just won't
    // survive a reload.
  }
  notifyConnectionChanged()
}

/** The live device key, or null when Bark is not connected. */
export function readBarkDeviceKey(): string | null {
  return loadBarkConnection()?.deviceKey ?? null
}

// ── Desktop host grant ───────────────────────────────────────────────

/**
 * Permit a self-hosted Bark origin on desktop CSP.
 *
 * Official `api.day.app` is already in the baseline. A user's own server is
 * not, and committing a webhook is how other custom hosts get in; connecting
 * Bark is the equivalent intent here. The widened policy applies after reload.
 */
export async function ensureBarkHostGranted(
  origin: string,
): Promise<'ok' | 'reload-needed'> {
  if (!isDesktopNetworkGoverned()) return 'ok'
  let host: string
  try {
    host = new URL(origin).hostname
  } catch {
    return 'ok'
  }
  if (host === OFFICIAL_BARK_HOST) return 'ok'
  const missing = await computeUngrantedHostList([host])
  if (missing.length === 0) return 'ok'
  await grantNetworkHosts(BARK_GRANT_KEY, [host])
  return 'reload-needed'
}

// ── Connect / disconnect ─────────────────────────────────────────────

/**
 * Parse, store the address, and record the server.
 *
 * The address is not verified against Bark here: the only check Bark offers
 * is a push, and that is what the test button is for.
 */
export async function connectBark(
  input: string,
): Promise<{ connection: BarkConnection; grant: 'ok' | 'reload-needed' }> {
  const endpoint = parseBarkEndpoint(input)
  if (!endpoint) {
    throw new Error('That is not a Bark URL')
  }

  const grant = await ensureBarkHostGranted(endpoint.origin)
  const connection: BarkConnection = {
    origin: endpoint.origin,
    deviceKey: endpoint.deviceKey,
    connectedAt: Date.now(),
  }
  storeBarkConnection(connection)
  return { connection, grant }
}

export function disconnectBark(): void {
  try {
    localStorage.removeItem(BARK_CONNECTION_KEY)
  } catch {
    // Nothing to remove.
  }
  notifyConnectionChanged()
}

// ── Delivery ─────────────────────────────────────────────────────────

type BarkResponse = {
  code?: number
  message?: string
}

/**
 * One Bark push.
 *
 * Times out on its own (a dispatch must never hang on a dead network) and
 * accepts an external signal so the settings UI can cancel. The two are
 * combined by hand rather than with `AbortSignal.any`, which WebKit only
 * learned in 17.4 — the desktop app runs on whatever WebKit the user's
 * macOS shipped with.
 */
export async function sendBarkPush(
  origin: string,
  deviceKey: string,
  payload: BarkPayload,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error('Bark request timed out')),
    opts.timeoutMs ?? 10_000,
  )
  const onExternalAbort = () => controller.abort(opts.signal?.reason)
  opts.signal?.addEventListener('abort', onExternalAbort, { once: true })
  if (opts.signal?.aborted) onExternalAbort()

  try {
    const res = await fetch(`${origin.replace(/\/$/, '')}/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        device_key: deviceKey,
        title: payload.title,
        body: payload.body,
        group: payload.group,
        level: payload.level,
      }),
      signal: controller.signal,
    })

    const body = (await res.json().catch(() => null)) as BarkResponse | null
    const code = body?.code ?? res.status
    if (code !== 200) {
      throw new BarkApiError(code, body?.message ?? `HTTP ${res.status}`)
    }
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onExternalAbort)
  }
}

/**
 * Deliver one notification. Throws so the dispatcher records the failure in
 * the notification log with a reason the user can act on.
 */
export async function deliverBarkNotification(
  _stepData: Record<string, unknown>,
  message: NotificationMessage,
): Promise<void> {
  const connection = loadBarkConnection()
  if (!connection) throw new BarkNotConnectedError()

  await sendBarkPush(
    connection.origin,
    connection.deviceKey,
    formatBarkPayload(message),
  )
}
