import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { backendDiscoveryIgnorePatterns, dedupeStrings, normalizeExcludePaths } from './backend-discovery.js'

test('normalizeExcludePaths splits commas and drops blanks', () => {
    assert.deepEqual(normalizeExcludePaths(null), [])
    assert.deepEqual(normalizeExcludePaths(''), [])
    assert.deepEqual(normalizeExcludePaths(' vendor , tmp '), ['vendor', 'tmp'])
    assert.deepEqual(normalizeExcludePaths(['a, b', '  ', 'c']), ['a', 'b', 'c'])
})

test('dedupeStrings keeps the first occurrence', () => {
    assert.deepEqual(dedupeStrings(['vendor', 'tmp', 'vendor']), ['vendor', 'tmp'])
})

test('CLI and env exclude lists merge without duplicates', () => {
    const merged = dedupeStrings([...normalizeExcludePaths(['vendor', 'generated']), ...normalizeExcludePaths('vendor, tmp')])
    assert.deepEqual(merged, ['vendor', 'generated', 'tmp'])
})

test('backendDiscoveryIgnorePatterns globs directories inside app_home', () => {
    const root = path.join(os.tmpdir(), 'flight-app')
    assert.deepEqual(backendDiscoveryIgnorePatterns(root, ['vendor', 'nested/gen', ' vendor ']), [
        'vendor/**',
        'nested/gen/**',
        'vendor/**'
    ])
})

test('backendDiscoveryIgnorePatterns skips paths outside app_home', () => {
    const root = path.join(os.tmpdir(), 'flight-app')
    const warnings: string[] = []
    const original = console.warn
    console.warn = (message?: unknown) => {
        warnings.push(String(message))
    }
    try {
        const patterns = backendDiscoveryIgnorePatterns(root, ['../outside', path.resolve(root, '..', 'abs')])
        assert.deepEqual(patterns, [])
        assert.equal(warnings.length, 2)
        assert.match(warnings[0], /outside app_home/)
        assert.match(warnings[1], /outside app_home/)
    } finally {
        console.warn = original
    }
})
