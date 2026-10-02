/** Key/value store shared by sessions and the response cache. */
export interface KVStore {
    get(key: string): Promise<string | null>
    set(key: string, value: string, ttlSec: number): Promise<void>
    del(key: string): Promise<void>
}

/**
 * In-process store used when Redis is unset or unreachable.
 */
class MemoryStore implements KVStore {
    private entries = new Map<string, { value: string; exp: number }>()

    /** Read a value, dropping it when the TTL has passed. */
    async get(key: string): Promise<string | null> {
        const entry = this.entries.get(key)
        if (!entry) return null
        if (entry.exp && entry.exp < Date.now()) {
            this.entries.delete(key)
            return null
        }
        return entry.value
    }

    /** Store a value. A non-positive TTL means no expiry. */
    async set(key: string, value: string, ttlSec: number): Promise<void> {
        this.entries.set(key, { value, exp: ttlSec > 0 ? Date.now() + ttlSec * 1000 : 0 })
    }

    /** Remove a key. */
    async del(key: string): Promise<void> {
        this.entries.delete(key)
    }
}

/**
 * Bun's built-in Redis client. Typed loosely because the surface varies by Bun version.
 */
class RedisStore implements KVStore {
    constructor(private client: any) {}

    /** Read a Redis string. */
    async get(key: string): Promise<string | null> {
        return await this.client.get(key)
    }

    /** Write a Redis string with an optional EX expiry. */
    async set(key: string, value: string, ttlSec: number): Promise<void> {
        if (ttlSec > 0) await this.client.send('SET', [key, value, 'EX', String(ttlSec)])
        else await this.client.set(key, value)
    }

    /** Delete a Redis key. */
    async del(key: string): Promise<void> {
        await this.client.del(key)
    }
}

/**
 * Use Redis until a command fails, then stay on the in-memory store.
 */
class FallbackStore implements KVStore {
    private degraded = false

    constructor(
        private primary: KVStore,
        private fallback: KVStore,
        private label: string
    ) {}

    /** Log the first Redis failure and switch to memory. */
    private trip(err: unknown) {
        if (this.degraded) return
        this.degraded = true
        const message = err instanceof Error ? err.message : String(err)
        console.warn(`flight-bun: ${this.label} store degraded to in-memory (Redis error): ${message}`)
    }

    /** Read from Redis, or from memory after a failure. */
    async get(key: string): Promise<string | null> {
        if (this.degraded) return this.fallback.get(key)
        try {
            return await this.primary.get(key)
        } catch (err) {
            this.trip(err)
            return this.fallback.get(key)
        }
    }

    /** Write to Redis, or to memory after a failure. */
    async set(key: string, value: string, ttlSec: number): Promise<void> {
        if (this.degraded) return this.fallback.set(key, value, ttlSec)
        try {
            await this.primary.set(key, value, ttlSec)
        } catch (err) {
            this.trip(err)
            await this.fallback.set(key, value, ttlSec)
        }
    }

    /** Delete from Redis, or from memory after a failure. */
    async del(key: string): Promise<void> {
        if (this.degraded) return this.fallback.del(key)
        try {
            await this.primary.del(key)
        } catch (err) {
            this.trip(err)
            await this.fallback.del(key)
        }
    }
}

/**
 * Redis when `FLIGHT_REDIS_URL` is set, otherwise memory.
 * A down Redis degrades the request instead of failing it.
 */
export function createStore(redisUrl: string | undefined, label: string): KVStore {
    const memory = new MemoryStore()
    if (!redisUrl) return memory
    try {
        const client = new Bun.RedisClient(redisUrl)
        return new FallbackStore(new RedisStore(client), memory, label)
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.warn(`flight-bun: ${label} store could not init Redis, using in-memory: ${message}`)
        return memory
    }
}
