'use strict';
// PopulationStatus.heaps(): every isolate's V8 record read from the owner (or the record the caller holds),
// null before a thread reported, and the summary-line form with '-' for those.
const assert = require('node:assert/strict');
require('../src/Global');
const Status = invoke('GameServer/Bot/Population/PopulationStatus');
const { heapsLine } = require('../src/GameServer/Bot/Population/WorkerHeapTelemetry');
const ClanPlanningCoordinator = invoke('GameServer/Clan/ClanPlanningCoordinator');
const MarketTradeOverviewReader = invoke('MarketTradeOverviewReader');

const record = (used, afterGc) => ({ used, total: used + 1, external: used + 2, limit: used + 3,
    ...(afterGc ? { afterGc, afterGcMax: afterGc + 5 } : {}) });
const originals = { metrics: ClanPlanningCoordinator.metrics, stats: MarketTradeOverviewReader.stats };
try {
    // Diagnostics off (or nothing reported yet): every worker entry is null and prints '-'.
    ClanPlanningCoordinator.metrics = () => ({ enabled: false });
    MarketTradeOverviewReader.stats = () => ({ v8Heap: null });
    const quiet = Status.heaps({ coldWorker: {}, history: {}, checkpoint: { diagnosticsEnabled: false }, pathWorkers: {} });
    assert.deepEqual(Object.keys(quiet), ['main', 'cold', 'clan', 'history', 'checkpoint', 'market']);
    for (const [name, heap] of Object.entries(quiet)) if (name !== 'main') assert.equal(heap, null, name);
    assert(Number.isFinite(quiet.main.used) && Number.isFinite(quiet.main.limit));
    assert.match(heapsLine(quiet), /,cold:-,clan:-,history:-,checkpoint:-,market:-$/);

    // Reported records pass through from the owners; path workers are numbered by pool slot.
    ClanPlanningCoordinator.metrics = () => ({ v8Heap: record(30) });
    MarketTradeOverviewReader.stats = () => ({ v8Heap: record(40) });
    const heaps = Status.heaps({ coldWorker: { v8Heap: record(10, 8), heap: 7 }, history: { v8Heap: record(20) },
        checkpoint: { v8Heap: record(50) }, pathWorkers: { v8Heaps: [record(60), null] } });
    assert.deepEqual({ ...heaps, main: null }, { main: null, cold: record(10, 8), clan: record(30), history: record(20),
        checkpoint: record(50), market: record(40), path0: record(60), path1: null });
    assert.match(heapsLine(heaps), /,cold:10\/11\/12\/13\/8\/13,clan:30\/31\/32\/33\/-\/-,history:20\/21\/22\/23\/-\/-,checkpoint:50\/51\/52\/53\/-\/-,market:40\/41\/42\/43\/-\/-,path0:60\/61\/62\/63\/-\/-,path1:-$/);
    console.log('PopulationStatus.heaps merges the owners records; unreported threads are null and print -');
} finally {
    ClanPlanningCoordinator.metrics = originals.metrics;
    MarketTradeOverviewReader.stats = originals.stats;
}
