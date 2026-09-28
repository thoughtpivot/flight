import path from 'path'

/** Turn a CLI value or env string into trimmed, comma-split directory names. */
export function normalizeExcludePaths(value: unknown): string[] {
    if (value == null || value === '') return []
    const parts = Array.isArray(value) ? value : [value]
    const out: string[] = []
    for (const p of parts) {
        const s = String(p).trim()
        if (!s) continue
        out.push(
            ...s
                .split(',')
                .map((x) => x.trim())
                .filter(Boolean)
        )
    }
    return out
}

/** Preserve first-seen order while dropping duplicate strings. */
export function dedupeStrings(items: string[]): string[] {
    return [...new Set(items)]
}

/**
 * Build fast-glob ignore globs for trees rooted under `appRootAbs`.
 * Entries that resolve outside that root are skipped.
 */
export function backendDiscoveryIgnorePatterns(appRootAbs: string, excludeRelativeDirs: string[]): string[] {
    const patterns: string[] = []
    for (const raw of excludeRelativeDirs) {
        const trimmed = raw.trim()
        if (!trimmed) continue
        const resolved = path.resolve(appRootAbs, trimmed)
        const rel = path.relative(appRootAbs, resolved)
        const relPosix = rel.replace(/\\/g, '/')
        if (!relPosix || relPosix.startsWith('..') || path.isAbsolute(rel)) {
            console.warn(`Flight: exclude_paths entry skipped (outside app_home): ${trimmed}`)
            continue
        }
        patterns.push(`${relPosix}/**`)
    }
    return patterns
}
