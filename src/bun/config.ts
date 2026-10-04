import { join, resolve } from 'node:path'

/** CORS settings for the Bun runtime. */
export interface CorsConfig {
    enabled: boolean
    origin: string
    methods: string
    headers: string
    credentials: boolean
    maxAge: number
}

/** Security-header settings. Content-Security-Policy stays app-specific. */
export interface SecurityConfig {
    enabled: boolean
    hsts: boolean
    hstsMaxAge: number
}

/** Gzip settings. Bodies smaller than `threshold` are left unchanged. */
export interface CompressionConfig {
    enabled: boolean
    threshold: number
}

/** Fixed-window rate limit. Off unless `max` is greater than zero. */
export interface RateLimitConfig {
    enabled: boolean
    max: number
    durationMs: number
    trustProxy: boolean
    skipPrefixes: string[]
}

/** Signed-cookie sessions. Disabled until a secret is set. */
export interface SessionConfig {
    enabled: boolean
    secret: string
    cookie: string
    ttlSec: number
}

/** Opt-in response cache. Handlers opt in with `Cache-Control: max-age`. */
export interface CacheConfig {
    enabled: boolean
    maxTtl: number
}

/** Resolved Flight Bun configuration. */
export interface Config {
    mode: string
    port: number
    hostname: string
    appHome: string
    distPath: string
    excludePaths: string[]
    spaDenyPrefixes: string[]
    payloadLimit: string
    logging: boolean
    redisUrl?: string
    cors: CorsConfig
    security: SecurityConfig
    compression: CompressionConfig
    rateLimit: RateLimitConfig
    session: SessionConfig
    cache: CacheConfig
}

type Env = Record<string, string | undefined>

/**
 * Parse a boolean environment flag. Empty or missing values use the default.
 */
function bool(value: string | undefined, fallback: boolean): boolean {
    if (value === undefined || value === '') return fallback
    return value === '1' || value === 'true' || value === 'yes'
}

/**
 * Parse a finite number. Empty or invalid values use the default.
 */
function num(value: string | undefined, fallback: number): number {
    if (value === undefined || value === '') return fallback
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * Split a comma-separated prefix list and ensure each entry starts with `/`.
 */
function prefixes(value: string | undefined, fallback: string): string[] {
    const raw = (value ?? fallback).trim()
    if (!raw) return []
    return raw
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => (part.startsWith('/') ? part : `/${part}`))
}

/**
 * Build a config object from an environment map.
 * Defaults keep sessions, caching, and rate limiting off so a load test is not throttled by surprise.
 */
export function loadConfig(env: Env = process.env): Config {
    const mode = env.FLIGHT_MODE || 'production'
    const appHome = resolve(env.FLIGHT_APP_HOME || '.')
    const sessionSecret = env.FLIGHT_SESSION_SECRET || ''
    const rateMax = num(env.FLIGHT_RATE_LIMIT_MAX, 0)

    return {
        mode,
        port: num(env.FLIGHT_PORT, 3000),
        hostname: env.FLIGHT_HOSTNAME || '0.0.0.0',
        appHome,
        distPath: env.FLIGHT_DIST_PATH ? resolve(env.FLIGHT_DIST_PATH) : join(appHome, 'dist'),
        excludePaths: (env.FLIGHT_EXCLUDE_PATHS || 'node_modules,dist')
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean),
        spaDenyPrefixes: prefixes(env.FLIGHT_SPA_DENY_PREFIXES, '/api,/health,/healthz'),
        payloadLimit: env.FLIGHT_PAYLOAD_LIMIT || '1mb',
        logging: bool(env.FLIGHT_LOGGING, mode === 'development'),
        redisUrl: env.FLIGHT_REDIS_URL || undefined,
        cors: {
            enabled: bool(env.FLIGHT_CORS_ENABLED, true),
            origin: env.FLIGHT_CORS_ORIGIN || '*',
            methods: env.FLIGHT_CORS_METHODS || 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
            headers: env.FLIGHT_CORS_HEADERS || '',
            credentials: bool(env.FLIGHT_CORS_CREDENTIALS, false),
            maxAge: num(env.FLIGHT_CORS_MAX_AGE, 86400)
        },
        security: {
            enabled: bool(env.FLIGHT_SECURITY_ENABLED, true),
            hsts: bool(env.FLIGHT_HSTS, false),
            hstsMaxAge: num(env.FLIGHT_HSTS_MAX_AGE, 15552000)
        },
        compression: {
            enabled: bool(env.FLIGHT_COMPRESS_ENABLED, true),
            threshold: num(env.FLIGHT_COMPRESS_THRESHOLD, 1024)
        },
        rateLimit: {
            enabled: !bool(env.FLIGHT_RATE_LIMIT_DISABLE, false) && rateMax > 0,
            max: rateMax,
            durationMs: num(env.FLIGHT_RATE_LIMIT_DURATION_MS, 60000),
            trustProxy: bool(env.FLIGHT_TRUST_PROXY, false),
            skipPrefixes: [
                ...prefixes(env.FLIGHT_STATIC_PREFIXES, '/assets,/fonts'),
                ...prefixes(env.FLIGHT_RATE_LIMIT_EXCLUDE_PREFIXES, '')
            ]
        },
        session: {
            enabled: sessionSecret.length > 0,
            secret: sessionSecret,
            cookie: env.FLIGHT_SESSION_COOKIE || 'flight.sid',
            ttlSec: num(env.FLIGHT_SESSION_TTL, 86400)
        },
        cache: {
            enabled: bool(env.FLIGHT_CACHE_ENABLED, false),
            maxTtl: num(env.FLIGHT_CACHE_MAX_TTL, 3600)
        }
    }
}
