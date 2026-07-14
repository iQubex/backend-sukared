const crypto = require('crypto');

class CreditLedger {
    constructor({ charge = async () => {}, ttlMs = 24 * 60 * 60 * 1000, now = () => Date.now(), maxRecords = 100000 } = {}) {
        this.charge = charge;
        this.ttlMs = ttlMs;
        this.now = now;
        this.records = new Map();
        this.maxRecords = maxRecords;
        this.operations = 0;
    }

    key(accountId, idempotencyKey) {
        return crypto.createHash('sha256').update(`${accountId}\0${idempotencyKey}`).digest('hex');
    }

    begin(accountId, idempotencyKey) {
        const key = this.key(accountId, idempotencyKey);
        this.operations += 1;
        if ((this.operations & 255) === 0 || (!this.records.has(key) && this.records.size >= this.maxRecords)) this.prune();
        const existing = this.records.get(key);
        if (existing?.expiresAt > this.now()) {
            return { key, duplicate: true, committed: existing.status === 'committed' };
        }
        if (this.records.size >= this.maxRecords) {
            const error = new Error('Idempotency ledger capacity reached.');
            error.code = 'IDEMPOTENCY_CAPACITY';
            throw error;
        }
        this.records.set(key, { status: 'pending', expiresAt: this.now() + this.ttlMs });
        return { key, duplicate: false, committed: false, owner: true };
    }

    async commit(transaction, metadata) {
        const record = this.records.get(transaction.key);
        if (!record || record.status === 'committed') return { charged: false, duplicate: true };
        await this.charge(metadata);
        record.status = 'committed';
        record.metadata = {
            buildId: metadata.buildId,
            profile: metadata.profile,
            inputBytes: metadata.inputBytes,
            outputBytes: metadata.outputBytes,
            durationMs: metadata.durationMs,
            runtimeVersion: metadata.runtimeVersion || null
        };
        return { charged: true, duplicate: false };
    }

    abort(transaction) {
        const record = this.records.get(transaction.key);
        if (transaction.owner && record?.status === 'pending') this.records.delete(transaction.key);
    }

    prune() {
        const now = this.now();
        for (const [key, record] of this.records) if (record.expiresAt <= now) this.records.delete(key);
    }
}

module.exports = { CreditLedger };
