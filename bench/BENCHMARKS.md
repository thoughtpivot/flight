# Flight: Node vs Bun benchmark

Early Bun research and benchmarks for Flight and Scribe by Vasilen Lyubomirov (github.com/VasilenL), whose work helped start this.

This folder holds the scripts, test apps and raw outputs behind the Node vs Bun numbers for Flight. They were run on 2026-10-14 (evening ET) against commit `b0d8689`. Raw outputs are in `results/`.

## Read this first

- Single-core results measure per-core efficiency. They are not a statement about a whole machine.
- **On 4 cores a Node cluster still beats single-process Bun on raw throughput: 80.7k vs 53.8k req/s** (Bun-native route; 41.5k for a Koa route on Bun). The shipped Bun runtime is one process and does not use four cores the way a 4-worker `node:cluster` does.
- The throughput numbers come from a hello route (`GET /api/hello`). They are micro-benchmarks and say little about a real application with database and business logic.
- Node and Bun ran different default middleware (below), so the comparison is runtime plus shipped defaults, not runtime alone.
- Node's 1.18 s startup includes the tsx loader that the README names for loading `*.backend.ts`. A ts-node variant measured 1.23 s.
- Not measured: end-to-end Flight with a real SPA and a database, multi-process Bun against a Node cluster, container size and pod cold start, production-mode middleware on both sides, and long soak memory growth.

## What was compared

|               | Runtime path                                                                                                                                   |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Node (before) | `flight` = Koa on `node:cluster`, `dist/flight.js` built by tsc. `*.backend.ts` files are loaded through tsx (a ts-node variant was also run). |
| Bun (after)   | `flight-bun` = `Bun.serve`, `src/bun/server.ts` run directly as TypeScript.                                                                    |

Variants of `GET /api/hello`, which returns `{"message":"Hello from Flight!"}`:

- a: Node and Koa, `router.routes()` backend (`apps/koa`), loaded through ts-node.
- b: the same Koa file on flight-bun, through its Koa-compat layer.
- c: a Bun-native route-map backend on flight-bun (`apps/native`).
- t: the same as a, loaded through tsx.

Middleware is each runtime's shipped default for a non-dev, non-production mode:

- Node: koa-logger (cannot be turned off; output went to /dev/null), session, CORS and bodyparser.
- Bun: security headers, CORS and compression. No logging by default.
- Neither side rate-limits.

## Environment

- 8 vCPU Intel Xeon VM, 15 GB RAM, Debian 13, kernel 6.12. It was a shared box with other processes running, so expect some noise.
- Node 20.19.2 (the repo `.nvmrc` says 20.11). Bun 1.4.2 (CI pins 1.4.3).
- wrk 4.1.0 for load, hyperfine 1.19.0 for timing.

## Method

- Single-core runs: the server is pinned to one core. The Node cluster is held to one worker with `FLIGHT_MAX_WORKERS=1`. wrk runs on cores 4-7 (`-t4 -c100`).
- 4-core runs: the server is pinned to cores 0-3. Node runs 4 workers. Bun runs its single shipped process.
- Each throughput row is a 10 s warmup, then 3 runs of 20 s. The mean is reported. No non-2xx responses or socket errors were seen.
- Memory is RSS of the whole server process tree (Node: primary plus workers), taken at idle after one request and again after load.
- Startup is the time from exec to the first HTTP 200 on `/api/hello`, measured with hyperfine (2 warmups, 15 runs).

## Results: single core

| Test                              | Node                                                               | Bun                      | Change                       |
| --------------------------------- | ------------------------------------------------------------------ | ------------------------ | ---------------------------- |
| req/s, Bun-native route           | 19,651 (tsx) / 19,342 (ts-node)                                    | 61,110                   | 3.1x                         |
| req/s, unchanged Koa route on Bun | 19,651                                                             | 38,826                   | 2.0x                         |
| p50 / p99 latency (native)        | 4.6-5.0 ms / 10-25 ms                                              | 1.5-1.6 ms / 2.9-3.0 ms  |                              |
| p99 (Koa on Bun)                  | 10-25 ms                                                           | 6.3-7.2 ms               |                              |
| Idle RSS                          | 218 MB (primary + 1 worker, tsx; the worker alone is about 112 MB) | 27 MB native / 47 MB Koa | about 8x less (process tree) |
| RSS after load                    | 206 MB                                                             | 62 MB native / 66 MB Koa |                              |

## Results: startup to first 200

|                    | Node                                      | Bun         | Change |
| ------------------ | ----------------------------------------- | ----------- | ------ |
| Bun-native backend | 1.182 s ± 0.049 (tsx) / 1.228 s (ts-node) | 47 ms ± 10  | 25x    |
| Koa backend on Bun | 1.182 s                                   | 123 ms ± 16 | 9.6x   |

## Results: 4 cores

| Test                     | Node cluster, 4 workers | Bun, one process           | Note                              |
| ------------------------ | ----------------------- | -------------------------- | --------------------------------- |
| req/s, hello route       | **80,740**              | 53,835 native / 41,526 Koa | Node wins on raw throughput here. |
| RSS (idle to after load) | 550 to 578 MB           | 28 to 59 MB                | Bun uses about 1/10 the memory.   |

## Toolchain timings

|                       | Node toolchain  | Bun                    | Change       |
| --------------------- | --------------- | ---------------------- | ------------ |
| Install, cold cache   | `npm ci` 6.11 s | `bun install` 0.44 s   | 13.9x        |
| Install, warm cache   | 3.82 s          | 0.28 s                 | 13.5x        |
| TypeScript build step | `tsc` 3.52 s    | none (Bun runs the TS) | step removed |

CI and the docs still run `npm ci`, even in the Bun CI job, so `bun install` is optional today. Flight's two test suites are different (30 Node tests vs 6 Bun tests), so they are not compared.

## Reproduce

Requirements: Linux, `wrk`, `hyperfine`, Bun, Node, `taskset`. Run `npm ci && npm run build` first. For variant `t`: `npm i --no-save tsx && export TSX_LOADER=$PWD/node_modules/tsx/dist/cjs/index.cjs`.

```bash
# single core, Bun-native route
bench/throughput.sh c 4003 1
# 4-core Node cluster
W=4 bench/throughput.sh t 4004 0-3
# startup
hyperfine --warmup 2 --runs 15 'bench/startup.sh c 4003' 'bench/startup.sh t 4004'
```

`env.sh` defines the server variants. Nothing in it is machine specific. See the header comments in each script for the options.
