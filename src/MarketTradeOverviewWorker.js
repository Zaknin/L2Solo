'use strict';

const { parentPort, workerData } = require('worker_threads');
const { DatabaseSync } = require('node:sqlite');
const MarketTradeOverview = require('./MarketTradeOverview');
const MarketEconomyOverview = require('./MarketEconomyOverview');
const { heapRecord, observe } = require('./GameServer/Bot/Population/WorkerHeapTelemetry');
if (workerData.developerDiagnostics) observe(); // major-GC window for the v8Heap record (WorkerHeapTelemetry)

const connection = new DatabaseSync(String(workerData.databasePath), { readOnly: true, timeout: 250 });
const all = (sql, params = []) => connection.prepare(sql).all(...params);

// The week scan of the default overview is reused (the hourly journal is read
// fresh): while no trade was added and the window start has moved less than
// WINDOWS_MAX_MS, or whatever the age under WINDOWS_FRESH_MS. The recent
// trades change only with a new trade (the tail) or a deletion: they are read
// again when the tail moves and with every week scan. Overviews at a given
// timestamp or limit are read whole.
const WINDOWS_FRESH_MS = 15000;
const WINDOWS_MAX_MS = 60000;
let memo = null;
const stats = { windowBuilds: 0, windowReuses: 0, recentBuilds: 0, recentReuses: 0 };

function overview(options = {}) {
    if (options.timestamp != null || options.recentLimit != null) {
        return { ...MarketTradeOverview.fetch(all, options), economy: MarketEconomyOverview.fetch(all, options) };
    }
    const tail = MarketTradeOverview.tailId(all);
    const age = memo ? Date.now() - memo.at : Infinity;
    if (!memo || age >= WINDOWS_MAX_MS || (age >= WINDOWS_FRESH_MS && tail !== memo.tail)) {
        memo = { at: Date.now(), tail, windows: MarketTradeOverview.fetchWindows(all), recentTail: null, recent: null };
        stats.windowBuilds += 1;
    } else stats.windowReuses += 1;
    if (memo.recentTail !== tail) {
        memo.recent = MarketTradeOverview.fetchRecent(all);
        memo.recentTail = tail;
        stats.recentBuilds += 1;
    } else stats.recentReuses += 1;
    return {
        scope: 'persistent_90d',
        retentionDays: 90,
        windows: memo.windows.windows,
        recent: memo.recent,
        byItem: memo.windows.byItem,
        byTown: memo.windows.byTown,
        economy: MarketEconomyOverview.fetch(all)
    };
}

parentPort.on('message', (message = {}) => {
    if (message.type !== 'overview') return;
    try {
        parentPort.postMessage({ id: message.id, overview: overview(message.options), stats: { ...stats },
            ...(workerData.developerDiagnostics ? { v8Heap: heapRecord() } : {}) });
    } catch (error) {
        parentPort.postMessage({ id: message.id, error: error?.message || String(error) });
    }
});
