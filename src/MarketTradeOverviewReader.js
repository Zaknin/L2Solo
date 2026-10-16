'use strict';

const path = require('path');
const { Worker } = require('worker_threads');
const { createAgeCache } = require('./WorldObserver/AgeCache');
const PopulationConfig = require('./GameServer/Bot/Population/PopulationConfig');

const CACHE_MS = 5000;
// The default overview is shared within CACHE_MS; a timestamp or limit is read fresh.
const overviewCache = createAgeCache(() => request({}), CACHE_MS);
let worker = null;
let databasePath = null;
let nextId = 0;
let workerStats = null;
// The worker's heap as of its last answer (WorkerHeapTelemetry.heapRecord).
let workerHeap = null;
const pending = new Map();

function rejectPending(error) {
    for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(error);
    }
    pending.clear();
    overviewCache.reset();
    worker?.unref();
}

function start(nextPath) {
    if (worker && databasePath === nextPath) return;
    if (worker) worker.terminate();
    rejectPending(new Error('market_overview_database_changed'));
    databasePath = nextPath;
    const instance = new Worker(path.join(__dirname, 'MarketTradeOverviewWorker.js'), {
        workerData: { databasePath, developerDiagnostics: PopulationConfig.developerDiagnostics === true }
    });
    worker = instance;
    workerHeap = null;
    instance.on('message', (message = {}) => {
        if (instance !== worker) return;
        const entry = pending.get(Number(message.id));
        if (!entry) return;
        pending.delete(Number(message.id));
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(message.error));
        else {
            workerStats = message.stats || workerStats;
            workerHeap = message.v8Heap || workerHeap;
            entry.resolve(message.overview);
        }
        if (!pending.size) instance.unref();
    });
    const failed = (error) => {
        if (instance !== worker) return;
        worker = null;
        databasePath = null;
        rejectPending(error);
    };
    instance.on('error', failed);
    instance.on('exit', (code) => failed(new Error(`market_overview_worker_exited:${code}`)));
    instance.unref();
}

function request(options) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error('market_overview_worker_timeout'));
            if (!pending.size) worker?.unref();
        }, 10000);
        timer.unref?.();
        pending.set(id, { resolve, reject, timer });
        worker.ref();
        worker.postMessage({ type: 'overview', id, options });
    });
}

function read(nextPath, options = {}) {
    if (!nextPath) return Promise.reject(new Error('market_overview_database_unavailable'));
    start(String(nextPath));
    const cacheable = options.timestamp == null && options.recentLimit == null;
    return cacheable ? overviewCache() : request(options);
}

// Counters of the worker's window reuse and its heap, as of its last answer.
function stats() { return { ...workerStats, v8Heap: workerHeap }; }

module.exports = { read, stats };
