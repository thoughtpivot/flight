#!/usr/bin/env bun
import { loadConfig } from './config'
import { openFlight } from './app'

const cfg = loadConfig()
await openFlight(cfg)

if (cfg.mode === 'development') {
    Bun.spawn(['bunx', 'vite', '--port', '3001', '--host', '0.0.0.0'], {
        cwd: cfg.appHome,
        stdout: 'inherit',
        stderr: 'inherit',
        stdin: 'inherit'
    })
    console.log('flight-bun: spawned Vite dev server on :3001')
}
