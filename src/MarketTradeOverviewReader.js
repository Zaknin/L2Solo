'use strict';

const path = require('path');
const { Worker } = require('worker_threads');

const CACHE_MS = 5000;
let worker = null;
let databasePath = null;
let nextId = 0;
let cache = null;
let cacheAt = 0;
let inFlight = null;
let workerStats = null;
const pending = new Map();

function rejectPending(error) {
    for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(error);
    }
    pending.clear();
    inFlight = null;
    worker?.unref();
}

function start(nextPath) {
    if (worker && databasePath === nextPath) return;
    if (worker) worker.terminate();
    rejectPending(new Error('market_overview_database_changed'));
    cache = null;
    cacheAt = 0;
    databasePath = nextPath;
    const instance = new Worker(path.join(__dirname, 'MarketTradeOverviewWorker.js'), {
        workerData: { databasePath }
    });
    worker = instance;
    instance.on('message', (message = {}) => {
        if (instance !== worker) return;
        const entry = pending.get(Number(message.id));
        if (!entry) return;
        pending.delete(Number(message.id));
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(message.error));
        else {
            workerStats = message.stats || workerStats;
            entry.resolve(message.overview);
        }
        if (!pending.size) instance.unref();
    });
    const failed = (error) => {
        if (instance !== worker) return;
        worker = null;
        databasePath = null;
        cache = null;
        rejectPending(error);
    };
    instance.on('error', failed);
    instance.on('exit', (code) => failed(new Error(`market_overview_worker_exited:${code}`)));
    instance.unref();
}

function read(nextPath, options = {}) {
    if (!nextPath) return Promise.reject(new Error('market_overview_database_unavailable'));
    start(String(nextPath));
    const cacheable = options.timestamp == null && options.recentLimit == null;
    if (cacheable && cache && Date.now() - cacheAt < CACHE_MS) return Promise.resolve(cache);
    if (cacheable && inFlight) return inFlight;
    const id = ++nextId;
    const request = new Promise((resolve, reject) => {
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
    if (!cacheable) return request;
    const job = request.then((result) => {
        cache = result;
        cacheAt = Date.now();
        return result;
    }).finally(() => { if (inFlight === job) inFlight = null; });
    inFlight = job;
    return job;
}

// Counters of the worker's window reuse, as of its last answer.
function stats() { return { ...workerStats }; }

module.exports = { read, stats };
