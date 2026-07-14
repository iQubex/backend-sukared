class OperationalTelemetry {
    constructor({ maxEvents = 10000, now = () => Date.now() } = {}) {
        this.maxEvents = maxEvents;
        this.now = now;
        this.events = [];
    }

    record(event = {}) {
        const safe = Object.freeze({
            timestamp: this.now(),
            buildId: event.buildId || null,
            profile: event.profile || 'unknown',
            sourceBytes: Number(event.sourceBytes) || 0,
            outputBytes: Number(event.outputBytes) || 0,
            durationMs: Number(event.durationMs) || 0,
            code: String(event.code || 'UNKNOWN').slice(0, 64),
            fallbackCount: Number(event.fallbackCount) || 0,
            runtimeVersion: event.runtimeVersion || null
        });
        this.events.push(safe);
        if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
        return safe;
    }

    snapshot() {
        return this.events.map(event => ({ ...event }));
    }
}

module.exports = { OperationalTelemetry };
