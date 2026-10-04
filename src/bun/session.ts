import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

import type { SessionConfig } from './config'
import type { Middleware } from './middleware'
import type { KVStore } from './store'

/** Request carrying the mutable session object. */
export interface SessionRequest extends Request {
    session?: Record<string, unknown>
}

/**
 * HMAC-sign a session id. The mac is base64url so it is cookie-safe.
 */
function sign(value: string, secret: string): string {
    const mac = createHmac('sha256', secret).update(value).digest('base64url')
    return `${value}.${mac}`
}

/**
 * Return the value when the HMAC matches. Reject tampered cookies.
 */
function unsign(signed: string, secret: string): string | null {
    const splitAt = signed.lastIndexOf('.')
    if (splitAt < 0) return null
    const value = signed.slice(0, splitAt)
    const mac = signed.slice(splitAt + 1)
    const expected = createHmac('sha256', secret).update(value).digest('base64url')
    const actualBytes = Buffer.from(mac)
    const expectedBytes = Buffer.from(expected)
    if (actualBytes.length !== expectedBytes.length) return null
    return timingSafeEqual(actualBytes, expectedBytes) ? value : null
}

/**
 * Parse a Cookie header into a name/value map.
 */
function parseCookies(header: string | null): Record<string, string> {
    const cookies: Record<string, string> = {}
    if (!header) return cookies
    for (const part of header.split(';')) {
        const eq = part.indexOf('=')
        if (eq < 0) continue
        const name = part.slice(0, eq).trim()
        const value = part.slice(eq + 1).trim()
        if (name) cookies[name] = decodeURIComponent(value)
    }
    return cookies
}

/**
 * Serialize one Set-Cookie attribute string.
 */
function serializeCookie(name: string, value: string, maxAgeSec: number): string {
    return [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`].join(
        '; '
    )
}

/**
 * Append a Set-Cookie header without dropping ones already on the response.
 */
function appendSetCookie(response: Response, cookie: string): Response {
    const headers = new Headers(response.headers)
    headers.append('set-cookie', cookie)
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
    })
}

/**
 * Signed-cookie sessions backed by the KV store.
 * The cookie is issued only after the session holds data, so anonymous requests stay cookie-free.
 * There is no default secret: sessions stay off until `FLIGHT_SESSION_SECRET` is set.
 */
export function session(cfg: SessionConfig, store: KVStore): Middleware {
    return async (req, next) => {
        const cookies = parseCookies(req.headers.get('cookie'))
        const raw = cookies[cfg.cookie]
        const sessionRequest = req as SessionRequest

        let sid: string | null = null
        let data: Record<string, unknown> = {}
        if (raw) {
            const verified = unsign(raw, cfg.secret)
            if (verified) {
                sid = verified
                const stored = await store.get(`sess:${sid}`)
                if (stored) {
                    try {
                        data = JSON.parse(stored) as Record<string, unknown>
                    } catch {
                        data = {}
                    }
                }
            }
        }

        const before = JSON.stringify(data)
        sessionRequest.session = data
        const response = await next()
        const after = JSON.stringify(sessionRequest.session ?? {})
        const isEmpty = after === '{}'

        if (sid && isEmpty && before !== '{}') {
            await store.del(`sess:${sid}`)
            return appendSetCookie(response, serializeCookie(cfg.cookie, '', 0))
        }
        if (isEmpty) return response

        if (!sid) sid = randomUUID()
        await store.set(`sess:${sid}`, after, cfg.ttlSec)
        if (!raw || unsign(raw, cfg.secret) !== sid) {
            return appendSetCookie(response, serializeCookie(cfg.cookie, sign(sid, cfg.secret), cfg.ttlSec))
        }
        return response
    }
}
