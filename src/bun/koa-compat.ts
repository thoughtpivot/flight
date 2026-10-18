import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

import type { KoaMiddleware } from './backends'
import { markStreaming } from './middleware'

type WriteCallback = (error?: Error | null) => void

/** Node-style response stand-in that Koa's `res.end()` can finish. */
class MockResponse extends EventEmitter {
    statusCode = 404
    headersSent = false
    finished = false
    writableEnded = false
    /** Left unset so `on-finished` does not treat a plain object as a socket. */
    socket: EventEmitter | null = null
    flightMatched = false
    /** Re-read whether any mounted router has matched. Runs before the dispatcher decides. */
    refreshMatch: () => void = () => {}
    private chunks: Buffer[] = []
    private headers = new Map<string, string | string[]>()
    /** True once `writeHead`, `write`, or `ctx.respond = false` starts a live body. */
    private streaming = false
    /** True while `end()` is copying its final chunk, so that write does not start a stream. */
    private ending = false
    private closeEmitted = false
    private clientAborted = false
    private controller: ReadableStreamDefaultController<Uint8Array> | null = null

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

    /** Record the status line. Calling this begins a streamed body. */
    writeHead(
        status: number,
        reason?: string | Record<string, string | number | string[]>,
        maybeHeaders?: Record<string, string | number | string[]>
    ) {
        this.statusCode = status
        const headers = typeof reason === 'string' || reason === undefined ? maybeHeaders : reason
        if (headers) {
            for (const [key, value] of Object.entries(headers)) this.setHeader(key, value)
        }
        this.headersSent = true
        if (!this.finished && !this.ending) this.startStream()
        return this
    }

    /** Flush headers and begin a streamed body. */
    flushHeaders() {
        this.headersSent = true
        if (!this.finished && !this.ending) this.startStream()
    }

    /**
     * Begin a streamed body without waiting for `end()`.
     * Headers set in the same turn are included; the Fetch response resolves on the next microtask.
     */
    startStream() {
        if (this.streaming || this.finished || this.writableEnded) return
        this.streaming = true
        this.refreshMatch()
        queueMicrotask(() => {
            this.emit('stream-open')
        })
    }

    /** Buffer a chunk, or enqueue it when a live stream is already open. */
    write(chunk?: string | Buffer | Uint8Array, encoding?: BufferEncoding | WriteCallback, callback?: WriteCallback) {
        if (this.writableEnded || this.clientAborted) return false
        let cb: WriteCallback | undefined
        let enc: BufferEncoding | undefined
        if (typeof encoding === 'function') cb = encoding
        else {
            enc = encoding
            if (typeof callback === 'function') cb = callback
        }
        if (chunk != null && chunk.length !== 0) {
            const bytes = typeof chunk === 'string' ? Buffer.from(chunk, enc) : Buffer.from(chunk)
            this.enqueue(bytes)
        }
        if (!this.ending) this.startStream()
        if (cb) queueMicrotask(() => cb!())
        return true
    }

    /** Finish the response and emit the events `on-finished` listens for. */
    end(chunk?: string | Buffer | Uint8Array, encoding?: BufferEncoding | WriteCallback, callback?: WriteCallback) {
        if (this.writableEnded) return this
        this.ending = true
        if (chunk != null && chunk !== '') this.write(chunk, encoding, callback)
        else if (typeof encoding === 'function') queueMicrotask(() => encoding())
        else if (typeof callback === 'function') queueMicrotask(() => callback())
        this.finished = true
        this.writableEnded = true
        this.headersSent = true
        this.refreshMatch()
        this.closeController()
        this.emit('finish')
        this.emitClose()
        return this
    }

    /** Client went away. `res.on('close')` handlers use this to drop heartbeats and subscribers. */
    clientDisconnect() {
        if (this.clientAborted) return
        this.clientAborted = true
        this.closeController()
        this.emitClose()
    }

    /** Build the Fetch response from the buffered status, headers, and body. */
    toResponse(): Response {
        if (this.streaming && !this.finished) return this.liveResponse()
        const body = this.chunks.length ? Buffer.concat(this.chunks) : null
        return new Response(body, { status: this.statusCode, headers: this.headerInit() })
    }

    /** Push bytes into the live controller, or hold them until that controller exists. */
    private enqueue(bytes: Buffer) {
        if (!this.controller) {
            this.chunks.push(bytes)
            return
        }
        try {
            this.controller.enqueue(bytes)
        } catch {
            // The stream is already closed.
        }
    }

    /** Close the live body if the consumer has already attached. */
    private closeController() {
        if (!this.controller) return
        try {
            this.controller.close()
        } catch {
            // Already closed or cancelled.
        }
    }

    /** Emit `close` once, whether the route finished or the client aborted. */
    private emitClose() {
        if (this.closeEmitted) return
        this.closeEmitted = true
        this.emit('close')
    }

    /** Copy stored headers into a Fetch `Headers` object. */
    private headerInit(): Headers {
        const headers = new Headers()
        for (const [key, value] of this.headers) {
            if (Array.isArray(value)) {
                for (const item of value) headers.append(key, item)
            } else {
                headers.set(key, value)
            }
        }
        return headers
    }

    /**
     * Return a Fetch response whose body stays open until `end()` or the client disconnects.
     * Chunks written before this runs are flushed first.
     */
    private liveResponse(): Response {
        const stream = new ReadableStream<Uint8Array>({
            start: (controller) => {
                this.controller = controller
                for (const chunk of this.chunks.splice(0)) controller.enqueue(chunk)
                if (this.finished || this.clientAborted) this.closeController()
            },
            cancel: () => {
                this.clientDisconnect()
            }
        })
        markStreaming(stream)
        return new Response(stream, { status: this.statusCode, headers: this.headerInit() })
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

/** Koa context fields the compat layer observes. */
interface KoaCtx {
    matched?: unknown
    /** Set by `@koa/router` when the path and the method both match. */
    _matchedRoute?: unknown
    respond?: unknown
    res: MockResponse
}

/** Arrays whose `push` already updates `flightMatched`. Later routers append instead of assigning. */
const observedMatches = new WeakSet<object>()

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

        const onAbort = () => res.clientDisconnect()
        if (request.signal.aborted) onAbort()
        else request.signal.addEventListener('abort', onAbort, { once: true })
        res.once('finish', () => request.signal.removeEventListener('abort', onAbort))

        await new Promise<void>((resolve, reject) => {
            let settled = false
            const finish = () => {
                res.refreshMatch()
                if (settled) return
                settled = true
                resolve()
            }
            res.on('finish', finish)
            res.on('stream-open', finish)
            res.on('error', (err) => {
                if (settled) return
                settled = true
                reject(err)
            })
            try {
                callback(req, res)
            } catch (err) {
                if (!settled) {
                    settled = true
                    reject(err)
                }
            }
        })

        if (!res.flightMatched) return null
        return res.toResponse()
    }
}

/**
 * True when this request hit a route.
 * `@koa/router` assigns `ctx.matched` for the first router only. Every later router
 * `push`es onto that same array, and sets `_matchedRoute` when the method matches.
 */
function hasMatch(ctx: KoaCtx): boolean {
    const matched = ctx.matched
    if (Array.isArray(matched) && matched.length > 0) return true
    return typeof ctx._matchedRoute === 'string' && ctx._matchedRoute.length > 0
}

/**
 * Notice routes appended with `push` after the first router assigned `ctx.matched`.
 */
function observePushes(ctx: KoaCtx, layers: unknown[]) {
    if (observedMatches.has(layers)) return
    observedMatches.add(layers)
    const original = Array.prototype.push
    layers.push = function (this: unknown[], ...items: unknown[]) {
        const result = original.apply(this, items)
        ctx.res.refreshMatch()
        return result
    }
}

/**
 * Keep `flightMatched` current for every router, including ones that only `push`.
 * The dispatcher reads it again when a stream opens or the response finishes.
 */
function trackMatch(ctx: KoaCtx) {
    ctx.res.refreshMatch = () => {
        ctx.res.flightMatched = hasMatch(ctx)
    }
    let matched = ctx.matched
    if (Array.isArray(matched)) observePushes(ctx, matched)
    Object.defineProperty(ctx, 'matched', {
        configurable: true,
        enumerable: true,
        get() {
            return matched
        },
        set(value: unknown) {
            matched = value
            if (Array.isArray(value)) observePushes(ctx, value)
            ctx.res.refreshMatch()
        }
    })
}

/**
 * `ctx.respond = false` means the route owns the raw response and Koa must not wait for `end()`.
 */
function trackRespond(ctx: KoaCtx) {
    let respond = ctx.respond
    Object.defineProperty(ctx, 'respond', {
        configurable: true,
        enumerable: true,
        get() {
            return respond
        },
        set(value: unknown) {
            respond = value
            if (value === false) ctx.res.startStream()
        }
    })
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

    app.use(async (ctx: KoaCtx, next: () => Promise<void>) => {
        trackMatch(ctx)
        trackRespond(ctx)
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
