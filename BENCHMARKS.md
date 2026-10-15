# Flight: Node vs Bun benchmarks

This page records how `flight` (Node, Koa on `node:cluster`) and `flight-bun` (`Bun.serve`) were compared on one commit, and the raw numbers. Scripts and raw output are in [`bench/`](bench/). Run on 2026-10-14.

Read the [caveats](#caveats) before quoting any number. The short version: these are hello-route micro-benchmarks, and on 4 cores a 4-worker Node cluster beat a single `flight-bun` process.

## What was compared

|                               | Version | Commit    |
| ----------------------------- | ------- | --------- |
| Flight `@thoughtpivot/flight` | 3.0.0   | `b0d8689` |

- **Node side (before):** `flight` is Koa on `node:cluster`, built to `dist/flight.js` by `tsc`. The `*.backend.ts` files are loaded through [tsx](https://tsx.is) (the loader the README names). A ts-node variant was also run.
- **Bun side (after):** `flight-bun` is `Bun.serve`, running `src/bun/server.ts` directly as TypeScript.

## Environment

- 8 vCPU Intel Xeon VM, 15 GB RAM, Debian 13, kernel 6.12. It was a shared VM with other processes running, so expect some noise.
- Node 20.19.2, Bun 1.4.2, wrk 4.1.0 (load), hyperfine 1.19.0 (timing).
- Redis and Postgres were not used by Flight in these runs. Flight kept sessions and cache in memory.

## Method

- **Single-core runs:** the server is pinned to one core with `taskset`. wrk runs on cores 4-7 with `-t4 -c100`.
- **One Node worker:** the Node cluster is held to one worker with `FLIGHT_MAX_WORKERS=1`. The primary process still runs, as it does in production.
- **4-core runs:** the server is pinned to cores 0-3. Node runs 4 workers (`FLIGHT_MAX_WORKERS=4`). `flight-bun` stays its shipped single process.
- **Each throughput row:** a 10 s warmup, then three 20 s runs. The mean of the three is reported. No non-2xx responses or socket errors were seen in any run.
- **Memory:** RSS of the whole server process tree (Node: primary plus workers), taken at idle after one request and again after load.
- **Startup:** time from exec to the first HTTP 200 on `/api/hello`, measured with hyperfine (2 warmups, 15 runs).

### Workload

`GET /api/hello` returns `{"message":"Hello from Flight!"}`. Three variants:

- (a) Node/Koa: `router.routes()` backend ([`apps/koa`](bench/apps/koa/api/hello.backend.ts)).
- (b) the **same Koa file** on `flight-bun`, through its Koa-compat layer.
- (c) a Bun-native route-map backend on `flight-bun` ([`apps/native`](bench/apps/native/api/hello.backend.ts)).

Middleware is each runtime's shipped default for a non-dev, non-production mode. Node runs koa-logger (it cannot be turned off, and its output went to `/dev/null`), session, CORS and bodyparser. Bun runs security headers, CORS and compression, and does not log by default. Neither side rate-limits. The two stacks are therefore not identical, and this is not a measure of Koa vs Bun.Serve in isolation.

## Results: single core (per-core efficiency)

| Test                                   | Node                                                               | Bun                          | Change                       |
| -------------------------------------- | ------------------------------------------------------------------ | ---------------------------- | ---------------------------- |
| Requests/s, Bun-native route           | 19,651 (tsx) / 19,342 (ts-node)                                    | **61,110**                   | **3.1x**                     |
| Requests/s, unchanged Koa route on Bun | 19,651                                                             | **38,826**                   | **2.0x**                     |
| p50 / p99 latency (native)             | 4.6-5.0 ms / 10-25 ms                                              | 1.5-1.6 ms / 2.9-3.0 ms      |                              |
| p99 latency (Koa on Bun)               | 10-25 ms                                                           | 6.3-7.2 ms                   |                              |
| Idle RSS                               | 218 MB (primary + 1 worker, tsx; the worker alone is about 112 MB) | **27 MB** native / 47 MB Koa | about 8x less (process tree) |
| RSS after load                         | 206 MB                                                             | 62 MB native / 66 MB Koa     |                              |

The ts-node p99 on its first run was 44.6 ms, which is why the Node p99 range is wide. See [`bench/results/`](bench/results/).

## Results: startup to first 200 (hyperfine, 15 runs)

|                    | Node                                      | Bun             | Change   |
| ------------------ | ----------------------------------------- | --------------- | -------- |
| Bun-native backend | 1.182 s ± 0.049 (tsx) / 1.228 s (ts-node) | **47 ms ± 10**  | **25x**  |
| Koa backend on Bun | 1.182 s                                   | **123 ms ± 16** | **9.6x** |

## Results: 4 cores

| Test                        | Node cluster, 4 workers | Bun, one process           | Note                                                                                                                      |
| --------------------------- | ----------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Requests/s, hello route     | **80,740**              | 53,835 native / 41,526 Koa | **Node wins on raw throughput here.** `flight-bun` is one process and cannot use 4 cores the way a 4-worker cluster does. |
| RSS (idle, then after load) | 550 MB, then 578 MB     | 28 MB, then 59 MB          | Bun uses about 1/10 the memory                                                                                            |

Single-core numbers measure per-core efficiency. They do not mean `flight-bun` is faster than a Node cluster on the same machine. Until `flight-bun` can run on several cores in one deployment, scale it with replicas. Multi-core support is tracked in [THO-257](https://linear.app/thoughtpivot/issue/THO-257/make-flight-bun-multi-core-capable-workers-shared-state-graceful).

## Toolchain timings

|                       | Node toolchain  | Bun                    | Change       |
| --------------------- | --------------- | ---------------------- | ------------ |
| Install, cold cache   | `npm ci` 6.11 s | `bun install` 0.44 s   | 13.9x        |
| Install, warm cache   | `npm ci` 3.82 s | `bun install` 0.28 s   | 13.5x        |
| TypeScript build step | `tsc` 3.52 s    | none (Bun runs the TS) | step removed |

- CI and the docs still use `npm ci`, even in the Bun CI job. `bun install` is optional today.
- Flight's two test suites are different (30 Node tests vs 6 Bun tests), so their run times are in `bench/results/tests-flight.json` but are **not** compared.

## Caveats

- **Micro-benchmark.** One `GET /api/hello` route that returns a small JSON object. There is no database, no static files, no sessions in Redis, no rate limiting and no real SPA. Real apps spend their time elsewhere, and gains will be smaller.
- **Single process vs cluster.** The headline 3.1x is one core against one core. On 4 cores, a 4-worker Node cluster served **80.7k req/s against 53.8k** for a single `flight-bun` process.
- **Shared VM.** The runs were on a shared 8 vCPU VM, so there is some noise. Run-to-run spread is visible in the raw files (for example Node p99 of 10-25 ms).
- **Middleware differs.** Each runtime ran its own shipped default stack, and the two are not identical (see Workload).
- **Versions.** Bun 1.4.2 was used locally. CI pins 1.4.3.
- **Not measured:** an end-to-end app (Flight to Scribe to Postgres, with a real SPA), several `flight-bun` processes behind `reusePort` or replicas against a Node cluster on the same cores, container image size and Kubernetes cold start, production-mode Flight with compression, Redis sessions, rate limiting and static SPA serving on both sides, and long soak memory growth.
- If you get different numbers on your own hardware, please open an issue with your results.

## Reproduce

The scripts have no machine-specific paths. They need Linux with `taskset`, `ss`, [wrk](https://github.com/wg/wrk), [hyperfine](https://github.com/sharkdp/hyperfine) and Bun. They start servers on ports 4001-4004.

```bash
npm ci && npm run build            # builds dist/ for the Node variants
npm i --no-save tsx                # tsx loader for the Node variant
export TSX_LOADER=$PWD/node_modules/tsx/dist/cjs/index.cjs
# export BUN=/path/to/bun          # optional, defaults to `bun` on PATH

# single core, Node/Koa (tsx), Koa on Bun, Bun-native
bench/throughput.sh t 4004 1
bench/throughput.sh b 4002 1
bench/throughput.sh c 4003 1

# 4 cores
W=4 bench/throughput.sh t 4004 0-3
bench/throughput.sh c 4003 0-3

# startup to first 200
hyperfine --warmup 2 --runs 15 'bench/startup.sh t 4004' 'bench/startup.sh c 4003'
```

For a quick check that the scripts run, shorten the load with `WARMUP_SECS=2 RUN_SECS=3 RUNS=1`. The published numbers use the defaults (10 s warmup, three 20 s runs).

| Raw output                                      | File in [`bench/results/`](bench/results/)                                                                              |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1 core, Node/Koa (tsx), Node/Koa (ts-node)      | `single-core-node-koa-tsx.txt`, `single-core-node-koa-ts-node.txt`                                                      |
| 1 core, Koa on Bun, Bun-native                  | `single-core-bun-koa-compat.txt`, `single-core-bun-native.txt`                                                          |
| 4 cores, Node cluster, Koa on Bun, Bun-native   | `four-core-node-cluster-4-workers.txt`, `four-core-bun-koa-compat.txt`, `four-core-bun-native.txt`                      |
| Startup, build, install, tests (hyperfine JSON) | `startup-hyperfine.json`, `build-hyperfine.json`, `inst-flight-cold.json`, `inst-flight-warm.json`, `tests-flight.json` |

In the throughput files each line is one 20 s run (`Requests/sec`, p50 and p99 latency), plus `idle_rss_kb` and `post_load_rss_kb` for the process tree.

## Follow-ups

- [THO-257](https://linear.app/thoughtpivot/issue/THO-257/make-flight-bun-multi-core-capable-workers-shared-state-graceful): make `flight-bun` multi-core capable (workers, shared state, graceful shutdown), so it can match the Node cluster on 4 and 8 cores.
- The sibling benchmark for Scribe is in [thoughtpivot/scribe](https://github.com/thoughtpivot/scribe/blob/master/BENCHMARKS.md).

## Prior research

Vasilen Lubomirov ([@VasilenL](https://github.com/VasilenL)) did earlier research on running Flight and Scribe on Bun, in [flight-scribe-setup](https://github.com/VasilenL/flight-scribe-setup), [flight-bun](https://github.com/VasilenL/flight-bun) and [scribe-bun](https://github.com/VasilenL/scribe-bun). It was run on separate prototypes and hardware, so its numbers are not comparable with the ones on this page, and none of them are used here. Thank you, Vaso.
