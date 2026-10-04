import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

import type { KoaMiddleware } from './backends'

/** Node-style response stand-in that Koa's `res.end()` can finish. */
class MockResponse extends EventEmitter {
    statusCode = 404
    headersSent = false
    finished = false
    writableEnded = false
    /** Left unset so `on-finished` does not treat a plain object as a socket. */
    socket: EventEmitter | null = null
    flightMatched = false
    private chunks: Buffer[] = []
    private headers = new Map<string, string | string[]>()

    /** Store a response header. Repeated Set-Cookie values accumulate. */
    setHeader(name: string, value: string | number | string[]) {
        const key = name.toLowerCase()
        if (key === 'set-cookie') {
            const next = (Array.isArray(value) ? value : [value]).map(String)
            const prev = this.headers.get(key)
            const existing = prev === undefined ? [] : Array.isArray(prev) ? prev : [prev]
            this.headers.set(key, existing.concat(next))
            return
        }
        this.headers.set(key, Array.isArray(value) ? value.map(String) : String(value))
    }

    /** Read a response header. */
    getHeader(name: string): string | string[] | undefined {
        return this.headers.get(name.toLowerCase())
    }

    /** Remove a response header. */
    removeHeader(name: string) {
        this.headers.delete(name.toLowerCase())
    }

    /** Record the status line. Koa calls this before `end` when headers are flushed. */
    writeHead(status: number, headers?: Record<string, string | string[]>) {
        this.statusCode = status
        if (headers) {
            for (const [key, value] of Object.entries(headers)) this.setHeader(key, value)
        }
        this.headersSent = true
        return this
    }

    /** No-op. Koa sometimes flushes headers early. */
    flushHeaders() {
        this.headersSent = true
    }

    /** Buffer a chunk. */
    write(chunk?: string | Buffer) {
        if (chunk) this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        return true
    }

    /** Finish the response and emit the events `on-finished` listens for. */
    end(chunk?: string | Buffer) {
        if (chunk) this.write(chunk)
        this.finished = true
        this.writableEnded = true
        this.headersSent = true
        this.emit('finish')
        this.emit('close')
        return this
    }

    /** Build the Fetch response from the buffered status, headers, and body. */
    toResponse(): Response {
        const headers = new Headers()
        for (const [key, value] of this.headers) {
            if (Array.isArray(value)) {
                for (const item of value) headers.append(key, item)
            } else {
                headers.set(key, value)
            }
        }
        const body = this.chunks.length ? Buffer.concat(this.chunks) : null
        return new Response(body, { status: this.statusCode, headers })
    }
}

/**
 * Adapt a Fetch request into the readable Node request Koa and bodyparser expect.
 */
function requestFromFetch(request: Request, body: Buffer): Readable {
    const url = new URL(request.url)
    const headers: Record<string, string> = {}
    request.headers.forEach((value, key) => {
        headers[key] = value
    })
    if (!headers['content-length']) headers['content-length'] = String(body.length)

    const req = Readable.from(body.length ? [body] : []) as Readable & Record<string, unknown>
    req.method = request.method
    req.url = url.pathname + url.search
    req.headers = headers
    req.httpVersion = '1.1'
    req.httpVersionMajor = 1
    req.httpVersionMinor = 1
    req.socket = { remoteAddress: '127.0.0.1', encrypted: false, readable: false, writable: true }
    req.connection = req.socket
    return req
}

/**
 * Run one Fetch request through a Koa callback. Returns null when no route matched,
 * so the caller can still serve the SPA.
 */
function callbackToFetch(callback: (req: Readable, res: MockResponse) => void) {
    return async function dispatch(request: Request): Promise<Response | null> {
        const body =
            request.method === 'GET' || request.method === 'HEAD'
                ? Buffer.alloc(0)
                : Buffer.from(await request.arrayBuffer())
        const req = requestFromFetch(request, body)
        const res = new MockResponse()

        await new Promise<void>((resolve, reject) => {
            res.on('finish', () => resolve())
            res.on('error', reject)
            try {
                callback(req, res)
            } catch (err) {
                reject(err)
            }
        })

        if (!res.flightMatched) return null
        return res.toResponse()
    }
}

/**
 * Build a Fetch dispatcher for existing Koa `router.routes()` backends.
 * JSON bodies are parsed with `koa-bodyparser`. Unmatched paths return null.
 */
export async function createKoaDispatcher(
    middlewares: KoaMiddleware[],
    payloadLimit: string
): Promise<(req: Request) => Promise<Response | null>> {
    const koaModule = await import('koa')
    const bodyParserModule = await import('koa-bodyparser')
    const Koa = koaModule.default
    const bodyParser = bodyParserModule.default
    const app = new Koa()

    app.use(async (ctx: any, next: () => Promise<void>) => {
        await next()
        ctx.res.flightMatched = Array.isArray(ctx.matched) && ctx.matched.length > 0
    })
    app.use(
        bodyParser({
            jsonLimit: payloadLimit,
            enableTypes: ['json', 'form', 'text']
        })
    )
    for (const middleware of middlewares) app.use(middleware as any)

    return callbackToFetch(app.callback())
}
