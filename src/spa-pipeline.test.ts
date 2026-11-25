import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import Router from '@koa/router'
import Koa from 'koa'
import serve from 'koa-static'
import request from 'supertest'

import {
    applyTrustProxy,
    httpCacheEnabledInSpaPipeline,
    mountRouter,
    parseCommaPrefixes,
    productionSpaPipelineActive,
    ratelimitWithPrefixSkips,
    resolveDistRoot,
    shouldRateLimitPath,
    shouldSkipRateLimitForPath,
    spaIndexHtmlFallback,
    spaIndexRelative
} from './spa-pipeline.js'

function makeTempDist(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-spa-'))
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>flight-spa</title>', 'utf8')
    fs.writeFileSync(path.join(dir, 'assets', 'app.js'), "export const x = 'asset'", 'utf8')
    fs.writeFileSync(path.join(dir, 'secret.txt'), 'nope', 'utf8')
    return dir
}

function buildSpaStack(dist: string, extraDeny: string[] = []): Koa {
    const app = new Koa()
    const router = new Router()
    router.get('/api/ping', async (ctx) => {
        ctx.body = { ok: true }
    })
    app.use(router.routes()).use(router.allowedMethods())
    app.use(serve(dist))
    app.use(spaIndexHtmlFallback(dist, 'index.html', extraDeny))
    return app
}

test('productionSpaPipelineActive: production + disable_vite on by default', () => {
    assert.equal(productionSpaPipelineActive('production', true, {}), true)
})

test('productionSpaPipelineActive: opt-out env', () => {
    assert.equal(productionSpaPipelineActive('production', true, { FLIGHT_DISABLE_SPA_PIPELINE: '1' }), false)
    assert.equal(productionSpaPipelineActive('production', true, { FLIGHT_DISABLE_SPA_PIPELINE: 'true' }), false)
    assert.equal(productionSpaPipelineActive('production', true, { FLIGHT_DISABLE_SPA_PIPELINE: 'yes' }), false)
    assert.equal(productionSpaPipelineActive('production', true, { FLIGHT_DISABLE_SPA_PIPELINE: 'TRUE' }), true)
})

test('productionSpaPipelineActive: not when vite enabled', () => {
    assert.equal(productionSpaPipelineActive('production', false, {}), false)
})

test('productionSpaPipelineActive: not in development', () => {
    assert.equal(productionSpaPipelineActive('development', true, {}), false)
})

test('parseCommaPrefixes uses the second argument only when the value is missing', () => {
    assert.deepEqual(parseCommaPrefixes(undefined, '/a,/b'), ['/a', '/b'])
    assert.deepEqual(parseCommaPrefixes('', '/z'), [])
    assert.deepEqual(parseCommaPrefixes(' , , ', '/z'), [])
    assert.deepEqual(parseCommaPrefixes('a, b', '/z'), ['/a', '/b'])
    assert.deepEqual(parseCommaPrefixes('/already', ''), ['/already'])
})

test('resolveDistRoot and spaIndexRelative', () => {
    assert.equal(resolveDistRoot('/app', {}), path.resolve('/app', '../dist'))
    assert.equal(resolveDistRoot('/app', { FLIGHT_DIST_PATH: '' }), path.resolve('/app', '../dist'))
    assert.equal(resolveDistRoot('/app', { FLIGHT_DIST_PATH: '   ' }), path.resolve('/app', '../dist'))
    assert.equal(resolveDistRoot('/app', { FLIGHT_DIST_PATH: 'build' }), path.resolve('/app', 'build'))
    assert.equal(resolveDistRoot('/app', { FLIGHT_DIST_PATH: '/var/www/dist' }), path.resolve('/app', '/var/www/dist'))
    assert.equal(spaIndexRelative({}), 'index.html')
    assert.equal(spaIndexRelative({ FLIGHT_SPA_INDEX: '' }), 'index.html')
    assert.equal(spaIndexRelative({ FLIGHT_SPA_INDEX: '   ' }), 'index.html')
    assert.equal(spaIndexRelative({ FLIGHT_SPA_INDEX: ' ///shell.html ' }), 'shell.html')
    assert.equal(spaIndexRelative({ FLIGHT_SPA_INDEX: '../secret.html' }), 'index.html')
    assert.equal(spaIndexRelative({ FLIGHT_SPA_INDEX: 'a/../../x' }), 'index.html')
})

test('applyTrustProxy sets the flag from a fresh app each time', () => {
    const cases: Array<{ env: NodeJS.ProcessEnv; start: boolean; expected: boolean }> = [
        { env: {}, start: true, expected: false },
        { env: { FLIGHT_TRUST_PROXY: '1' }, start: false, expected: true },
        { env: { FLIGHT_TRUST_PROXY: 'true' }, start: false, expected: true },
        { env: { FLIGHT_TRUST_PROXY: 'yes' }, start: false, expected: true },
        { env: { FLIGHT_TRUST_PROXY: 'TRUE' }, start: true, expected: false },
        { env: { FLIGHT_TRUST_PROXY: '0' }, start: true, expected: false },
        { env: { FLIGHT_TRUST_PROXY: 'false' }, start: true, expected: false },
        { env: { FLIGHT_TRUST_PROXY: '' }, start: true, expected: false }
    ]
    for (const { env, start, expected } of cases) {
        const app = { proxy: start }
        applyTrustProxy(app, env)
        assert.equal(app.proxy, expected)
    }
})

test('http cache flag accepts only 1, true, and yes', () => {
    assert.equal(httpCacheEnabledInSpaPipeline({}), false)
    assert.equal(httpCacheEnabledInSpaPipeline({ FLIGHT_HTTP_CACHE: '1' }), true)
    assert.equal(httpCacheEnabledInSpaPipeline({ FLIGHT_HTTP_CACHE: 'true' }), true)
    assert.equal(httpCacheEnabledInSpaPipeline({ FLIGHT_HTTP_CACHE: 'yes' }), true)
    assert.equal(httpCacheEnabledInSpaPipeline({ FLIGHT_HTTP_CACHE: 'TRUE' }), false)
    assert.equal(httpCacheEnabledInSpaPipeline({ FLIGHT_HTTP_CACHE: '0' }), false)
    assert.equal(httpCacheEnabledInSpaPipeline({ FLIGHT_HTTP_CACHE: 'false' }), false)
})

test('shouldSkipRateLimitForPath', () => {
    assert.equal(shouldSkipRateLimitForPath('/assets/foo.js', 'GET', ['/assets']), true)
    assert.equal(shouldSkipRateLimitForPath('/assets', 'GET', ['/assets']), true)
    assert.equal(shouldSkipRateLimitForPath('/fonts/a.woff2', 'HEAD', ['/fonts']), true)
    assert.equal(shouldSkipRateLimitForPath('/api/x', 'GET', ['/assets']), false)
    assert.equal(shouldSkipRateLimitForPath('/assets/foo.js', 'POST', ['/assets']), false)
    assert.equal(shouldSkipRateLimitForPath('/assets-other/foo.js', 'GET', ['/assets']), false)
})

test('ratelimitWithPrefixSkips does not call the limiter for a static GET', async () => {
    const middleware = ratelimitWithPrefixSkips({} as never, ['/assets'])
    let reached = false
    await middleware({ path: '/assets/app.js', method: 'GET' } as never, async () => {
        reached = true
    })
    assert.equal(reached, true)
})

test('shouldRateLimitPath limits every route by default and honors include and skip prefixes', () => {
    assert.equal(shouldRateLimitPath('/api/x', 'GET', []), true)
    assert.equal(shouldRateLimitPath('/orders', 'POST', []), true)
    assert.equal(shouldRateLimitPath('/', 'GET', []), true)

    assert.equal(shouldRateLimitPath('/orders', 'POST', [], ['/v1']), false)
    assert.equal(shouldRateLimitPath('/v1/orders', 'POST', [], ['/v1']), true)
    assert.equal(shouldRateLimitPath('/v1', 'GET', [], ['/v1']), true)
    assert.equal(shouldRateLimitPath('/v10/orders', 'POST', [], ['/v1']), false)
    assert.equal(shouldRateLimitPath('/anything', 'GET', [], ['/']), true)

    assert.equal(shouldRateLimitPath('/assets/app.js', 'GET', ['/assets']), false)
    assert.equal(shouldRateLimitPath('/assets/app.js', 'POST', ['/assets']), true)
    assert.equal(shouldRateLimitPath('/v1/assets/app.js', 'GET', ['/v1/assets'], ['/v1']), false)
})

/**
 * Koa app with the same mount order as the Node runtime: limiter first, then the router.
 * Routes deliberately do not sit under `/api`, so nothing in the test depends on that prefix.
 */
function buildLimitedApp(max: number, includePrefixes: string[] = [], skipPrefixes: string[] = []): Koa {
    const app = new Koa()
    const router = new Router()
    router.get('/api/ping', async (ctx) => {
        ctx.body = { ok: true }
    })
    router.get('/orders', async (ctx) => {
        ctx.body = { orders: [] }
    })
    router.get('/assets/app.js', async (ctx) => {
        ctx.body = 'asset'
    })
    const limiter = ratelimitWithPrefixSkips(new Map(), skipPrefixes, { max, includePrefixes })
    mountRouter(app, router, limiter)
    return app
}

test('matched /api routes are counted and get 429 once the limit is exceeded', async () => {
    const server = request(buildLimitedApp(2).callback())

    const first = await server.get('/api/ping')
    assert.equal(first.status, 200)
    assert.equal(first.headers['rate-limit-total'], '2')
    assert.equal(first.headers['rate-limit-remaining'], '1')

    const second = await server.get('/api/ping')
    assert.equal(second.status, 200)
    assert.equal(second.headers['rate-limit-remaining'], '0')

    const third = await server.get('/api/ping')
    assert.equal(third.status, 429)
    assert.equal(third.text, 'Sometimes You Just Have to Slow Down.')
    assert.ok(third.headers['retry-after'])
})

test('by default the limiter covers every route, not only /api', async () => {
    const server = request(buildLimitedApp(2).callback())

    assert.equal((await server.get('/api/ping')).status, 200)
    assert.equal((await server.get('/orders')).status, 200)
    assert.equal((await server.get('/orders')).status, 429)
    assert.equal((await server.get('/api/ping')).status, 429)
    assert.equal((await server.get('/does-not-exist')).status, 429)
})

test('a limiter mounted after the router never sees matched routes', async () => {
    const app = new Koa()
    const router = new Router()
    router.get('/api/ping', async (ctx) => {
        ctx.body = { ok: true }
    })
    app.use(router.routes())
    app.use(ratelimitWithPrefixSkips(new Map(), [], { max: 1 }))

    const server = request(app.callback())
    for (let i = 0; i < 3; i++) {
        const res = await server.get('/api/ping')
        assert.equal(res.status, 200)
        assert.equal(res.headers['rate-limit-total'], undefined)
    }
})

test('includePrefixes scopes the limiter to the listed paths', async () => {
    const server = request(buildLimitedApp(1, ['/api']).callback())

    assert.equal((await server.get('/api/ping')).status, 200)
    assert.equal((await server.get('/api/ping')).status, 429)

    for (let i = 0; i < 3; i++) {
        const res = await server.get('/orders')
        assert.equal(res.status, 200)
        assert.equal(res.headers['rate-limit-total'], undefined)
    }
})

test('skip prefixes still exempt GET static paths from the limiter', async () => {
    const server = request(buildLimitedApp(1, [], ['/assets']).callback())

    for (let i = 0; i < 3; i++) {
        assert.equal((await server.get('/assets/app.js')).status, 200)
    }
    assert.equal((await server.get('/api/ping')).status, 200)
    assert.equal((await server.get('/api/ping')).status, 429)
})

test('mountRouter without a limiter leaves routes unlimited', async () => {
    const app = new Koa()
    const router = new Router()
    router.get('/api/ping', async (ctx) => {
        ctx.body = { ok: true }
    })
    mountRouter(app, router, null)

    const server = request(app.callback())
    for (let i = 0; i < 3; i++) {
        assert.equal((await server.get('/api/ping')).status, 200)
    }
})

test('GET hashed asset returns file body, not index.html', async () => {
    const dist = makeTempDist()
    const app = buildSpaStack(dist)
    const res = await request(app.callback()).get('/assets/app.js')
    assert.equal(res.status, 200)
    assert.match(res.text, /export const x/)
})

test('GET SPA deep link with Accept: text/html serves index.html', async () => {
    const dist = makeTempDist()
    const app = buildSpaStack(dist)
    const res = await request(app.callback()).get('/dashboard/deep').set('Accept', 'text/html')
    assert.equal(res.status, 200)
    assert.match(res.text, /flight-spa/)
})

test('GET /api/ping returns JSON', async () => {
    const dist = makeTempDist()
    const app = buildSpaStack(dist)
    const res = await request(app.callback()).get('/api/ping').set('Accept', 'application/json')
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { ok: true })
})

test('GET unknown /api route does not fall back to index.html', async () => {
    const dist = makeTempDist()
    const app = buildSpaStack(dist)
    const res = await request(app.callback()).get('/api/missing').set('Accept', 'text/html')
    assert.equal(res.status, 404)
    assert.ok(!String(res.text).includes('flight-spa'))
})

test('path with file extension in last segment is not rewritten to index', async () => {
    const dist = makeTempDist()
    const app = buildSpaStack(dist)
    const res = await request(app.callback()).get('/anything/secret.txt').set('Accept', 'text/html')
    assert.equal(res.status, 404)
})

test('GET deep link with no Accept header serves index.html', async () => {
    const dist = makeTempDist()
    const app = buildSpaStack(dist)
    const res = await request(app.callback()).get('/dashboard')
    assert.equal(res.status, 200)
    assert.match(res.text, /flight-spa/)
})

test('GET deep link with Accept */* serves index.html', async () => {
    const dist = makeTempDist()
    const app = buildSpaStack(dist)
    const res = await request(app.callback()).get('/dashboard').set('Accept', '*/*')
    assert.equal(res.status, 200)
    assert.match(res.text, /flight-spa/)
})

test('GET deep link with Accept application/json does not serve index.html', async () => {
    const dist = makeTempDist()
    const app = buildSpaStack(dist)
    const res = await request(app.callback()).get('/dashboard').set('Accept', 'application/json')
    assert.equal(res.status, 404)
    assert.ok(!String(res.text).includes('flight-spa'))
})

test('POST deep link does not serve index.html', async () => {
    const dist = makeTempDist()
    const app = buildSpaStack(dist)
    const res = await request(app.callback()).post('/dashboard').set('Accept', 'text/html')
    assert.equal(res.status, 404)
})

test('HEAD deep link serves the SPA shell', async () => {
    const dist = makeTempDist()
    const app = buildSpaStack(dist)
    const res = await request(app.callback()).head('/dashboard').set('Accept', 'text/html')
    assert.equal(res.status, 200)
    assert.match(String(res.headers['content-type']), /text\/html/)
})

test('GET /health and nested health paths do not fall back to index.html', async () => {
    const dist = makeTempDist()
    const app = buildSpaStack(dist)
    const health = await request(app.callback()).get('/health').set('Accept', 'text/html')
    const nested = await request(app.callback()).get('/health/live').set('Accept', 'text/html')
    assert.equal(health.status, 404)
    assert.equal(nested.status, 404)
    assert.ok(!String(health.text).includes('flight-spa'))
})

test('extra deny prefix blocks fallback and does not swallow sibling paths', async () => {
    const dist = makeTempDist()
    const app = buildSpaStack(dist, ['/admin'])
    const denied = await request(app.callback()).get('/admin/users').set('Accept', 'text/html')
    const sibling = await request(app.callback()).get('/administration').set('Accept', 'text/html')
    const apples = await request(app.callback()).get('/apples').set('Accept', 'text/html')
    assert.equal(denied.status, 404)
    assert.equal(sibling.status, 200)
    assert.match(sibling.text, /flight-spa/)
    assert.equal(apples.status, 200)
})

test('missing index.html does not throw', async () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-spa-empty-'))
    const app = buildSpaStack(dist)
    const res = await request(app.callback()).get('/dashboard').set('Accept', 'text/html')
    assert.equal(res.status, 404)
})

test('SPA index path that leaves dist is not served', async () => {
    const dist = makeTempDist()
    const outside = path.join(dist, '..', `flight-secret-${path.basename(dist)}.html`)
    fs.writeFileSync(outside, 'secret-outside', 'utf8')
    const app = new Koa()
    app.use(serve(dist))
    app.use(spaIndexHtmlFallback(dist, '../' + path.basename(outside), []))
    try {
        const res = await request(app.callback()).get('/dashboard').set('Accept', 'text/html')
        assert.equal(res.status, 404)
        assert.ok(!String(res.text).includes('secret-outside'))
    } finally {
        fs.unlinkSync(outside)
    }
})
