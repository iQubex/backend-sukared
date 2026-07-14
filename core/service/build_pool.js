const path = require('path');
const { fork } = require('child_process');

const serviceError = (code, message) => Object.assign(new Error(message), { code });

class BuildPool {
    constructor({ concurrency, maxQueueDepth, timeoutMs, memoryMb, maxOutputBytes }) {
        this.concurrency = concurrency;
        this.maxQueueDepth = maxQueueDepth;
        this.timeoutMs = timeoutMs;
        this.memoryMb = memoryMb;
        this.maxOutputBytes = maxOutputBytes;
        this.active = new Map();
        this.queue = [];
        this.sequence = 0;
        this.accepting = true;
        this.metrics = {
            submitted: 0,
            completed: 0,
            failed: 0,
            timedOut: 0,
            cancelled: 0,
            workerCrashes: 0,
            queueRejected: 0,
            peakActive: 0,
            peakQueued: 0
        };
    }

    submit(source, options, { signal } = {}) {
        if (!this.accepting) return Promise.reject(serviceError('SERVICE_DRAINING', 'Build service is draining.'));
        if (this.queue.length >= this.maxQueueDepth) {
            this.metrics.queueRejected += 1;
            return Promise.reject(serviceError('QUEUE_FULL', 'Build queue is full.'));
        }
        return new Promise((resolve, reject) => {
            this.metrics.submitted += 1;
            const task = { id: ++this.sequence, source, options, signal, resolve, reject, state: 'queued' };
            if (signal?.aborted) return reject(serviceError('REQUEST_ABORTED', 'Request was cancelled.'));
            const abort = () => this.cancel(task);
            task.abort = abort;
            signal?.addEventListener('abort', abort, { once: true });
            this.queue.push(task);
            this.metrics.peakQueued = Math.max(this.metrics.peakQueued, this.queue.length);
            this.pump();
        });
    }

    cancel(task) {
        if (task.state === 'queued') {
            this.queue = this.queue.filter(candidate => candidate !== task);
            task.state = 'cancelled';
            this.metrics.cancelled += 1;
            task.reject(serviceError('REQUEST_ABORTED', 'Request was cancelled.'));
        } else if (task.state === 'active') {
            task.state = 'cancelled';
            this.metrics.cancelled += 1;
            task.child?.kill();
            task.reject(serviceError('REQUEST_ABORTED', 'Request was cancelled.'));
        }
    }

    pump() {
        while (this.accepting && this.active.size < this.concurrency && this.queue.length) {
            this.start(this.queue.shift());
        }
    }

    start(task) {
        task.state = 'active';
        const worker = fork(path.join(__dirname, 'build_worker.js'), [], {
            env: { ...process.env, SUKARED_BUILD_WORKER: '1' },
            execArgv: [`--max-old-space-size=${this.memoryMb}`],
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
            windowsHide: true
        });
        task.child = worker;
        this.active.set(task.id, task);
        this.metrics.peakActive = Math.max(this.metrics.peakActive, this.active.size);
        let settled = false;
        const finish = (error, result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            this.active.delete(task.id);
            task.signal?.removeEventListener('abort', task.abort);
            if (task.state !== 'cancelled') {
                task.state = 'done';
                if (error) {
                    this.metrics.failed += 1;
                    if (error.code === 'BUILD_TIMEOUT') this.metrics.timedOut += 1;
                    if (error.code === 'WORKER_CRASH') this.metrics.workerCrashes += 1;
                    task.reject(error);
                } else {
                    this.metrics.completed += 1;
                    task.resolve(result);
                }
            }
            if (worker.connected) worker.disconnect();
            if (!worker.killed) worker.kill();
            this.pump();
        };
        const timer = setTimeout(() => {
            const error = serviceError('BUILD_TIMEOUT', `Build exceeded ${this.timeoutMs} ms.`);
            worker.kill();
            finish(error);
        }, this.timeoutMs);
        worker.on('message', message => {
            if (!message || message.id !== task.id) return;
            if (message.type === 'error') {
                const error = serviceError(message.error.code || 'BUILD_FAILED', message.error.message || 'Build failed.');
                error.stage = message.error.stage;
                if (error.code === 'GOOD_VM_NOT_APPLIED') error.build = message.error.build;
                return finish(error);
            }
            if (message.type === 'result') {
                const outputBytes = Buffer.byteLength(message.result.code || '', 'utf8');
                if (outputBytes > this.maxOutputBytes) {
                    return finish(serviceError('OUTPUT_TOO_LARGE', 'Generated output exceeds the service limit.'));
                }
                return finish(null, message.result);
            }
        });
        worker.on('error', () => finish(serviceError('WORKER_CRASH', 'Build worker crashed.')));
        worker.on('exit', code => {
            if (!settled && task.state !== 'cancelled') {
                finish(serviceError(code === 0 ? 'WORKER_NO_RESULT' : 'WORKER_CRASH', 'Build worker exited unexpectedly.'));
            } else if (task.state === 'cancelled') {
                this.active.delete(task.id);
                this.pump();
            }
        });
        worker.send({ type: 'build', id: task.id, source: task.source, options: task.options });
        task.source = null;
        task.options = null;
    }

    status() {
        return {
            accepting: this.accepting,
            active: this.active.size,
            queued: this.queue.length,
            concurrency: this.concurrency,
            maxQueueDepth: this.maxQueueDepth,
            metrics: { ...this.metrics }
        };
    }

    async drain() {
        this.accepting = false;
        for (const task of this.queue.splice(0)) {
            task.reject(serviceError('SERVICE_DRAINING', 'Build service is draining.'));
        }
        await Promise.all([...this.active.values()].map(task => new Promise(resolve => {
            task.child?.once('exit', resolve);
            task.child?.kill();
        })));
    }
}

module.exports = { BuildPool, serviceError };
