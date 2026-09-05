// Copyright (c) 2026 Juan Ignacio Molina Estrada
// SPDX-License-Identifier: FSL-1.1-Apache-2.0
/**
 * Bark delivery.
 *
 * The terminal talks to the Bark server directly from the client — the same
 * shape as Telegram. There is no Pairlens relay, which is what makes this
 * work in a standalone install and what keeps the device key off our servers.
 *
 * ## Where the key lives, and why not in the rule
 *
 * A Bark device key is enough to push to that phone. Notification rules are
 * localStorage records that ride the sync bus to the App Server under the
 * `automation` domain, so a key stored as step config would be a credential
 * uploaded to Pairlens — the one thing the credential design forbids. It goes
 * in the keychain slot below instead: the OS keychain on desktop, the vault
 * in the browser. The step carries nothing.
 *
 * The non-secret half of the connection (which server the key is registered
 * with) is a plain localStorage record. It is deliberately NOT emitted on the
 * sync channel — the coordinator drops unknown keys, so nothing has to
 * blocklist it — because a host that resolves against a key only this device
 * holds is meaningless on another device anyway.
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
import { deleteCredential, getCredential, saveCredential } from '@/lib/keychain'
import {
  computeUngrantedHostList,
  grantNetworkHosts,
  isDesktopNetworkGoverned,
} from '@/lib/plugins/network-grants'
import { assertCanAddCredential } from '@/lib/security/vault/vault-policy'

// ── Storage ──────────────────────────────────────────────────────────

/** Keychain slot holding the device key. Never synced, never in a rule. */
export const BARK_KEY_SLOT = 'integration:bark-device-key'

/** localStorage key for the non-secret half of the connection. */
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
  /** Origin only, never the key. */
  origin: string
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
        parsed.origin.startsWith('http')
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
  keyCache = null
  notifyConnectionChanged()
}

function notifyConnectionChanged(): void {
  for (const listener of listeners) listener()
}

function storeBarkConnection(connection: BarkConnection): void {
  try {
    localStorage.setItem(BARK_CONNECTION_KEY, JSON.stringify(connection))
  } catch {
    // Quota — the key is already saved, so the connection still works for
    // this session; it just won't survive a reload.
  }
  notifyConnectionChanged()
}

// ── Token access ─────────────────────────────────────────────────────

/**
 * Reading a credential can mean a keychain round trip or a vault decrypt, and
 * every delivered notification needs one. Cached after the first read and
 * dropped whenever the connection changes.
 */
let keyCache: string | null = null

/**
 * The live device key, or null when Bark is not connected.
 *
 * Gated on the connection record existing, which is what makes a disconnect
 * in another window take effect here. Vault errors propagate — a sealed vault
 * is "come back when you can open this", not "no device configured".
 */
export async function readBarkDeviceKey(): Promise<string | null> {
  if (!loadBarkConnection()) {
    keyCache = null
    return null
  }
  if (keyCache) return keyCache
  const stored = await getCredential(BARK_KEY_SLOT)
  keyCache = stored
  return stored
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
 * Parse, store the key, and record the server.
 *
 * The vault gate runs before anything is written so a browser user who has
 * not enrolled a protector gets the enrollment dialog instead of a key that
 * then failed to save. The key is not verified against Bark here: the only
 * check Bark offers is a push, and that is what the test button is for.
 */
export async function connectBark(
  input: string,
): Promise<{ connection: BarkConnection; grant: 'ok' | 'reload-needed' }> {
  const endpoint = parseBarkEndpoint(input)
  if (!endpoint) {
    throw new Error('That is not a Bark URL')
  }
  await assertCanAddCredential()

  const grant = await ensureBarkHostGranted(endpoint.origin)
  await saveCredential(BARK_KEY_SLOT, endpoint.deviceKey)
  keyCache = endpoint.deviceKey

  const connection: BarkConnection = {
    origin: endpoint.origin,
    connectedAt: Date.now(),
  }
  storeBarkConnection(connection)
  return { connection, grant }
}

export async function disconnectBark(): Promise<void> {
  keyCache = null
  try {
    localStorage.removeItem(BARK_CONNECTION_KEY)
  } catch {
    // Nothing to remove.
  }
  notifyConnectionChanged()
  await deleteCredential(BARK_KEY_SLOT)
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
  const deviceKey = await readBarkDeviceKey()
  if (!connection || !deviceKey) throw new BarkNotConnectedError()

  await sendBarkPush(connection.origin, deviceKey, formatBarkPayload(message))
}
