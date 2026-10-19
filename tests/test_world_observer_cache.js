const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('../src/Global');
invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics = true;

const World = invoke('GameServer/World/World');
const Observer = invoke('WorldObserver/WorldObserverServer');
const PlayerActivitySignal = invoke('GameServer/Bot/Population/PlayerActivitySignal');
const ColdCoordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');

const originalUser = World.user;
try {
    PlayerActivitySignal.reset();
    World.user = { sessions: [] };
    assert.strictEqual(Observer.observerCacheTtl(1000), 2000,
        'idle observer snapshots may refresh frequently');

    const player = {
        accountId: 'observer_player',
        actor: { fetchIsOnline: () => true }
    };
    World.user.sessions = [player];
    assert.strictEqual(Observer.observerCacheTtl(2000), 30000,
        'a real player must increase observer snapshot reuse');

    const companion = {
        accountId: 'bot_observer_companion',
        actor: { fetchIsOnline: () => true },
        partyCompanion: true,
        followPlayerSession: player
    };
    World.user.sessions.push(companion);
    assert.strictEqual(Observer.observerCacheTtl(3000), 30000,
        'an active player party must maximize observer snapshot reuse');

    World.user.sessions = [];
    assert.strictEqual(Observer.observerCacheTtl(10000), 30000,
        'disconnect grace must keep the protected observer policy');
    assert.strictEqual(Observer.observerCacheTtl(40000), 2000,
        'observer policy must return to idle after the relog grace window');

    const firstResponse = {
        status: 0,
        headers: null,
        body: null,
        writeHead(status, headers) { this.status = status; this.headers = headers; },
        end(body = null) { this.body = body; }
    };
    Observer.sendSnapshotJson({ headers: {} }, firstResponse, '{"ok":true}');
    assert.strictEqual(firstResponse.status, 200);
    assert.strictEqual(firstResponse.headers['Cache-Control'], 'no-cache');
    assert.strictEqual(firstResponse.body, '{"ok":true}');
    assert(firstResponse.headers.ETag, 'snapshot response must expose a validator');

    const conditionalResponse = {
        status: 0,
        headers: null,
        body: 'unexpected',
        writeHead(status, headers) { this.status = status; this.headers = headers; },
        end(body = null) { this.body = body; }
    };
    Observer.sendSnapshotJson({ headers: { 'if-none-match': firstResponse.headers.ETag } }, conditionalResponse, '{"ok":true}');
    assert.strictEqual(conditionalResponse.status, 304, 'matching snapshots must avoid retransmission');
    assert.strictEqual(conditionalResponse.body, null);
} finally {
    World.user = originalUser;
    PlayerActivitySignal.reset();
}

const nativeColdSnapshot = ColdCoordinator.snapshot;
let coldSnapshotReads = 0;
try {
    const head = { kind: 'normal', dueAt: Date.now() - 12345, overdue: true, ageMs: 12345, current: true };
    ColdCoordinator.snapshot = () => {
        coldSnapshotReads++;
        return { epoch: 'current-worker', ready: true, snapshotsLoaded: true, heartbeatAgeMs: 400,
            worker: { lastLoopAt: Date.now() - 450, states: 1700, heap: 1697, queueHead: head,
                inFlight: 2, inFlightAgeMs: 900, dirty: 1, dirtyAgeMs: 300, commanding: 0,
                commandingAgeMs: 0, maxInFlight: 32, paused: false, stopping: false },
            queue: { depth: 1, oldestMs: 200, p0: 0, p1: 0, p2: 1 } };
    };
    const status = Observer.worldStatus(), worker = status.runtime.coldWorker;
    assert.strictEqual(coldSnapshotReads, 1, 'status reuses its one existing coordinator read');
    assert.strictEqual(status.population.coldQueue.due, 0,
        'an empty main life-state queue does not erase an overdue worker heap head');
    assert.deepStrictEqual(worker.queueHead, { ...head, alarmKind: null });
    assert.notStrictEqual(worker.queueHead, head, 'the status owns its bounded projection');
    assert.strictEqual(worker.heartbeatAgeMs, 400);
    assert.strictEqual(worker.epoch, 'current-worker');
    assert.strictEqual(typeof status.generatedAt, 'number', 'cached age readings retain their observation timestamp');
    assert.deepStrictEqual([worker.inFlight, worker.inFlightAgeMs, worker.dirty, worker.commanding], [2, 900, 1, 0],
        'the overlapping native stages remain separate rather than a fabricated total');
    assert.deepStrictEqual(worker.commitQueue, { depth: 1, oldestMs: 200, p0: 0, p1: 0, p2: 1 });
    ColdCoordinator.snapshot = () => ({ epoch: 'restarting-worker', ready: false, snapshotsLoaded: false,
        heartbeatAgeMs: null, worker: { queueHead: head, inFlight: 0, inFlightAgeMs: 0, dirty: 0,
            commanding: 0, lastLoopAt: Date.now() - 10000 }, queue: { depth: 0, oldestMs: 0, p0: 0, p1: 0, p2: 0 } });
    const unknown = Observer.worldStatus().runtime.coldWorker;
    assert.deepStrictEqual([unknown.queueHead, unknown.inFlight, unknown.inFlightAgeMs, unknown.dirty,
        unknown.commanding, unknown.lastLoopAt, unknown.commitQueue, unknown.heartbeatAgeMs], Array(8).fill(null),
    'a retained previous-epoch heartbeat cannot be reported as a current empty queue');
    assert.strictEqual(unknown.ready, false);
    assert.strictEqual(unknown.epoch, 'restarting-worker');
} finally {
    ColdCoordinator.snapshot = nativeColdSnapshot;
}

function requestAsset(headers = {}) {
    return new Promise((resolve) => {
        const response = {
            status: 0,
            headers: null,
            body: 'unexpected',
            writeHead(status, responseHeaders) {
                this.status = status;
                this.headers = responseHeaders;
            },
            end(body = null) {
                this.body = body;
                resolve(this);
            }
        };
        Observer.sendFile(
            { headers },
            response,
            path.join(__dirname, '..', 'src', 'WorldObserver', 'public', 'worldState.js')
        );
    });
}

(async () => {
    const assetPath = path.join(__dirname, '..', 'src', 'WorldObserver', 'public', 'worldState.js');
    const asset = await requestAsset();
    assert.strictEqual(asset.status, 200);
    assert(asset.headers.ETag, 'static observer assets must expose a validator');
    assert.strictEqual(asset.headers['Cache-Control'], 'public, max-age=0, must-revalidate');
    assert.strictEqual(Number(asset.headers['Content-Length']), fs.statSync(assetPath).size);

    const cachedAsset = await requestAsset({ 'if-none-match': asset.headers.ETag });
    assert.strictEqual(cachedAsset.status, 304, 'unchanged SPA assets must use the browser cache');
    assert.strictEqual(cachedAsset.body, null);
    console.log('World observer cache policy checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
