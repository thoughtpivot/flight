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
    parseCommaPrefixes,
    productionSpaPipelineActive,
    ratelimitWithPrefixSkips,
    resolveDistRoot,
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

test('parseCommaPrefixes: defaults and trimming', () => {
    assert.deepEqual(parseCommaPrefixes(undefined, '/a,/b'), ['/a', '/b'])
    assert.deepEqual(parseCommaPrefixes('x, y', '/z'), ['/x', '/y'])
    assert.deepEqual(parseCommaPrefixes('', '/z'), [])
    assert.deepEqual(parseCommaPrefixes(' , , ', '/z'), [])
    assert.deepEqual(parseCommaPrefixes('/already', ''), ['/already'])
})

test('resolveDistRoot and spaIndexRelative', () => {
    assert.equal(resolveDistRoot('/app', {}), path.resolve('/app', '../dist'))
    assert.equal(resolveDistRoot('/app', { FLIGHT_DIST_PATH: 'build' }), path.resolve('/app', 'build'))
    assert.equal(spaIndexRelative({}), 'index.html')
    assert.equal(spaIndexRelative({ FLIGHT_SPA_INDEX: ' ///shell.html ' }), 'shell.html')
})

test('applyTrustProxy and http cache flags are case-sensitive', () => {
    const app = { proxy: false }
    applyTrustProxy(app, {})
    assert.equal(app.proxy, false)
    applyTrustProxy(app, { FLIGHT_TRUST_PROXY: 'yes' })
    assert.equal(app.proxy, true)
    applyTrustProxy(app, { FLIGHT_TRUST_PROXY: 'TRUE' })
    assert.equal(app.proxy, false)
    assert.equal(httpCacheEnabledInSpaPipeline({}), false)
    assert.equal(httpCacheEnabledInSpaPipeline({ FLIGHT_HTTP_CACHE: '1' }), true)
    assert.equal(httpCacheEnabledInSpaPipeline({ FLIGHT_HTTP_CACHE: 'true' }), true)
    assert.equal(httpCacheEnabledInSpaPipeline({ FLIGHT_HTTP_CACHE: 'yes' }), true)
    assert.equal(httpCacheEnabledInSpaPipeline({ FLIGHT_HTTP_CACHE: 'TRUE' }), false)
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
