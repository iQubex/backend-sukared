class FixedWindowRateLimiter {
    constructor({ limit, windowMs = 60000, now = () => Date.now(), maxEntries = 100000 }) {
        this.limit = limit;
        this.windowMs = windowMs;
        this.now = now;
        this.entries = new Map();
        this.maxEntries = maxEntries;
        this.operations = 0;
    }

    consume(key) {
        const now = this.now();
        this.operations += 1;
        if ((this.operations & 255) === 0 || (!this.entries.has(key) && this.entries.size >= this.maxEntries)) {
            this.prune(now);
        }
        if (!this.entries.has(key) && this.entries.size >= this.maxEntries) {
            return { allowed: false, remaining: 0, retryAfterMs: this.windowMs };
        }
        let entry = this.entries.get(key);
        if (!entry || entry.resetAt <= now) {
            entry = { count: 0, resetAt: now + this.windowMs };
            this.entries.set(key, entry);
        }
        if (entry.count >= this.limit) {
            return { allowed: false, remaining: 0, retryAfterMs: entry.resetAt - now };
        }
        entry.count += 1;
        return { allowed: true, remaining: this.limit - entry.count, retryAfterMs: 0 };
    }

    prune(at = this.now()) {
        for (const [key, entry] of this.entries) if (entry.resetAt <= at) this.entries.delete(key);
    }
}

module.exports = { FixedWindowRateLimiter };
