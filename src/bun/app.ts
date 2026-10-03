import { discoverBackends, type MethodMap } from './backends'
import { cache } from './cache'
import type { Config } from './config'
import { createKoaDispatcher } from './koa-compat'
import {
    clientKey,
    compose,
    compress,
    cors,
    logger,
    rateLimit,
    security,
    type AddressServer,
    type Handler,
    type Middleware
} from './middleware'
import { session } from './session'
import { makeStaticHandler } from './static'
import { createStore } from './store'

/** Bun server handle returned by `openFlight`. */
export interface FlightServer extends AddressServer {
    port: number
    stop(closeActiveConnections?: boolean): void
}

/**
 * Wrap discovered routes so every method runs through the middleware onion.
 * OPTIONS is registered when CORS is on, otherwise Bun answers 405 before our middleware runs.
 */
function wrapRoutes(
    routes: Record<string, Handler | MethodMap>,
    run: (req: Request, core: Handler) => Promise<Response>,
    corsEnabled: boolean
): Record<string, Handler | MethodMap> {
    const wrapped: Record<string, Handler | MethodMap> = {}
    for (const [path, value] of Object.entries(routes)) {
        if (typeof value === 'function') {
            const handler = value
            wrapped[path] = (req: Request) => run(req, () => handler(req))
        } else {
            const methods: MethodMap = {}
            for (const [method, handler] of Object.entries(value)) {
                methods[method] = (req: Request) => run(req, () => handler(req))
            }
            if (corsEnabled && !methods.OPTIONS) {
                methods.OPTIONS = (req: Request) => run(req, () => new Response(null, { status: 204 }))
            }
            wrapped[path] = methods
        }
    }
    return wrapped
}

/**
 * Build the Fetch application: Bun routes, Koa compatibility, and the SPA fallback.
 */
export async function createApp(cfg: Config, server?: () => AddressServer | undefined) {
    const discovered = await discoverBackends(cfg.appHome, cfg.excludePaths)
    const middlewares: Middleware[] = []
    const enabled: string[] = []

    if (cfg.logging) {
        middlewares.push(logger())
        enabled.push('logging')
    }
    if (cfg.security.enabled) {
        middlewares.push(security(cfg.security))
        enabled.push('security')
    }
    if (cfg.cors.enabled) {
        middlewares.push(cors(cfg.cors))
        enabled.push('cors')
    }
    if (cfg.rateLimit.enabled) {
        middlewares.push(rateLimit(cfg.rateLimit, (req) => clientKey(req, cfg.rateLimit.trustProxy, server?.())))
        enabled.push(`rateLimit(${cfg.rateLimit.max}/${cfg.rateLimit.durationMs}ms)`)
    }
    if (cfg.compression.enabled) {
        middlewares.push(compress(cfg.compression))
        enabled.push('compression')
    }
    if (cfg.session.enabled) {
        middlewares.push(session(cfg.session, createStore(cfg.redisUrl, 'session')))
        enabled.push('session')
    }
    if (cfg.cache.enabled) {
        middlewares.push(cache(cfg.cache, createStore(cfg.redisUrl, 'cache')))
        enabled.push('cache')
    }

    const run = compose(middlewares)
    const routes = wrapRoutes(discovered.routes, run, cfg.cors.enabled)
    routes['/healthz'] = () => new Response('ok')

    const koa = discovered.koa.length > 0 ? await createKoaDispatcher(discovered.koa, cfg.payloadLimit) : null
    const serveStatic = makeStaticHandler(cfg.distPath, cfg.mode, cfg.spaDenyPrefixes)

    return {
        enabled,
        routes,
        fetch: async (req: Request) => {
            return run(req, async () => {
                const fromKoa = koa ? await koa(req) : null
                if (fromKoa) return fromKoa
                return (await serveStatic(req)) ?? new Response('Not Found', { status: 404 })
            })
        },
        error(err: unknown) {
            console.error('flight-bun error:', err)
            return new Response('Internal Server Error', { status: 500 })
        }
    }
}

/**
 * Listen with Bun. The peer address is visible to the rate limiter after the server exists.
 */
export async function openFlight(
    cfg: Config,
    listen: { port?: number; hostname?: string } = {}
): Promise<FlightServer> {
    let server: FlightServer | undefined
    const app = await createApp(cfg, () => server)
    server = Bun.serve({
        port: listen.port ?? cfg.port,
        hostname: listen.hostname ?? cfg.hostname,
        routes: app.routes as Record<string, Handler | MethodMap>,
        fetch: app.fetch,
        error: app.error
    }) as FlightServer

    const dist = cfg.mode === 'production' ? `, dist=${cfg.distPath}` : ''
    console.log(
        `flight-bun (${cfg.mode}) listening on :${server.port} — app_home=${cfg.appHome}${dist}\n` +
            `flight-bun: middleware [${app.enabled.join(', ') || 'none'}]` +
            (cfg.redisUrl ? `, redis=${cfg.redisUrl}` : ', redis=(in-memory)')
    )
    return server
}
