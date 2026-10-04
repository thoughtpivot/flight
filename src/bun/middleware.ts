import type { CompressionConfig, CorsConfig, RateLimitConfig, SecurityConfig } from './config'

/** Web-standard request handler used by discovered routes. */
export type Handler = (req: Request) => Response | Promise<Response>

/** Continues the onion to the next middleware or the core handler. */
export type Next = () => Promise<Response>

/** Koa-style middleware over the Fetch API. */
export type Middleware = (req: Request, next: Next) => Response | Promise<Response>

/** Minimal server surface used to read the peer address. */
export interface AddressServer {
    requestIP(req: Request): { address: string } | null
}

/**
 * Compose middleware so index 0 is outermost. A middleware may return without calling `next`.
 */
export function compose(middlewares: Middleware[]): (req: Request, core: Handler) => Promise<Response> {
    return function run(req: Request, core: Handler): Promise<Response> {
        const dispatch = (index: number): Promise<Response> => {
            const middleware = middlewares[index]
            if (!middleware) return Promise.resolve(core(req))
            return Promise.resolve(middleware(req, () => dispatch(index + 1)))
        }
        return dispatch(0)
    }
}

/**
 * Copy a response and set extra headers. Works for streaming bodies.
 */
export function withHeaders(response: Response, extra: Record<string, string>): Response {
    const headers = new Headers(response.headers)
    for (const [key, value] of Object.entries(extra)) headers.set(key, value)
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
    })
}

/**
 * Log method, path, status, and duration. Off in production unless `FLIGHT_LOGGING` is set.
 */
export function logger(): Middleware {
    return async (req, next) => {
        const start = performance.now()
        const response = await next()
        const ms = (performance.now() - start).toFixed(1)
        const { pathname } = new URL(req.url)
        console.log(`${req.method} ${pathname} ${response.status} ${ms}ms`)
        return response
    }
}

const SECURITY_HEADERS: Record<string, string> = {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'SAMEORIGIN',
    'x-dns-prefetch-control': 'off',
    'referrer-policy': 'no-referrer',
    'x-download-options': 'noopen',
    'x-permitted-cross-domain-policies': 'none',
    'cross-origin-opener-policy': 'same-origin',
    'origin-agent-cluster': '?1'
}

/**
 * Apply a helmet-style header set. CSP is omitted because a wrong policy breaks the SPA.
 */
export function security(cfg: SecurityConfig): Middleware {
    const headers = { ...SECURITY_HEADERS }
    if (cfg.hsts) headers['strict-transport-security'] = `max-age=${cfg.hstsMaxAge}; includeSubDomains`
    return async (_req, next) => withHeaders(await next(), headers)
}

/**
 * Build the CORS header set for this request.
 */
function corsHeaders(req: Request, cfg: CorsConfig): Record<string, string> {
    const requestOrigin = req.headers.get('origin')
    const allowOrigin = cfg.origin === '*' ? (cfg.credentials ? (requestOrigin ?? '*') : '*') : cfg.origin
    const headers: Record<string, string> = {
        'access-control-allow-origin': allowOrigin,
        'access-control-allow-methods': cfg.methods,
        'access-control-allow-headers': cfg.headers || req.headers.get('access-control-request-headers') || '*',
        'access-control-max-age': String(cfg.maxAge)
    }
    if (cfg.credentials) headers['access-control-allow-credentials'] = 'true'
    if (allowOrigin !== '*') headers.vary = 'Origin'
    return headers
}

/**
 * Answer CORS preflight and attach `Access-Control-*` headers to every other response.
 */
export function cors(cfg: CorsConfig): Middleware {
    return async (req, next) => {
        if (req.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders(req, cfg) })
        }
        return withHeaders(await next(), corsHeaders(req, cfg))
    }
}

/**
 * True when the content type is worth gzipping.
 */
function compressible(contentType: string): boolean {
    return /^(text\/|application\/(json|javascript|xml|.*\+json|.*\+xml)|image\/svg)/i.test(contentType)
}

/**
 * Append a Vary token if it is not already present.
 */
function appendVary(existing: string | null, value: string): string {
    if (!existing) return value
    const parts = existing.split(',').map((part) => part.trim().toLowerCase())
    return parts.includes(value.toLowerCase()) ? existing : `${existing}, ${value}`
}

/**
 * Gzip text and JSON bodies above the threshold when the client accepts gzip.
 */
export function compress(cfg: CompressionConfig): Middleware {
    return async (req, next) => {
        const response = await next()
        if (req.method === 'HEAD' || !response.body || response.status === 204 || response.status === 304) {
            return response
        }
        if (response.headers.get('content-encoding')) return response
        if (!(req.headers.get('accept-encoding') || '').includes('gzip')) return response
        if (!compressible(response.headers.get('content-type') || '')) return response

        const bytes = new Uint8Array(await response.arrayBuffer())
        if (bytes.byteLength < cfg.threshold) {
            return new Response(bytes, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers
            })
        }

        const gzipped = Bun.gzipSync(bytes)
        const headers = new Headers(response.headers)
        headers.set('content-encoding', 'gzip')
        headers.set('content-length', String(gzipped.byteLength))
        headers.set('vary', appendVary(headers.get('vary'), 'Accept-Encoding'))
        return new Response(gzipped, {
            status: response.status,
            statusText: response.statusText,
            headers
        })
    }
}

/**
 * Identity for the rate limiter.
 * Forwarded headers count only when `FLIGHT_TRUST_PROXY` is on, so a client cannot spoof past the limit.
 */
export function clientKey(req: Request, trustProxy: boolean, server?: AddressServer): string {
    if (trustProxy) {
        const forwarded = req.headers.get('x-forwarded-for')
        if (forwarded) return forwarded.split(',')[0].trim()
        const realIp = req.headers.get('x-real-ip')
        if (realIp) return realIp
    }
    return server?.requestIP(req)?.address || 'local'
}

/**
 * True when this GET or HEAD should not consume a rate-limit token.
 */
function shouldSkip(pathname: string, method: string, prefixes: string[]): boolean {
    if (method !== 'GET' && method !== 'HEAD') return false
    return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

/**
 * Fixed-window rate limit. Hashed static prefixes are skipped so assets do not burn the API budget.
 */
export function rateLimit(cfg: RateLimitConfig, addressOf: (req: Request) => string): Middleware {
    const windows = new Map<string, { count: number; resetAt: number }>()
    return async (req, next) => {
        const pathname = new URL(req.url).pathname
        if (shouldSkip(pathname, req.method, cfg.skipPrefixes)) return next()

        const now = Date.now()
        const key = addressOf(req)
        let window = windows.get(key)
        if (!window || window.resetAt <= now) {
            window = { count: 0, resetAt: now + cfg.durationMs }
            windows.set(key, window)
            if (windows.size > 10000) {
                for (const [storedKey, stored] of windows) {
                    if (stored.resetAt <= now) windows.delete(storedKey)
                }
            }
        }
        window.count++
        const remaining = Math.max(0, cfg.max - window.count)
        const resetSec = Math.ceil((window.resetAt - now) / 1000)
        const limitHeaders = {
            'x-ratelimit-limit': String(cfg.max),
            'x-ratelimit-remaining': String(remaining),
            'x-ratelimit-reset': String(resetSec)
        }
        if (window.count > cfg.max) {
            return new Response('Too Many Requests', {
                status: 429,
                headers: { ...limitHeaders, 'retry-after': String(resetSec) }
            })
        }
        return withHeaders(await next(), limitHeaders)
    }
}
