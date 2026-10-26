const assert = require('assert');
const EventEmitter = require('events');

require('../src/Global');

const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');

class FakeWorker extends EventEmitter {
    static instances = [];

    constructor(workerPath, options) {
        super();
        this.workerPath = workerPath;
        this.options = options;
        this.messages = [];
        this.terminated = false;
        FakeWorker.instances.push(this);
    }

    postMessage(message) {
        this.messages.push(message);
    }

    terminate() {
        this.terminated = true;
        return Promise.resolve(1);
    }
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
    const coordinator = new ColdSimulationCoordinator({ WorkerClass: FakeWorker, workerPath: 'fake-worker.js' });
    coordinator.started = true;
    coordinator.startWorker();
    const first = FakeWorker.instances[0];
    const firstEpoch = coordinator.workerEpoch;
    assert(first, 'coordinator must create one long-lived worker');
    assert.strictEqual(first.options.name, 'l2node-cold-simulation');
    assert.strictEqual(first.options.resourceLimits.maxOldGenerationSizeMb, 512,
        'the full-world worker must leave headroom above its retained state and caches');

    first.emit('exit', 1);
    await wait(1100);
    const second = FakeWorker.instances[1];
    assert(second, 'unexpected worker exit must restart with bounded backoff');
    assert.notStrictEqual(coordinator.workerEpoch, firstEpoch, 'restart must fence every old-epoch message');

    // The restarted worker has no kernel until it reports `running`: a snapshot page sent now
    // would only fault (kernel_not_initialized). post() drops it for every page sender until then.
    const beforeReady = second.messages.length;
    assert.strictEqual(await coordinator.sendSnapshotPage([{ state: { characterId: 7 } }]), false,
        'a snapshot page is not streamed to a worker that has not initialised its kernel');
    assert(!second.messages.slice(beforeReady).some(message => message.type === 'snapshot_page'),
        'no snapshot_page reaches a worker before it reports running');

    const beforeBatches = second.messages.length;
    const results = Array.from({ length: 20 }, (_, index) => ({
        ok: true,
        characterId: index + 1,
        proposalId: `proposal-${index + 1}`,
        state: { characterId: index + 1, stats: { padding: 'x'.repeat(40000) } }
    }));
    const pages = coordinator.postCollections('commit_ack', { results });
    const batchMessages = second.messages.slice(beforeBatches);
    assert(pages > 1, 'large ACK payloads must be split below the IPC envelope limit');
    assert.strictEqual(batchMessages.flatMap((message) => message.payload.results).length, results.length);
    assert(batchMessages.every((message) => Protocol.validateEnvelope(message, 'main', {
        workerEpoch: coordinator.workerEpoch
    }).ok), 'every split ACK page must independently validate');

    coordinator.lastHeartbeatAt = Date.now() - 20000;
    coordinator.watchdog();
    assert.notStrictEqual(second.terminated, true, 'a booting worker sends no heartbeat and is not killed for it');
    coordinator.ready = true;
    coordinator.lastHeartbeatAt = Date.now() - 6000;
    coordinator.watchdog();
    assert.strictEqual(second.messages.at(-1).type, 'pause', 'a stale heartbeat must pause new claims');
    coordinator.setPauseReason('commit_queue_high_water', true);
    coordinator.lastHeartbeatAt = Date.now();
    coordinator.watchdog();
    assert.strictEqual(second.messages.at(-1).type, 'pause',
        'heartbeat recovery must not bypass an independent commit-queue pause');
    coordinator.setPauseReason('commit_queue_high_water', false);
    assert.strictEqual(second.messages.at(-1).type, 'resume',
        'worker must resume once every pause reason has cleared');

    coordinator.lastHeartbeatAt = Date.now() - 37000;
    coordinator.lastWatchdogAt = Date.now() - 37000;
    coordinator.watchdog();
    assert.notStrictEqual(second.terminated, true,
        'a main thread that slept with the Mac must not count its own sleep against the worker');
    assert(Date.now() - coordinator.lastHeartbeatAt < 2000, 'the stall is credited to the heartbeat clock');

    coordinator.lastWatchdogAt = 0;
    coordinator.lastHeartbeatAt = Date.now() - 20000;
    // A late heartbeat from the crashed epoch is no sign of life of the current worker.
    await coordinator.onMessage({
        version: 1,
        type: 'heartbeat',
        msgId: 'old-heartbeat',
        workerEpoch: firstEpoch,
        sentAt: Date.now(),
        payload: {}
    });
    coordinator.watchdog();
    assert.strictEqual(second.terminated, true, 'a dead worker must be terminated so the restart path can recover leases');
    coordinator.stopping = true;
    if (coordinator.restartTimer) clearTimeout(coordinator.restartTimer);
    coordinator.restartTimer = null;
    console.log('Cold worker epoch fencing, watchdog, and restart checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
