// Copyright (c) 2026 Juan Ignacio Molina Estrada
// SPDX-License-Identifier: FSL-1.1-Apache-2.0
import { useSyncExternalStore } from 'react'

import type { BarkConnection } from '@/lib/notifications/bark'
import {
  loadBarkConnection,
  subscribeBarkConnection,
} from '@/lib/notifications/bark'

/**
 * The connected Bark server, live.
 *
 * Two surfaces read this — the settings card that owns the connection and the
 * Bark step on the notifications canvas — and they are routinely open at the
 * same time in different windows, so the store notifies across windows too.
 * The server snapshot is `null`: nothing is connected during SSR.
 */
export function useBarkConnection(): BarkConnection | null {
  return useSyncExternalStore(
    subscribeBarkConnection,
    loadBarkConnection,
    () => null,
  )
}
