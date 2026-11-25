import fs from 'fs'
import path from 'path'

import type { Context, Middleware, Next } from 'koa'
import type { Redis } from 'ioredis'
import ratelimit from 'koa-ratelimit'

/** Option B: production + built assets (disable_vite), unless explicitly opted out. */
export function productionSpaPipelineActive(
    mode: string,
    disableVite: boolean,
    env: NodeJS.ProcessEnv = process.env
): boolean {
    if (mode !== 'production') return false
    if (!disableVite) return false
    const d = env.FLIGHT_DISABLE_SPA_PIPELINE
    if (d === '1' || d === 'true' || d === 'yes') return false
    return true
}

export function applyTrustProxy(app: { proxy: boolean }, env: NodeJS.ProcessEnv = process.env): void {
    const t = env.FLIGHT_TRUST_PROXY
    app.proxy = t === '1' || t === 'true' || t === 'yes'
}

/** Use `fallback` only when `value` is missing. Add a leading `/` to entries that lack one. */
export function parseCommaPrefixes(value: string | undefined, fallback: string): string[] {
    const raw = (value ?? fallback).trim()
    if (!raw) return []
    return raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((p) => (p.startsWith('/') ? p : `/${p}`))
}

export function resolveDistRoot(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
    const configured = env.FLIGHT_DIST_PATH?.trim()
    return path.resolve(cwd, configured || '../dist')
}

/** SPA shell path inside the dist root. `..` segments and blank values fall back to `index.html`. */
export function spaIndexRelative(env: NodeJS.ProcessEnv = process.env): string {
    const configured = env.FLIGHT_SPA_INDEX?.trim().replace(/^\/+/, '')
    if (!configured) return 'index.html'
    const normalized = configured.replace(/\\/g, '/')
    if (normalized.split('/').includes('..')) return 'index.html'
    return normalized
}

const DEFAULT_DENY_PREFIXES = ['/api', '/health']

/** Match connect-history-api-fallback default: do not rewrite paths whose last segment looks like a file name. */
function lastPathSegmentLooksLikeFile(urlPath: string): boolean {
    const base = urlPath.slice(urlPath.lastIndexOf('/') + 1)
    return base.includes('.')
}

/**
 * After koa-static: serve index.html for document navigations that are not API, health, or static-like paths.
 */
function indexInsideDist(distRoot: string, indexRel: string): string | undefined {
    const indexAbs = path.resolve(distRoot, indexRel)
    const rel = path.relative(distRoot, indexAbs)
    const relPosix = rel.replace(/\\/g, '/')
    if (!relPosix || relPosix === '..' || relPosix.startsWith('../') || path.isAbsolute(rel)) return undefined
    return indexAbs
}

export function spaIndexHtmlFallback(distRoot: string, indexRel: string, extraDenyPrefixes: string[] = []): Middleware {
    const indexAbs = indexInsideDist(distRoot, indexRel)
    const deny = dedupePathList([...DEFAULT_DENY_PREFIXES, ...extraDenyPrefixes])

    return async (ctx: Context, next: Next) => {
        if (ctx.method !== 'GET' && ctx.method !== 'HEAD') return next()
        if (ctx.body != null) return next()

        const accept = ctx.get('accept') || ''
        if (accept && !accept.includes('text/html') && !accept.includes('*/*')) return next()

        const urlPath = ctx.path.split('?')[0]
        if (lastPathSegmentLooksLikeFile(urlPath)) return next()

        for (const pre of deny) {
            if (urlPath === pre || (pre !== '/' && urlPath.startsWith(`${pre}/`))) {
                return next()
            }
        }

        if (!indexAbs) return next()

        try {
            await fs.promises.access(indexAbs, fs.constants.R_OK)
        } catch {
            return next()
        }

        ctx.type = 'text/html; charset=utf-8'
        ctx.body = fs.createReadStream(indexAbs)
    }
}

function dedupePathList(paths: string[]): string[] {
    return [...new Set(paths)]
}

export function shouldSkipRateLimitForPath(path: string, method: string, prefixes: string[]): boolean {
    if (method !== 'GET' && method !== 'HEAD') return false
    return prefixes.some((pre) => path === pre || path.startsWith(`${pre}/`))
}

/** True when `path` is `prefix` or a child of it. */
function underPrefix(path: string, prefix: string): boolean {
    if (prefix === '/') return true
    return path === prefix || path.startsWith(`${prefix}/`)
}

/**
 * Whether the limiter applies to this request.
 * With no `includePrefixes` (the default) every route is limited. When include prefixes are set,
 * only paths under them are limited. `skipPrefixes` then removes GET/HEAD requests, such as hashed assets.
 */
export function shouldRateLimitPath(
    path: string,
    method: string,
    skipPrefixes: string[],
    includePrefixes: string[] = []
): boolean {
    if (includePrefixes.length > 0 && !includePrefixes.some((pre) => underPrefix(path, pre))) return false
    return !shouldSkipRateLimitForPath(path, method, skipPrefixes)
}

/** Optional scope and tuning for `ratelimitWithPrefixSkips`. Defaults match Flight's production limiter. */
export interface RateLimitOptions {
    /** Limit only paths under these prefixes. Empty (the default) limits every route. */
    includePrefixes?: string[]
    /** Requests allowed per window. Default 1200. */
    max?: number
    /** Window in milliseconds. Default 60000. */
    duration?: number
}

/**
 * Flight's production limiter, scoped by path.
 * Every route is limited unless `includePrefixes` narrows it, and GET/HEAD under `skipPrefixes` are never counted.
 * Pass a `Map` instead of Redis for an in-memory store (used by tests).
 */
export function ratelimitWithPrefixSkips(
    db: Redis | Map<string, unknown>,
    skipPrefixes: string[],
    options: RateLimitOptions = {}
): Middleware {
    const includePrefixes = options.includePrefixes ?? []
    const inner = ratelimit({
        driver: db instanceof Map ? 'memory' : 'redis',
        db: db as never,
        duration: options.duration ?? 60000,
        errorMessage: 'Sometimes You Just Have to Slow Down.',
        id: (ctx) => ctx.get('x-forwarded-for') || ctx.ip,
        headers: {
            remaining: 'Rate-Limit-Remaining',
            reset: 'Rate-Limit-Reset',
            total: 'Rate-Limit-Total'
        },
        max: options.max ?? 1200,
        disableHeader: false
    })

    return async (ctx: Context, next: Next) => {
        if (!shouldRateLimitPath(ctx.path, ctx.method, skipPrefixes, includePrefixes)) {
            return next()
        }
        await inner(ctx, next)
    }
}

/**
 * Mount the router. A limiter is mounted first so it runs for every request, including matched routes.
 * A router that answers without calling `next()` would otherwise hide the request from a later limiter.
 */
export function mountRouter(
    app: { use(middleware: Middleware): unknown },
    router: { routes(): Middleware; allowedMethods(): Middleware },
    limiter?: Middleware | null
): void {
    if (limiter) app.use(limiter)
    app.use(router.routes())
    app.use(router.allowedMethods())
}

export function httpCacheEnabledInSpaPipeline(env: NodeJS.ProcessEnv = process.env): boolean {
    const v = env.FLIGHT_HTTP_CACHE
    return v === '1' || v === 'true' || v === 'yes'
}
