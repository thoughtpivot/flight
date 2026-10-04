import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openFlight, type FlightServer } from './app'
import { loadConfig, type Config } from './config'
import { safeTarget } from './static'

const servers: FlightServer[] = []
const dirs: string[] = []

/**
 * Remove temp apps and stop servers started by this file.
 */
afterEach(async () => {
    while (servers.length) servers.pop()?.stop(true)
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/**
 * Create an app root with a Koa backend, a Bun route fragment, a compiled `.backend.js`, and a tiny SPA.
 */
async function makeApp(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'flight-bun-'))
    dirs.push(dir)
    await symlink(join(import.meta.dir, '../../node_modules'), join(dir, 'node_modules'), 'dir')
    await mkdir(join(dir, 'dist/assets'), { recursive: true })
    await writeFile(join(dir, 'dist/index.html'), '<!doctype html><title>flight-spa</title>', 'utf8')
    await writeFile(join(dir, 'dist/assets/app.js'), 'export const x = "asset"', 'utf8')
    await writeFile(
        join(dir, 'hello.backend.ts'),
        `import Router from '@koa/router'
const router = new Router()
router.get('/hello', async (ctx) => {
    ctx.body = { message: 'Hello from Flight!' }
})
router.post('/api/koa-echo', async (ctx) => {
    ctx.body = { received: ctx.request.body }
})
export default router.routes()
`
    )
    await writeFile(
        join(dir, 'ping.backend.ts'),
        `export default {
    '/api/ping': { GET: () => Response.json({ ok: true }) },
    '/api/login': {
        POST: (req) => {
            req.session.user = 'ada'
            return Response.json({ ok: true })
        }
    },
    '/api/me': { GET: (req) => Response.json({ user: req.session?.user ?? null }) },
    '/api/cached': {
        GET: () =>
            new Response(JSON.stringify({ n: 1 }), {
                headers: { 'content-type': 'application/json', 'cache-control': 'max-age=30' }
            })
    }
}
`
    )
    await writeFile(
        join(dir, 'compiled.backend.js'),
        `export default { '/api/from-js': { GET: () => Response.json({ from: 'js' }) } }
`
    )
    return dir
}

/**
 * Boot the Bun runtime against a throwaway app. Middleware that tests do not care about stays off.
 */
async function boot(env: Record<string, string>): Promise<{ server: FlightServer; url: string }> {
    const appHome = env.FLIGHT_APP_HOME || (await makeApp())
    const cfg: Config = loadConfig({
        FLIGHT_MODE: 'production',
        FLIGHT_LOGGING: 'false',
        FLIGHT_CORS_ENABLED: 'false',
        FLIGHT_SECURITY_ENABLED: 'false',
        FLIGHT_COMPRESS_ENABLED: 'false',
        FLIGHT_APP_HOME: appHome,
        FLIGHT_DIST_PATH: join(appHome, 'dist'),
        ...env,
        FLIGHT_APP_HOME: env.FLIGHT_APP_HOME || appHome
    })
    const server = await openFlight(cfg, { port: 0, hostname: '127.0.0.1' })
    servers.push(server)
    return { server, url: `http://127.0.0.1:${server.port}` }
}

test('healthz, Bun routes, compiled backends, and Koa routes answer on one server', async () => {
    const { url } = await boot({})

    const health = await fetch(`${url}/healthz`)
    expect(await health.text()).toBe('ok')

    const ping = await fetch(`${url}/api/ping`, { headers: { accept: 'application/json' } })
    expect(ping.status).toBe(200)
    expect(await ping.json()).toEqual({ ok: true })

    const fromJs = await fetch(`${url}/api/from-js`)
    expect(await fromJs.json()).toEqual({ from: 'js' })

    const hello = await fetch(`${url}/hello`)
    expect(hello.status).toBe(200)
    expect(await hello.json()).toEqual({ message: 'Hello from Flight!' })

    const echo = await fetch(`${url}/api/koa-echo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'ada' })
    })
    expect(echo.status).toBe(200)
    expect(await echo.json()).toEqual({ received: { name: 'ada' } })
})

test('production SPA serves hashed assets and falls back to index.html', async () => {
    const { url } = await boot({})

    const asset = await fetch(`${url}/assets/app.js`)
    expect(asset.status).toBe(200)
    expect(await asset.text()).toContain('export const x')

    const deep = await fetch(`${url}/dashboard/deep`, { headers: { accept: 'text/html' } })
    expect(deep.status).toBe(200)
    expect(deep.headers.get('content-type')).toContain('text/html')
    expect(await deep.text()).toContain('flight-spa')

    const apiMiss = await fetch(`${url}/api/missing`, { headers: { accept: 'text/html' } })
    expect(apiMiss.status).toBe(404)
    expect(await apiMiss.text()).not.toContain('flight-spa')

    const escaped = await fetch(`${url}/%2e%2e/secret.txt`)
    expect(escaped.status).toBe(404)
    expect(await escaped.text()).not.toContain('flight-spa')
    expect(safeTarget('/tmp/dist', '/../secret.txt')).toBeNull()
    expect(safeTarget('/tmp/dist', '/assets/app.js')).toBe('/tmp/dist/assets/app.js')
})

test('rate limit uses the peer address unless the proxy is trusted', async () => {
    const shared = {
        FLIGHT_RATE_LIMIT_MAX: '1',
        FLIGHT_RATE_LIMIT_DURATION_MS: '60000'
    }
    const locked = await boot(shared)
    const first = await fetch(`${locked.url}/api/ping`, { headers: { 'x-forwarded-for': '203.0.113.5' } })
    const spoofed = await fetch(`${locked.url}/api/ping`, { headers: { 'x-forwarded-for': '203.0.113.9' } })
    expect(first.status).toBe(200)
    expect(spoofed.status).toBe(429)

    const trusted = await boot({ ...shared, FLIGHT_TRUST_PROXY: '1' })
    const fromA = await fetch(`${trusted.url}/api/ping`, { headers: { 'x-forwarded-for': '203.0.113.5' } })
    const fromB = await fetch(`${trusted.url}/api/ping`, { headers: { 'x-forwarded-for': '203.0.113.9' } })
    expect(fromA.status).toBe(200)
    expect(fromB.status).toBe(200)
})

test('static assets do not consume the API rate limit', async () => {
    const { url } = await boot({ FLIGHT_RATE_LIMIT_MAX: '1' })
    expect((await fetch(`${url}/assets/app.js`)).status).toBe(200)
    expect((await fetch(`${url}/assets/app.js`)).status).toBe(200)
    expect((await fetch(`${url}/api/ping`)).status).toBe(200)
    expect((await fetch(`${url}/api/ping`)).status).toBe(429)
})

test('sessions round-trip through memory and through Redis', async () => {
    const cases = [{}, { FLIGHT_REDIS_URL: 'redis://127.0.0.1:6379' }]
    for (const extra of cases) {
        const { url } = await boot({ FLIGHT_SESSION_SECRET: 'test-secret', ...extra })
        const login = await fetch(`${url}/api/login`, { method: 'POST' })
        expect(login.status).toBe(200)
        const setCookie = login.headers.get('set-cookie')
        expect(setCookie).toBeTruthy()
        const me = await fetch(`${url}/api/me`, { headers: { cookie: setCookie!.split(';')[0] } })
        expect(await me.json()).toEqual({ user: 'ada' })
        const anon = await fetch(`${url}/api/me`)
        expect(await anon.json()).toEqual({ user: null })
    }
})

test('opt-in response cache serves the second GET from the store', async () => {
    const { url } = await boot({ FLIGHT_CACHE_ENABLED: 'true' })
    const miss = await fetch(`${url}/api/cached`, { headers: { accept: 'application/json' } })
    expect(miss.headers.get('x-flight-cache')).toBe('MISS')
    expect(await miss.json()).toEqual({ n: 1 })
    const hit = await fetch(`${url}/api/cached`, { headers: { accept: 'application/json' } })
    expect(hit.headers.get('x-flight-cache')).toBe('HIT')
    expect(await hit.json()).toEqual({ n: 1 })
})
