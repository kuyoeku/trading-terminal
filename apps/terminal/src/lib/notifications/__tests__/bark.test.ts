// Copyright (c) 2026 Juan Ignacio Molina Estrada
// SPDX-License-Identifier: FSL-1.1-Apache-2.0
import { describe, expect, test } from 'bun:test'

import { CORE_NOTIFICATION_STEPS } from '@pairlens/notification-engine/core-steps'
import {
  DEFAULT_BARK_ORIGIN,
  formatBarkPayload,
  looksLikeDeviceKey,
  parseBarkEndpoint,
} from '../bark'
import type { NotificationMessage } from '@pairlens/notification-engine/types'

/**
 * The parts of Bark delivery that are pure enough to pin down.
 *
 * Users paste the URL Bark shows them, a bare device key, or a full push
 * URL with a title already on it. Getting the key out of the wrong slice
 * of that path is how a "connected" device silently never rings.
 */

function message(over: Partial<NotificationMessage> = {}): NotificationMessage {
  return {
    ruleId: 'rule-1',
    ruleName: 'Breakout watch',
    title: 'Price Alert: BTC-USDT',
    body: 'BTC-USDT is now above 64000',
    severity: 'info',
    timestamp: 0,
    payload: {
      eventType: 'price-alert',
      timestamp: 0,
      pair: 'BTC-USDT',
      market: 'okx',
      data: {},
    },
    ...over,
  }
}

describe('looksLikeDeviceKey', () => {
  test('accepts a typical Bark key', () => {
    expect(looksLikeDeviceKey('ynJ5Ft4atkMkWeo2PAvFhF')).toBe(true)
  })

  test('rejects the things people paste by mistake', () => {
    expect(looksLikeDeviceKey('')).toBe(false)
    expect(looksLikeDeviceKey('short')).toBe(false)
    expect(looksLikeDeviceKey('https://api.day.app/abc')).toBe(false)
    expect(looksLikeDeviceKey('not a key with spaces!!!')).toBe(false)
  })
})

describe('parseBarkEndpoint', () => {
  test('treats a bare key as the official server', () => {
    expect(parseBarkEndpoint('ynJ5Ft4atkMkWeo2PAvFhF')).toEqual({
      origin: DEFAULT_BARK_ORIGIN,
      deviceKey: 'ynJ5Ft4atkMkWeo2PAvFhF',
    })
  })

  test('reads the key off the URL Bark shows in the app', () => {
    expect(
      parseBarkEndpoint('https://api.day.app/ynJ5Ft4atkMkWeo2PAvFhF/'),
    ).toEqual({
      origin: DEFAULT_BARK_ORIGIN,
      deviceKey: 'ynJ5Ft4atkMkWeo2PAvFhF',
    })
  })

  test('keeps a self-hosted origin', () => {
    expect(
      parseBarkEndpoint('https://bark.example.com/ynJ5Ft4atkMkWeo2PAvFhF'),
    ).toEqual({
      origin: 'https://bark.example.com',
      deviceKey: 'ynJ5Ft4atkMkWeo2PAvFhF',
    })
  })

  test('takes only the first path segment from a full push URL', () => {
    expect(
      parseBarkEndpoint(
        'https://api.day.app/ynJ5Ft4atkMkWeo2PAvFhF/Price/the%20body',
      ),
    ).toEqual({
      origin: DEFAULT_BARK_ORIGIN,
      deviceKey: 'ynJ5Ft4atkMkWeo2PAvFhF',
    })
  })

  test('rejects an origin with no key', () => {
    expect(parseBarkEndpoint('https://api.day.app/')).toBeNull()
    expect(parseBarkEndpoint('https://api.day.app')).toBeNull()
    expect(parseBarkEndpoint('')).toBeNull()
  })
})

describe('formatBarkPayload', () => {
  test('keeps the title and appends rule plus market context', () => {
    const payload = formatBarkPayload(message())
    expect(payload.title).toBe('Price Alert: BTC-USDT')
    expect(payload.body).toContain('BTC-USDT is now above 64000')
    expect(payload.body).toContain('Breakout watch')
    expect(payload.body).toContain('BTC-USDT · okx')
    expect(payload.group).toBe('Pairlens')
  })

  test('marks warning and error as time-sensitive', () => {
    expect(formatBarkPayload(message({ severity: 'warning' })).level).toBe(
      'timeSensitive',
    )
    expect(formatBarkPayload(message({ severity: 'error' })).level).toBe(
      'timeSensitive',
    )
    expect(formatBarkPayload(message({ severity: 'info' })).level).toBe(
      'active',
    )
  })

  test('truncates a long body without dropping the title', () => {
    const payload = formatBarkPayload(message({ body: 'x'.repeat(4000) }))
    expect(payload.title).toBe('Price Alert: BTC-USDT')
    expect(payload.body.length).toBeLessThanOrEqual(1600)
    expect(payload.body).toContain('…')
  })
})

describe('bark step definition', () => {
  const step = CORE_NOTIFICATION_STEPS.find((s) => s.type === 'bark')

  test('is a channel step', () => {
    expect(step?.category).toBe('channel')
    expect(step?.handles.outputs).toHaveLength(0)
  })

  test('carries no credential field', () => {
    // A device key here would be a secret persisted into rules, which sync
    // to the App Server. It belongs in the keychain and nowhere else.
    const keys = step?.configSchema.map((f) => f.key) ?? []
    expect(keys).toEqual([])
  })
})
