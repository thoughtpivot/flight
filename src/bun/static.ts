import { join, resolve, sep } from 'node:path'

/**
 * True when the last path segment looks like a file name (`app.js`, `secret.txt`).
 */
function lastSegmentLooksLikeFile(pathname: string): boolean {
    const base = pathname.slice(pathname.lastIndexOf('/') + 1)
    return base.includes('.')
}

/**
 * True when `pathname` is exactly `prefix` or a child of it.
 */
function hasPrefix(pathname: string, prefix: string): boolean {
    return pathname === prefix || (prefix !== '/' && pathname.startsWith(`${prefix}/`))
}

/**
 * Resolve `pathname` under `root`. Returns null when the target escapes the root.
 */
export function safeTarget(root: string, pathname: string): string | null {
    const base = resolve(root)
    const target = resolve(base, `.${pathname}`)
    if (target !== base && !target.startsWith(base + sep)) return null
    return target
}

/**
 * Serve a built SPA from `distPath` with an `index.html` fallback for document navigations.
 * Development mode returns null so Vite owns the UI. `/api`, `/health`, and `/healthz` never fall back.
 */
export function makeStaticHandler(distPath: string, mode: string, denyPrefixes: string[]) {
    const indexPath = join(distPath, 'index.html')
    const root = resolve(distPath)

    return async function serveStatic(req: Request): Promise<Response | null> {
        if (mode !== 'production') return null
        if (req.method !== 'GET' && req.method !== 'HEAD') return null

        const url = new URL(req.url)
        let pathname: string
        try {
            pathname = decodeURIComponent(url.pathname)
        } catch {
            return new Response('Bad Request', { status: 400 })
        }

        if (denyPrefixes.some((prefix) => hasPrefix(pathname, prefix))) return null

        const target = safeTarget(root, pathname)
        if (!target) return new Response('Forbidden', { status: 403 })

        if (target !== root) {
            const file = Bun.file(target)
            if (await file.exists()) {
                return new Response(req.method === 'HEAD' ? null : file)
            }
        }

        const accept = req.headers.get('accept') || ''
        const wantsHtml = !accept || accept.includes('text/html') || accept.includes('*/*')
        if (!wantsHtml || lastSegmentLooksLikeFile(pathname)) return null

        const index = Bun.file(indexPath)
        if (await index.exists()) {
            return new Response(req.method === 'HEAD' ? null : index, {
                headers: { 'content-type': 'text/html; charset=utf-8' }
            })
        }
        return null
    }
}
