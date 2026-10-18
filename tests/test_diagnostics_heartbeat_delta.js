'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics = true;
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const { create } = require('../src/GameServer/Bot/Economy/EconomyDiagnostics');

const EPOCH = 'delta-test';
const posted = [];
const main = new ColdSimulationCoordinator();
main.worker = { postMessage: message => posted.push(message) };
main.workerEpoch = EPOCH;
const diagnostics = create({ config: { developerDiagnostics: true }, thread: 'worker' });
const table = () => main.snapshot().worker.developerDiagnostics;
const resyncs = () => posted.filter(message => message.type === 'diagnostics_resync').length;

// One worker heartbeat as startKernel builds it; `deliver` false = lost on the way to main.
async function beat({ deliver = true } = {}) {
    const delta = diagnostics.delta();
    if (deliver) {
        await main.onMessage(Protocol.envelope('heartbeat', EPOCH, { states: 1, inFlight: 0, developerDiagnostics: delta }, `beat-${delta.seq}-${posted.length}`));
    }
    diagnostics.deltaSent();
    return delta;
}
function assertSameTable() {
    const whole = diagnostics.metrics();
    assert.deepEqual(table().counts, whole.counts);
    assert.deepEqual(table().durations, whole.durations);
}

(async () => {
    diagnostics.count('a', 'x', 'one');
    diagnostics.count('b', 'y', 'two', 5);
    diagnostics.duration('layer1', 3);
    const first = await beat();
    assert.equal(first.full, true);
    assertSameTable();

    // Only what changed is carried; main ends with the same table metrics() gives.
    diagnostics.count('a', 'x', 'one');
    diagnostics.count('c', 'z', 'three');
    diagnostics.duration('layer2', 7);
    const second = await beat();
    assert.equal(second.full, false);
    assert.deepEqual(Object.keys(second.counts).sort(), ['a:x:one', 'c:z:three']);
    assert.deepEqual(Object.keys(second.durations), ['layer2']);
    assertSameTable();
    diagnostics.duration('layer1', 4);
    await beat();
    assertSameTable();
    assert.equal(resyncs(), 0);

    // A heartbeat that never reached main: the next delta is not merged and a resync is asked once.
    diagnostics.count('lost', 'k', 'v');
    await beat({ deliver: false });
    diagnostics.count('after', 'k', 'v');
    await beat();
    assert.equal(table().counts['after:k:v'], undefined);
    assert.equal(resyncs(), 1);
    diagnostics.count('after', 'k', 'v');
    await beat();
    assert.equal(resyncs(), 1, 'resync request is not repeated within 5 s');

    // The worker answers the request with a full table and main is whole again.
    diagnostics.requestFull();
    const repaired = await beat();
    assert.equal(repaired.full, true);
    assertSameTable();
    assert.equal(table().counts['lost:k:v'], 1);

    // An oversize heartbeat loses its diagnostics: the next beat carries the same changes again.
    diagnostics.count('big', 'k', 'v');
    const trimmedDelta = diagnostics.delta();
    const trimmed = Protocol.envelope('heartbeat', EPOCH, { states: 1, inFlight: 0, developerDiagnostics: trimmedDelta }, 'trimmed');
    assert.equal(diagnostics.omitAggregatesOnOverflow(trimmed, 'message_too_large'), true);
    diagnostics.deltaSent();
    const retry = await beat();
    assert.equal(retry.seq, trimmedDelta.seq);
    assert.equal(retry.counts['big:k:v'], 1);
    assertSameTable();
    assert.equal(resyncs(), 1);
    console.log('Diagnostics heartbeat delta: changes only, merged table equals metrics(), gap asks a resync, trimmed beat is resent');
})().catch(error => { console.error(error); process.exit(1); });
