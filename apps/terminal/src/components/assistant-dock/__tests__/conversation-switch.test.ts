// Copyright (c) 2026 Juan Ignacio Molina Estrada
// SPDX-License-Identifier: FSL-1.1-Apache-2.0
/**
 * The terminal has no React test renderer, so these pin the wiring that
 * keeps a run alive when History changes. Undo any one of them and a
 * click on another row aborts the answer again, with no type error.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const SOURCE = readFileSync(
  join(import.meta.dir, '..', 'assistant-conversation.tsx'),
  'utf8',
)

describe('switching History does not abort a run', () => {
  test('each thread has its own Chat, handed to useChat rather than rebuilt by id', () => {
    // Passing `{ chat }` is what lets the previous Chat keep streaming:
    // the hook swaps the subscription and does not call stop(). Keying
    // useChat on `id` instead would construct a new Chat and orphan the
    // run the way the old switch effect had to stop() to avoid.
    expect(SOURCE).toMatch(/import \{ Chat, useChat \} from '@ai-sdk\/react'/)
    expect(SOURCE).toContain('sessions.get(conversationId)')
    expect(SOURCE).toMatch(/useChat\(\{[\s\S]*?chat,/)
  })

  test('the message list collapses duplicate ids before they become React keys', () => {
    // AI SDK message ids are 16-char generateId strings. A thread that
    // listed the same id twice (Chat push-then-replace, a doubled persist)
    // is exactly the "two children with the same key" warning.
    expect(SOURCE).toContain('uniqueMessages(messages)')
    expect(SOURCE).toMatch(/thread\.map\(\(message\) =>/)
    expect(SOURCE).toContain('key={message.id}')
  })

  test('a History click does not call stop or drop in-memory screenshots', () => {
    // The old switch effect stopped the stream, wrote the half-answer,
    // cleared chart captures, then moved threadId. Minimizing already
    // keeps the run; switching rows has to as well.
    expect(SOURCE).not.toContain('stopRef.current()')
    expect(SOURCE).not.toMatch(/clearScreenshots\(\)/)
  })
})
