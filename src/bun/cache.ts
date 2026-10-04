import type { CacheConfig } from './config'
import { withHeaders, type Middleware } from './middleware'
import type { KVStore } from './store'

/** Stored GET response. Only text and JSON bodies are kept. */
interface CachedEntry {
    status: number
    headers: [string, string][]
    body: string
}

/**
 * Cache GET responses that opt in with `Cache-Control: max-age`.
 * Hits and misses are marked with `X-Flight-Cache`.
 */
export function cache(cfg: CacheConfig, store: KVStore): Middleware {
    return async (req, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next()

        const url = new URL(req.url)
        const key = `cash:${url.pathname}${url.search}`
        const hit = await store.get(key)
        if (hit) {
            try {
                const entry = JSON.parse(hit) as CachedEntry
                const headers = new Headers(entry.headers)
                headers.set('x-flight-cache', 'HIT')
                return new Response(req.method === 'HEAD' ? null : entry.body, {
                    status: entry.status,
                    headers
                })
            } catch {
                // A corrupt entry is regenerated below.
            }
        }

        const response = await next()
        const cacheControl = response.headers.get('cache-control') || ''
        const match = /max-age=(\d+)/.exec(cacheControl)
        if (response.status === 200 && match && req.method === 'GET') {
            const ttl = Math.min(Number(match[1]), cfg.maxTtl)
            const contentType = response.headers.get('content-type') || ''
            if (ttl > 0 && /^(text\/|application\/(json|javascript)|application\/.*\+json)/i.test(contentType)) {
                const body = await response.clone().text()
                const entry: CachedEntry = {
                    status: 200,
                    headers: [...response.headers.entries()],
                    body
                }
                await store.set(key, JSON.stringify(entry), ttl)
            }
        }

        return withHeaders(response, { 'x-flight-cache': 'MISS' })
    }
}
