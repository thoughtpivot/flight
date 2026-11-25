import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import net from 'node:net'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import puppeteer, { type Browser } from 'puppeteer-core'

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const FIXTURES_DIR = join(REPO_ROOT, 'test', 'frameworks', 'fixtures')

/** A running Flight server and the output it has printed so far. */
export interface ServerHandle {
    url: string
    output(): string
    stop(): Promise<void>
}

/** Ask the OS for a free TCP port. */
async function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const probe = net.createServer()
        probe.once('error', reject)
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address() as net.AddressInfo
            probe.close(() => resolve(port))
        })
    })
}

/**
 * Spawn a server in its own process group so the Node cluster primary and its worker both stop.
 */
async function spawnServer(command: string, args: string[], env: Record<string, string>): Promise<ServerHandle> {
    const port = await freePort()
    let output = ''
    const child: ChildProcess = spawn(command, args, {
        cwd: REPO_ROOT,
        env: { ...process.env, ...env, FLIGHT_PORT: String(port) },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout?.on('data', (chunk) => (output += chunk))
    child.stderr?.on('data', (chunk) => (output += chunk))
    let exited = false
    child.once('exit', () => (exited = true))

    return {
        url: `http://127.0.0.1:${port}`,
        output: () => output,
        async stop() {
            if (exited || child.pid === undefined) return
            const done = new Promise<void>((resolve) => child.once('exit', () => resolve()))
            process.kill(-child.pid, 'SIGTERM')
            const killer = setTimeout(() => {
                try {
                    process.kill(-child.pid!, 'SIGKILL')
                } catch {
                    // The group already exited.
                }
            }, 5000)
            await done
            clearTimeout(killer)
        }
    }
}

/**
 * Start the Node server (`dist/flight.js`) in production. Flight itself runs `vite build` for the app.
 * It needs Redis on FLIGHT_REDIS_HOST / FLIGHT_REDIS_PORT (default localhost:6379).
 */
export async function startFlightNode(appHome: string): Promise<ServerHandle> {
    const entry = join(REPO_ROOT, 'dist', 'flight.js')
    if (!existsSync(entry)) throw new Error(`${entry} is missing. Run \`npm run build\` first.`)
    return spawnServer(process.execPath, [entry], {
        FLIGHT_MODE: 'production',
        FLIGHT_APP_HOME: appHome,
        FLIGHT_DIST_PATH: 'dist',
        FLIGHT_MAX_WORKERS: '1'
    })
}

/**
 * Start the Bun server over a directory that has already been built.
 */
export async function startFlightBun(appHome: string): Promise<ServerHandle> {
    return spawnServer(process.env.FLIGHT_TEST_BUN || 'bun', [join(REPO_ROOT, 'src', 'bun', 'server.ts')], {
        FLIGHT_MODE: 'production',
        FLIGHT_APP_HOME: appHome,
        FLIGHT_HOSTNAME: '127.0.0.1'
    })
}

/**
 * Poll until the server answers `/` with the app shell, or fail with the server output.
 */
export async function waitForShell(server: ServerHandle, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    let last = 'no response yet'
    while (Date.now() < deadline) {
        if (/exec error/.test(server.output())) {
            throw new Error(`Flight's vite build failed.\n--- server output ---\n${server.output()}`)
        }
        try {
            const res = await fetch(`${server.url}/`, { headers: { accept: 'text/html' } })
            const body = await res.text()
            if (res.status === 200 && body.includes('id="app"')) return
            last = `HTTP ${res.status}`
        } catch (err) {
            last = (err as Error).message
        }
        await sleep(250)
    }
    throw new Error(
        `Timed out after ${timeoutMs} ms waiting for the app shell (${last}).\n--- server output ---\n${server.output()}`
    )
}

/** What the server returned for the page and for the entry script it points at. */
export interface ShellCheck {
    html: string
    bundleUrl: string
    bundleType: string
    bundleBytes: number
}

/**
 * Fetch the page, find its module script, and fetch that bundle.
 */
export async function fetchShellAndBundle(baseUrl: string): Promise<ShellCheck> {
    const page = await fetch(`${baseUrl}/`, { headers: { accept: 'text/html' } })
    if (page.status !== 200) throw new Error(`GET / returned ${page.status}`)
    const html = await page.text()
    const match = /<script[^>]*type="module"[^>]*src="([^"]+)"/.exec(html)
    if (!match) throw new Error(`No module script in the page:\n${html}`)
    const bundleUrl = new URL(match[1], `${baseUrl}/`).toString()
    const bundle = await fetch(bundleUrl)
    if (bundle.status !== 200) throw new Error(`GET ${bundleUrl} returned ${bundle.status}`)
    const body = await bundle.arrayBuffer()
    return { html, bundleUrl, bundleType: bundle.headers.get('content-type') || '', bundleBytes: body.byteLength }
}

/** Where a Chrome or Chromium binary may live. `FLIGHT_TEST_CHROME` wins. */
function chromeCandidates(): string[] {
    return [
        process.env.FLIGHT_TEST_CHROME,
        process.env.CHROME_PATH,
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/local/bin/google-chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser'
    ].filter((path): path is string => Boolean(path))
}

/**
 * Launch headless Chrome through puppeteer-core. No browser is downloaded: install Chrome or set FLIGHT_TEST_CHROME.
 */
export async function launchBrowser(): Promise<Browser> {
    const executablePath = chromeCandidates().find((path) => existsSync(path))
    if (!executablePath) {
        throw new Error(
            `No Chrome or Chromium found. Install one, or set FLIGHT_TEST_CHROME to its path. Looked in: ${chromeCandidates().join(', ')}`
        )
    }
    return puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] })
}

/** Everything the browser reported while the page loaded, plus the text of each `data-testid="hello"` element. */
export interface RenderResult {
    texts: string[]
    problems: string[]
}

/**
 * Open the page in Chrome, wait for the expected number of `data-testid="hello"` elements
 * (shadow roots included), and collect console errors, page errors, failed requests and HTTP errors.
 */
export async function renderInBrowser(browser: Browser, url: string, expectedCount: number): Promise<RenderResult> {
    const page = await browser.newPage()
    const problems: string[] = []
    page.on('console', (message) => {
        if (message.type() === 'error' || message.type() === 'warning') {
            problems.push(`console.${message.type()}: ${message.text()}`)
        }
    })
    page.on('pageerror', (error) => problems.push(`pageerror: ${(error as Error).message}`))
    page.on('requestfailed', (request) =>
        problems.push(`requestfailed: ${request.url()} ${request.failure()?.errorText}`)
    )
    page.on('response', (response) => {
        if (response.status() >= 400) problems.push(`http ${response.status()}: ${response.url()}`)
    })

    try {
        await page.goto(url, { waitUntil: 'networkidle0' })
        let texts: string[] = []
        for (let attempt = 0; attempt < 100; attempt++) {
            texts = await page.evaluate(function readHello() {
                const found: string[] = []
                function walk(root: Document | ShadowRoot) {
                    for (const el of root.querySelectorAll('*')) {
                        if (el.getAttribute('data-testid') === 'hello') found.push((el.textContent || '').trim())
                        if (el.shadowRoot) walk(el.shadowRoot)
                    }
                }
                walk(document)
                return found
            })
            if (texts.length >= expectedCount) break
            await sleep(100)
        }
        return { texts, problems }
    } finally {
        await page.close()
    }
}
