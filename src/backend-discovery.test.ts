import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
    backendDiscoveryIgnorePatterns,
    dedupeStrings,
    mergeExcludePaths,
    normalizeExcludePaths
} from './backend-discovery.js'

test('normalizeExcludePaths splits commas and drops blanks', () => {
    assert.deepEqual(normalizeExcludePaths(null), [])
    assert.deepEqual(normalizeExcludePaths(undefined), [])
    assert.deepEqual(normalizeExcludePaths(''), [])
    assert.deepEqual(normalizeExcludePaths(' vendor , tmp '), ['vendor', 'tmp'])
    assert.deepEqual(normalizeExcludePaths(['a, b', '  ', 'c']), ['a', 'b', 'c'])
})

test('dedupeStrings keeps the first occurrence', () => {
    assert.deepEqual(dedupeStrings(['vendor', 'tmp', 'vendor']), ['vendor', 'tmp'])
})

test('mergeExcludePaths keeps CLI entries ahead of env and drops duplicates', () => {
    assert.deepEqual(mergeExcludePaths(['vendor', 'generated'], 'vendor, tmp'), ['vendor', 'generated', 'tmp'])
    assert.deepEqual(mergeExcludePaths(undefined, undefined), [])
})

test('backendDiscoveryIgnorePatterns globs directories inside app_home', () => {
    const root = path.join(os.tmpdir(), 'flight-app')
    assert.deepEqual(backendDiscoveryIgnorePatterns(root, [' vendor ', 'nested/gen']), ['vendor/**', 'nested/gen/**'])
    assert.deepEqual(backendDiscoveryIgnorePatterns(root, [path.join(root, 'vendor')]), ['vendor/**'])
    assert.deepEqual(backendDiscoveryIgnorePatterns(root, ['..foo']), ['..foo/**'])
})

test('blank, dot, and the app root do not ignore every backend file', () => {
    const root = path.join(os.tmpdir(), 'flight-app')
    const original = console.warn
    console.warn = () => {}
    try {
        const patterns = backendDiscoveryIgnorePatterns(root, ['', '.', root])
        assert.deepEqual(patterns, [])
    } finally {
        console.warn = original
    }
})

test('backendDiscoveryIgnorePatterns skips paths outside app_home', () => {
    const root = path.join(os.tmpdir(), 'flight-app')
    const outside = '../outside'
    const abs = path.resolve(root, '..', 'abs')
    const parent = '..'
    const warnings: string[] = []
    const original = console.warn
    console.warn = (message?: unknown) => {
        warnings.push(String(message))
    }
    try {
        const patterns = backendDiscoveryIgnorePatterns(root, [outside, abs, parent])
        assert.deepEqual(patterns, [])
        assert.equal(warnings.length, 3)
        assert.match(warnings[0], /outside app_home/)
        assert.ok(warnings[0].includes(outside))
        assert.match(warnings[1], /outside app_home/)
        assert.ok(warnings[1].includes(abs))
        assert.match(warnings[2], /outside app_home/)
        assert.ok(warnings[2].endsWith(': ..'))
    } finally {
        console.warn = original
    }
})
