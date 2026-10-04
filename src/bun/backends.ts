import { relative, sep } from 'node:path'

import type { Handler } from './middleware'

/** Method name to handler, as exported by a Bun-native `*.backend.ts` file. */
export type MethodMap = Record<string, Handler>

/** Path to a handler or a method map. This is the Bun-native backend contract. */
export type RouteFragment = Record<string, Handler | MethodMap>

/** Koa middleware: `(ctx, next) => Promise`. Existing Flight backends export this from `router.routes()`. */
export type KoaMiddleware = (ctx: unknown, next: () => Promise<unknown>) => unknown

/** Everything discovery found under an app root. */
export interface DiscoveredBackends {
    routes: Record<string, Handler | MethodMap>
    koa: KoaMiddleware[]
}

/**
 * True when every key is a URL path. That is the Bun route-fragment shape.
 */
function isRouteFragment(value: object): boolean {
    const keys = Object.keys(value)
    return keys.length > 0 && keys.every((key) => key.startsWith('/'))
}

/**
 * Discover `*.backend.ts` and `*.backend.js` under `appHome`.
 * An object whose keys are paths is the Bun contract. A function, or an object with `.routes()`,
 * is the existing Koa contract and is kept so current apps can boot on Bun without a rewrite.
 */
export async function discoverBackends(appHome: string, excludePaths: string[]): Promise<DiscoveredBackends> {
    const routes: Record<string, Handler | MethodMap> = {}
    const koa: KoaMiddleware[] = []
    const excluded = new Set(excludePaths)

    for (const pattern of ['**/*.backend.ts', '**/*.backend.js']) {
        const glob = new Bun.Glob(pattern)
        for await (const abs of glob.scan({ cwd: appHome, absolute: true, onlyFiles: true })) {
            const rel = relative(appHome, abs)
            if (excluded.has(rel.split(sep)[0])) continue

            let mod: { default?: unknown }
            try {
                mod = await import(abs)
            } catch (err) {
                console.error(`flight-bun: failed to load ${rel}:`, err)
                continue
            }

            const exported = mod.default
            if (!exported) {
                console.warn(`flight-bun: ${rel} has no default export — skipping`)
                continue
            }

            if (typeof exported === 'function') {
                koa.push(exported as KoaMiddleware)
                console.log(`flight-bun: mounted Koa backend ${rel}`)
                continue
            }

            if (typeof exported === 'object') {
                const record = exported as Record<string, unknown>
                if (typeof record.routes === 'function' && !isRouteFragment(record)) {
                    koa.push(record.routes() as KoaMiddleware)
                    console.log(`flight-bun: mounted Koa router ${rel}`)
                    continue
                }
                if (isRouteFragment(record)) {
                    for (const [path, methods] of Object.entries(record)) {
                        if (typeof methods === 'function') {
                            routes[path] = methods as Handler
                        } else if (methods && typeof methods === 'object') {
                            const existing = routes[path]
                            routes[path] = {
                                ...(typeof existing === 'object' ? existing : {}),
                                ...(methods as MethodMap)
                            }
                        }
                    }
                    console.log(`flight-bun: mounted backend ${rel}`)
                    continue
                }
            }

            console.warn(`flight-bun: ${rel} default export is not a route fragment or Koa middleware — skipping`)
        }
    }

    return { routes, koa }
}
