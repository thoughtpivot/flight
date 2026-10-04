# Changelog

## 3.0.0

### Breaking

- **Vite 8** toolchain: `vite` `^8.3.2`, `@vitejs/plugin-react` `^6.1.1`, `@vitejs/plugin-vue` `^6.0.9`, and `vite-plugin-vuetify` `^2.1.3`. `@vitejs/plugin-react` 6 requires Vite 8 (`vite/internal`). Apps that still pin Vite 6 should stay on `@thoughtpivot/flight@2.0.2` until they upgrade.
- **`ioredis` 6**: requires Node.js 20+ and uses **RESP3** by default. Set `protocol: 2` on the Redis client if a server still needs the ioredis v5 wire protocol.
- **Node engines**: `^20.19.0 || >=22.12.0` (aligned with Vite 8 / ioredis 6).

### Added

- **Bun runtime** (`src/bun`, `flight-bun` / `bun src/bun/server.ts`): `Bun.serve`, `/healthz`, and the same middleware jobs (logging, security headers, CORS, gzip, rate limit, sessions, response cache) on the native Bun path.
- **Koa compatibility on that runtime.** A `*.backend.ts` file may still `export default router.routes()`. Those backends are mounted through Koa and `koa-bodyparser`. Compiled `*.backend.js` files are discovered too.
- **`FLIGHT_TRUST_PROXY` on the Bun rate limiter.** `X-Forwarded-For` is ignored unless the proxy is trusted.
- **`@vitejs/plugin-react`** as a dependency (alongside `@vitejs/plugin-vue`) so React + Vite apps get the same style of transitive plugin coverage as Vue apps.
- Broader Node test coverage for SPA fallback, env flags, rate-limit skips, and backend exclude paths. `npm test` runs every compiled `dist/*.test.js` file.
- GitHub Actions **CI** (`.github/workflows/ci.yml`) and **npm publish** (`.github/workflows/publish.yml`) with provenance. CircleCI is retired.

### Changed

- Dependency majors also include `koa-helmet` 9 and `koa-ratelimit` 6.
- SPA index paths with `..` stay inside the dist root; exclude paths named `..foo` stay inside `app_home`; `.` / app-root excludes warn instead of ignoring everything.

### Notes

- The Node / Koa `flight` binary is unchanged in role. Sessions on Bun stay off until `FLIGHT_SESSION_SECRET` is set. Rate limiting on Bun stays off until `FLIGHT_RATE_LIMIT_MAX` is greater than zero.
- Git changelog entry **2.1.0** below was prepared in-repo but never published to npm; its React + Vite docs/plugin work ships in this 3.0.0 release together with the Vite 8 upgrade.

## 2.1.0

### Added

- **`@vitejs/plugin-react`** as a **dependency** (alongside **`@vitejs/plugin-vue`**), so React + Vite apps that depend on `@thoughtpivot/flight` get the same style of transitive Vite plugin coverage as Vue apps. Install **`react`**, **`react-dom`**, and (for TypeScript) **`@types/react`** / **`@types/react-dom`** in your application; Flight remains the server/runtime, not the UI runtime.

### Documentation

- README: **React + Vite** quick path (sample `vite.config`, `index.html`, `main.tsx`, `App.tsx`), highlights updated for Vue and React, and clarification that **Flight does not pick Vue vs React**—your **`vite.config`** does.

### Changed

- Development log lines refer to the **Vite** dev server generically (Vue/React per app config).

## 2.0.0

### Breaking

- **Production middleware order** when `FLIGHT_MODE` / `mode` is `production` **and** built-assets mode is on (`--disable_vite` or `FLIGHT_DISABLE_VITE` of `true` / `1` / `yes`): Flight now uses the **production SPA pipeline** by default. Static files from `FLIGHT_DIST_PATH` (default `../dist`) and the SPA `index.html` fallback run **immediately after** the Koa `router` (your `**/*.backend.ts` routes), **before** `koa-compress`, Redis-backed rate limiting, and optional response caching.
- **`koa-cash` is off by default** in that SPA pipeline (to avoid caching HTML or mixed `vary` surprises). Enable with **`FLIGHT_HTTP_CACHE=true`** (or `1` / `yes`) if you want the previous Redis-backed cache layer in that configuration.
- **Legacy stack** (previous order: `compress` → `ratelimit` → `koa-cash` → `koa-static` after the router) remains when **either** Vite is **not** disabled in production **or** you set **`FLIGHT_DISABLE_SPA_PIPELINE=true`** (or `1` / `yes`).

### Added

- **Yargs CLI parity** for **`--mode`**, **`--port`**, **`--app_home`**, **`--app_key`**, **`--app_secret`**, **`--payload_limit`**, and **`--disable_vite`** (plus kebab-case aliases), so documented flags populate `argv` reliably instead of being dropped by the parser.
- **`FLIGHT_TRUST_PROXY`**: when `true` / `1` / `yes`, sets `app.proxy = true` so `ctx.ip` and rate-limit identity honor `X-Forwarded-For` behind a reverse proxy or load balancer.
- **`FLIGHT_STATIC_PREFIXES`**: comma-separated URL path prefixes (default `/assets,/fonts`) used to build the **rate-limit skip** list for `GET`/`HEAD` (hashed assets should not burn the API limiter).
- **`FLIGHT_RATE_LIMIT_EXCLUDE_PREFIXES`**: extra comma-separated prefixes merged into that skip list.
- **`FLIGHT_SPA_INDEX`**: path to the SPA shell inside the dist root (default `index.html`).
- **`FLIGHT_SPA_DENY_PREFIXES`**: extra comma-separated path prefixes that never receive the SPA HTML fallback (always merged with `/api` and `/health`).
- **`npm test`**: regression tests for the SPA pipeline (assets, deep links, API prefix, file-like paths).
- **`files` field** in `package.json` so publishes include only `dist/flight.js`, `dist/spa-pipeline.js`, and docs assets.

### Notes

- `FLIGHT_DISABLE_VITE` accepts **`true`**, **`1`**, or **`yes`** (case-sensitive values as implemented for the string checks).
