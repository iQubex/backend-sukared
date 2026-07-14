const assert = require('assert');
const { once } = require('events');
const { app, getBuildPool, creditLedger, telemetry, SERVICE_LIMITS, publicErrorFor } = require('./server');
const { BuildPool } = require('./core/service/build_pool');
const { CreditLedger } = require('./core/service/credit_ledger');
const { FixedWindowRateLimiter } = require('./core/service/rate_limiter');

const withServer = async callback => {
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try { return await callback(`http://127.0.0.1:${server.address().port}`); }
    finally { await new Promise(resolve => server.close(resolve)); }
};

const post = (base, body, headers = {}) => fetch(`${base}/obfuscate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
});

(async () => {
    const telemetryStart = telemetry.snapshot().length;
    const serviceResults = await withServer(async base => {
        const healthResponse = await fetch(`${base}/health`);
        const health = await healthResponse.json();
        assert.strictEqual(healthResponse.status, 200);
        assert.strictEqual(health.version, 'SukaRed 1.0');
        assert.strictEqual(health.profiles.hell.available, false);
        const serializedHealth = JSON.stringify(health);
        for (const forbidden of ['hellPreparation', 'stack', 'sourceContext', 'C:\\', '/Users/']) {
            assert(!serializedHealth.includes(forbidden), `health leaked ${forbidden}`);
        }

        const readyResponse = await fetch(`${base}/ready`);
        const readiness = await readyResponse.json();
        assert.strictEqual(readyResponse.status, 200);
        assert.strictEqual(readiness.status, 'ready');

        const invalidProfile = await post(base, { code: 'print(1)', profile: 'unknown' });
        assert.strictEqual(invalidProfile.status, 400);
        assert.strictEqual((await invalidProfile.json()).code, 'PROFILE_INVALID');

        const malformed = await fetch(`${base}/obfuscate`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad'
        });
        assert.strictEqual(malformed.status, 400);
        assert.strictEqual((await malformed.json()).code, 'INVALID_JSON');

        const oversized = await post(base, { code: `-- large\n${'x'.repeat(SERVICE_LIMITS.maxSourceBytes + 1)}`, profile: 'light' });
        assert.strictEqual(oversized.status, 413);
        assert.strictEqual((await oversized.json()).code, 'SOURCE_TOO_LARGE');

        const badSourceText = 'local function private_secret_9281('; 
        const failed = await post(base, { code: badSourceText, profile: 'light' });
        const failedPayload = await failed.json();
        assert.strictEqual(failed.status, 422);
        assert.strictEqual(failedPayload.code, 'BUILD_FAILED');
        const publicFailure = JSON.stringify(failedPayload);
        for (const forbidden of ['private_secret_9281', 'stack', 'context', 'Backend\\', 'ast_traverser']) {
            assert(!publicFailure.includes(forbidden), `public error leaked ${forbidden}`);
        }

        const headers = { 'x-account-id': 'service-test', 'x-idempotency-key': 'same-build-key' };
        const source = 'local function add(a,b) return a+b end print(add(2,3))';
        const first = await post(base, { code: source, profile: 'good' }, headers);
        const firstPayload = await first.json();
        assert.strictEqual(first.status, 200, JSON.stringify(firstPayload));
        assert.strictEqual(firstPayload.billing.charged, true);
        const second = await post(base, { code: source, profile: 'good' }, headers);
        const secondPayload = await second.json();
        assert.strictEqual(second.status, 200, JSON.stringify(secondPayload));
        assert.strictEqual(secondPayload.billing.charged, false);
        assert.strictEqual(secondPayload.billing.idempotentReplay, true);

        const concurrentBuilds = await Promise.all(Array.from({ length: 4 }, (_, index) => post(base, {
            code: `local function value_${index}(x) return x + ${index} end print(value_${index}(1))`,
            profile: 'good'
        }, {
            'x-account-id': `load-account-${index}`,
            'x-idempotency-key': `load-build-${index}`
        })));
        const concurrentPayloads = await Promise.all(concurrentBuilds.map(response => response.json()));
        concurrentBuilds.forEach((response, index) => assert.strictEqual(response.status, 200, JSON.stringify(concurrentPayloads[index])));
        const loadStatus = getBuildPool().status();
        assert(loadStatus.metrics.peakActive <= SERVICE_LIMITS.concurrency);
        assert(loadStatus.metrics.peakActive >= 2, 'API load did not exercise configured concurrency');
        assert(loadStatus.metrics.completed >= 6);

        return {
            health,
            readiness,
            firstBuild: firstPayload.build.buildId,
            load: {
                requests: concurrentBuilds.length,
                peakActive: loadStatus.metrics.peakActive,
                completed: loadStatus.metrics.completed,
                queueRejected: loadStatus.metrics.queueRejected
            }
        };
    });

    let charged = 0;
    const ledger = new CreditLedger({ charge: async () => { charged += 1; } });
    const transaction = ledger.begin('account', 'idempotency');
    ledger.abort(transaction);
    assert.strictEqual(charged, 0, 'failed transaction consumed credit');
    const success = ledger.begin('account', 'idempotency');
    await ledger.commit(success, { buildId: 'b1', profile: 'good', inputBytes: 1, outputBytes: 2, durationMs: 3 });
    const replay = ledger.begin('account', 'idempotency');
    await ledger.commit(replay, { buildId: 'b1', profile: 'good', inputBytes: 1, outputBytes: 2, durationMs: 3 });
    assert.strictEqual(charged, 1, 'idempotent retry charged twice');
    assert(!JSON.stringify([...ledger.records.values()]).includes('print('), 'ledger retained source');

    let now = 0;
    const limiter = new FixedWindowRateLimiter({ limit: 2, windowMs: 1000, now: () => now });
    assert(limiter.consume('ip').allowed);
    assert(limiter.consume('ip').allowed);
    assert(!limiter.consume('ip').allowed);
    now = 1001;
    assert(limiter.consume('ip').allowed);
    const boundedLimiter = new FixedWindowRateLimiter({ limit: 1, maxEntries: 2 });
    assert(boundedLimiter.consume('a').allowed);
    assert(boundedLimiter.consume('b').allowed);
    assert.strictEqual(boundedLimiter.consume('c').allowed, false, 'rate limiter exceeded bounded storage');

    const boundedLedger = new CreditLedger({ maxRecords: 1 });
    boundedLedger.begin('account', 'first');
    assert.throws(() => boundedLedger.begin('account', 'second'), error => error.code === 'IDEMPOTENCY_CAPACITY');

    const isolationPool = new BuildPool({ concurrency: 1, maxQueueDepth: 1, timeoutMs: 10000, memoryMb: 96, maxOutputBytes: 1024 * 1024 });
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const firstTask = isolationPool.submit('local function f() return 1 end print(f())', { profile: 'light' }, { signal: controllerA.signal });
    firstTask.catch(() => {});
    const secondTask = isolationPool.submit('print(2)', { profile: 'light' }, { signal: controllerB.signal });
    secondTask.catch(() => {});
    await assert.rejects(() => isolationPool.submit('print(3)', { profile: 'light' }), error => error.code === 'QUEUE_FULL');
    controllerA.abort();
    controllerB.abort();
    await Promise.allSettled([firstTask, secondTask]);
    await isolationPool.drain();

    const timeoutPool = new BuildPool({ concurrency: 1, maxQueueDepth: 1, timeoutMs: 1, memoryMb: 96, maxOutputBytes: 1024 * 1024 });
    await assert.rejects(() => timeoutPool.submit('print(1)', { profile: 'light' }), error => error.code === 'BUILD_TIMEOUT');
    await timeoutPool.drain();

    const restartPool = new BuildPool({ concurrency: 1, maxQueueDepth: 1, timeoutMs: 10000, memoryMb: 96, maxOutputBytes: 1024 * 1024 });
    const crashing = restartPool.submit('print(1)', { profile: 'light' });
    await new Promise(resolve => {
        const wait = () => {
            const task = [...restartPool.active.values()][0];
            if (task?.child) {
                task.child.kill();
                resolve();
            } else setTimeout(wait, 1);
        };
        wait();
    });
    await assert.rejects(() => crashing, error => error.code === 'WORKER_CRASH');
    const recovered = await restartPool.submit('print(2)', { profile: 'light' });
    assert(recovered.code, 'replacement worker did not produce output');
    const restartStatus = restartPool.status();
    assert.strictEqual(restartStatus.metrics.workerCrashes, 1);
    assert.strictEqual(restartStatus.metrics.completed, 1);
    assert(restartStatus.metrics.peakActive <= 1);
    await restartPool.drain();

    const retained = JSON.stringify([...creditLedger.records.values()]);
    assert(!retained.includes('private_secret_9281'));
    const telemetryEvents = telemetry.snapshot().slice(telemetryStart);
    assert(telemetryEvents.length >= 7, 'build telemetry did not record success and failure outcomes');
    const allowedTelemetryFields = new Set([
        'timestamp', 'buildId', 'profile', 'sourceBytes', 'outputBytes', 'durationMs',
        'code', 'fallbackCount', 'runtimeVersion'
    ]);
    for (const event of telemetryEvents) {
        assert(Object.keys(event).every(key => allowedTelemetryFields.has(key)), 'telemetry stored a forbidden field');
    }
    const serializedTelemetry = JSON.stringify(telemetryEvents);
    for (const forbidden of ['private_secret_9281', 'local function add', 'obfuscated', 'same-build-key', 'service-test']) {
        assert(!serializedTelemetry.includes(forbidden), `telemetry retained ${forbidden}`);
    }
    assert.strictEqual(publicErrorFor({ code: 'BUILD_TIMEOUT' }).payload.suggestion,
        'Try the Good, Light+, or Light profile.');
    console.log(JSON.stringify({
        serviceResults,
        workerIsolation: {
            memoryMb: isolationPool.memoryMb,
            queueLimit: isolationPool.maxQueueDepth,
            restartPassed: true,
            peakActive: restartStatus.metrics.peakActive,
            passed: true
        },
        privacy: { sourceRetained: false, generatedOutputRetained: false, telemetryEvents: telemetryEvents.length },
        creditIdempotency: { chargeCount: charged, passed: true }
    }, null, 2));
    console.log('SukaRed service hardening tests passed');
})().catch(async error => {
    console.error(error.stack || error.message);
    try { await getBuildPool().drain(); } catch (_) { /* best effort test cleanup */ }
    process.exitCode = 1;
});
