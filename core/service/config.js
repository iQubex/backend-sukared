const numberFromEnv = (name, fallback, minimum = 1) => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value >= minimum ? Math.floor(value) : fallback;
};

const SERVICE_LIMITS = Object.freeze({
    jsonBodyBytes: numberFromEnv('SUKARED_MAX_BODY_BYTES', 2 * 1024 * 1024),
    maxSourceBytes: numberFromEnv('SUKARED_MAX_SOURCE_BYTES', 1024 * 1024),
    maxOutputBytes: numberFromEnv('SUKARED_MAX_OUTPUT_BYTES', 8 * 1024 * 1024),
    buildTimeoutMs: numberFromEnv('SUKARED_BUILD_TIMEOUT_MS', 30000),
    workerMemoryMb: numberFromEnv('SUKARED_WORKER_MEMORY_MB', 512, 64),
    concurrency: numberFromEnv('SUKARED_BUILD_CONCURRENCY', 2),
    maxQueueDepth: numberFromEnv('SUKARED_MAX_QUEUE_DEPTH', 8),
    ipRequestsPerMinute: numberFromEnv('SUKARED_IP_RATE_PER_MINUTE', 20),
    accountRequestsPerMinute: numberFromEnv('SUKARED_ACCOUNT_RATE_PER_MINUTE', 60),
    idempotencyTtlMs: numberFromEnv('SUKARED_IDEMPOTENCY_TTL_MS', 24 * 60 * 60 * 1000),
    rateLimiterMaxEntries: numberFromEnv('SUKARED_RATE_LIMIT_MAX_ENTRIES', 100000),
    idempotencyMaxRecords: numberFromEnv('SUKARED_IDEMPOTENCY_MAX_RECORDS', 100000)
});

module.exports = { SERVICE_LIMITS, numberFromEnv };
