#!/usr/bin/env bash
# Source this file: `source bench/env.sh`. It defines the server variants that
# throughput.sh and startup.sh start. Nothing here is machine specific:
#   FLIGHT_REPO  repo root (default: parent of this folder)
#   BUN          Bun executable (default: `bun` on PATH). If your `bun` is a launcher script
#                that spawns a child, point BUN at the real binary so RSS and kill hit the right process.
#   TSX_LOADER   path to tsx's CJS loader, only needed for variant "t":
#                npm i --no-save tsx && export TSX_LOADER=$PWD/node_modules/tsx/dist/cjs/index.cjs
BENCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export BENCH_DIR
export FLIGHT_REPO="${FLIGHT_REPO:-$(cd "$BENCH_DIR/.." && pwd)}"
export BUN="${BUN:-$(command -v bun)}"

# a: Node + Koa, backends loaded through ts-node (transpile-only). Needs `npm run build` first.
start_a() { cd "$BENCH_DIR/apps/koa" && TS_NODE_PROJECT=./tsconfig.json FLIGHT_MAX_WORKERS="${W:-1}" FLIGHT_MODE=bench FLIGHT_PORT=4001 \
  exec node -r "$FLIGHT_REPO/node_modules/ts-node/register/transpile-only" "$FLIGHT_REPO/dist/flight.js"; }
# b: flight-bun running the same Koa file through its Koa-compat layer
start_b() { cd "$BENCH_DIR/apps/koa" && FLIGHT_PORT=4002 exec "$BUN" "$FLIGHT_REPO/src/bun/server.ts"; }
# c: flight-bun with a Bun-native route-map backend
start_c() { cd "$BENCH_DIR/apps/native" && FLIGHT_PORT=4003 exec "$BUN" "$FLIGHT_REPO/src/bun/server.ts"; }
# t: Node + Koa, backends loaded through tsx (the loader the README names)
start_t() { cd "$BENCH_DIR/apps/koa" && FLIGHT_MAX_WORKERS="${W:-1}" FLIGHT_MODE=bench FLIGHT_PORT=4004 \
  exec node --require "$TSX_LOADER" "$FLIGHT_REPO/dist/flight.js"; }
