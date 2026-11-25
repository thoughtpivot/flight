import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'

import type { Browser } from 'puppeteer-core'

import {
    FIXTURES_DIR,
    fetchShellAndBundle,
    launchBrowser,
    renderInBrowser,
    startFlightBun,
    startFlightNode,
    waitForShell,
    type ServerHandle
} from './harness.mts'

/** One fixture app and the text its page must render, in document order. */
const FRAMEWORKS = [
    { name: 'vanilla', label: 'Vanilla JS/TS', expected: ['Hello from Flight + Vanilla'] },
    { name: 'preact', label: 'Preact', expected: ['Hello from Flight + Preact'] },
    {
        name: 'lit',
        label: 'Lit',
        expected: ['Hello from Flight + Lit (plain class)', 'Hello from Flight + Lit (decorators)']
    },
    { name: 'svelte', label: 'Svelte', expected: ['Hello from Flight + Svelte'] },
    { name: 'solid', label: 'Solid', expected: ['Hello from Flight + Solid'] },
    { name: 'qwik', label: 'Qwik', expected: ['Hello from Flight + Qwik'] }
]

let browser: Browser

before(async () => {
    browser = await launchBrowser()
})

after(async () => {
    await browser?.close()
})

/**
 * The page must serve its shell and a non-empty JavaScript bundle, and the framework must render its markup
 * in a real browser without console errors, page errors, failed requests, or HTTP error responses.
 */
async function assertPageWorks(server: ServerHandle, expected: string[]): Promise<void> {
    const shell = await fetchShellAndBundle(server.url)
    assert.match(shell.html, /<div id="app"><\/div>/, 'the shell has the mount point')
    assert.match(shell.bundleType, /javascript/, `bundle content type was ${shell.bundleType}`)
    assert.ok(shell.bundleBytes > 0, 'the entry bundle is not empty')

    const rendered = await renderInBrowser(browser, `${server.url}/`, expected.length)
    assert.deepEqual(rendered.texts, expected, 'the framework rendered the expected markup')
    assert.deepEqual(rendered.problems, [], 'the browser reported no errors while loading the page')
}

for (const framework of FRAMEWORKS) {
    test(`${framework.label}: built and served by Flight`, { timeout: 240_000 }, async (t) => {
        const appHome = join(FIXTURES_DIR, framework.name)
        await rm(join(appHome, 'dist'), { recursive: true, force: true })

        await t.test('the Node server runs `vite build` for the app and serves it', async () => {
            const server = await startFlightNode(appHome)
            try {
                await waitForShell(server, 120_000)
                await assertPageWorks(server, framework.expected)

                for (let attempt = 0; attempt < 100 && !/vite v8\.\d+\.\d+ building/.test(server.output()); attempt++) {
                    await sleep(100)
                }
                assert.match(server.output(), /vite v8\.\d+\.\d+ building/, 'Flight built the app with Vite 8')
                assert.doesNotMatch(server.output(), /exec error/, 'the Vite build did not fail')
            } finally {
                await server.stop()
            }
        })

        await t.test('flight-bun serves the same build', async () => {
            const server = await startFlightBun(appHome)
            try {
                await waitForShell(server, 30_000)
                await assertPageWorks(server, framework.expected)
            } finally {
                await server.stop()
            }
        })
    })
}
