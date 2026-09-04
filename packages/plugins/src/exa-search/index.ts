// Copyright (c) 2026 Juan Ignacio Molina Estrada
// SPDX-License-Identifier: FSL-1.1-Apache-2.0
import { restFetch } from '@pairlens/market-engine/http'
import { isCorsConstrained } from '@pairlens/market-engine/platform'
import { fanOutWebSearch, readSearchRequest } from '../lib/web-search'
import type {
  PluginExecuteParams,
  PluginInstance,
  PluginManifest,
} from '@pairlens/plugin-system/types'
import type { WebSearchResult } from '@pairlens/shared/plugin-types'

// Exa Search — BYOK ai:web-search provider. api.exa.ai does NOT send CORS
// headers for a real browser origin (they closed that as WONTFIX: calling
// the API from a page would leak the key). Localhost is the one exception
// they still allow. Everywhere else this plugin has to go through the
// desktop Rust HTTP plugin (`restFetch`), the same path CORS-blocked
// venues use. The hosted web terminal therefore cannot run Exa; Tavily
// is the browser-capable search provider.

export const exaSearchManifest: PluginManifest = {
  id: 'exa-search',
  name: 'Exa Search',
  version: '0.1.0',
  author: 'Pairlens',
  description:
    'Neural web search grounding for AI research via the Exa API (bring your own key)',
  homepage: 'https://exa.ai',
  icon: '/posters/exa-search.png',
  metadata: { family: 'ai-byok' },
  capabilities: [
    {
      id: 'ai:web-search',
      singleton: false,
      markets: ['*'],
      priority: 10,
      streaming: false,
    },
  ],
  config: {
    apiKey: {
      type: 'secret',
      label: 'Exa API Key',
      required: true,
    },
  },
}

type ExaResult = {
  url?: string
  title?: string | null
  text?: string
  publishedDate?: string
}

/**
 * Why Exa cannot activate in a CORS-constrained browser. Parameterised so
 * `import.meta.env.DEV` (a build-time constant) is not the thing the test
 * has to fight.
 */
export function exaBrowserRefusal(corsConstrained: boolean): string | null {
  if (!corsConstrained) return null
  return 'Exa Search cannot run in the browser: api.exa.ai refuses cross-origin requests. Use the desktop app, or pick Tavily.'
}

/** Map a raw Exa /search response to the WebSearchResult wire contract. */
export function mapExaResults(data: unknown): Array<WebSearchResult> {
  const results = (data as { results?: Array<ExaResult> } | null)?.results
  if (!Array.isArray(results)) return []
  return results
    .filter((r) => typeof r.url === 'string' && r.url.length > 0)
    .map((r) => ({
      url: r.url!,
      title: r.title || r.url!,
      excerpt: r.text ?? '',
      publishDate: r.publishedDate ?? null,
    }))
}

export function createExaSearchPlugin(
  manifest: PluginManifest,
): PluginInstance {
  let config: Record<string, unknown> = {}

  async function searchOne(
    query: string,
    perQueryLimit: number,
  ): Promise<Array<WebSearchResult>> {
    const response = await restFetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': String(config['apiKey'] ?? ''),
      },
      body: JSON.stringify({
        query,
        numResults: perQueryLimit,
        type: 'auto',
        contents: { text: { maxCharacters: 1000 } },
      }),
    })
    if (!response.ok) {
      throw new Error(`Exa API error ${response.status}`)
    }
    return mapExaResults(await response.json())
  }

  async function execute(params: PluginExecuteParams): Promise<unknown> {
    if (params.capability !== 'ai:web-search') {
      throw new Error(
        `exa-search: unsupported capability '${params.capability}'`,
      )
    }
    const { queries, maxResults } = readSearchRequest(params.params)
    return fanOutWebSearch(queries, maxResults, searchOne)
  }

  async function initialize(cfg: Record<string, unknown>): Promise<void> {
    // Without a key every request fails: refuse to activate so a keyless
    // install never wins ai:web-search resolution.
    if (String(cfg['apiKey'] ?? '').trim() === '') {
      throw new Error('Exa API key required: add it in the plugin settings')
    }
    const refusal = exaBrowserRefusal(isCorsConstrained())
    if (refusal) throw new Error(refusal)
    config = cfg
  }

  return {
    manifest,
    status: 'installed',
    config,
    execute,
    initialize,
  }
}
