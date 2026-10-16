'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { create, LIMITS } = require('../src/GameServer/Bot/Economy/EconomyDiagnostics');
const { EconomyDiagnosticWriter, FILES, AGE } = require('../src/EconomyDiagnosticWriter');
let timestamp = 1000000;
const disabled = create({ config: { developerDiagnostics: false, economyDiagnostics: true }, now: () => { throw Error('off samples time'); } });
assert.equal(disabled.enabled(64), false);
assert.equal(disabled.push({ get owner() { throw Error('off reads payload'); } }), false);
assert.deepEqual(disabled.stats(), { enabled: false });
const config = { developerDiagnostics: true, economyDiagnostics: true, economyDiagnosticsBotIds: '64,128' };
const buffer = create({ config, now: () => timestamp });
assert.equal(buffer.enabled(192), false);
assert(buffer.push({ owner: 64, phase: 'purchase', reason: 'filled', item: 1463, need: 1000, actual: 200,
    remaining: 800, name: 'must never be copied', chat: 'private', inventory: { private: true } }));
assert.equal(buffer.push({ owner: 64, phase: 'purchase', reason: 'filled', commandId: 'next' }), true, 'distinct transitions in the same minute survive');
const messages = []; buffer.connect(batch => { messages.push(batch); return true; });
assert.equal(messages.length, 1);
const record = JSON.parse(messages[0].records[0]);
assert.equal(messages[0].records.length, 2);
assert.equal(record.actual, 200); assert.equal(record.remaining, 800);
assert(!Object.hasOwn(record, 'name')); assert(!Object.hasOwn(record, 'chat')); assert(!Object.hasOwn(record, 'inventory'));
assert.equal(buffer.ack(999, 1), false, 'stale writer acknowledgment does not release the current batch');
for (let index = 0; index < 400; index++) {
    timestamp += 1000;
    buffer.push({ owner: 64, phase: 'queue', reason: String(index) });
}
assert.equal(messages.length, 1, 'one acknowledged batch in flight');
assert.equal(buffer.stats().queued, LIMITS.mainRecords - LIMITS.mainRecords * LIMITS.owners / LIMITS.perSecond);
assert(buffer.stats().bytes <= LIMITS.mainRecords * LIMITS.recordBytes);
assert(buffer.stats().keys <= LIMITS.keys); assert(buffer.stats().dropped >= 144);
while (buffer.stats().inFlight) {
    const message = messages[messages.length - 1];
    assert(message.records.length <= LIMITS.batch);
    assert(Buffer.byteLength(JSON.stringify(message)) <= LIMITS.batchBytes);
    buffer.ack(message.id, message.records.length);
}
assert.equal(buffer.stats().queued, 0); assert.equal(buffer.stats().written, 194);
const burst = create({ config, now: () => timestamp });
for (let index = 0; index < 100; index++) burst.push({ owner: 64, reason: String(index) });
assert.equal(burst.stats().queued, 48); assert.equal(burst.stats().dropped, 52);
assert.equal(burst.accept(new Array(17).fill('{}')), false);
assert.equal(burst.accept([{ toJSON() { throw Error('invalid packet must not be serialized'); } }]), false);
const worker = create({ config, capacity: 64, now: () => timestamp });
for (let index = 0; index < 100; index++) { timestamp += 1000; worker.push({ owner: 128, reason: String(index) }); }
assert.equal(worker.stats().queued, 48); assert.equal(worker.stats().dropped, 52);
// Final build summaries retain their reserved slots locally and on import.
for (const imported of [false, true]) {
    const admission = create({ config, thread: imported ? 'main' : 'worker', now: () => timestamp });
    const send = row => imported ? admission.accept([JSON.stringify(row)]) === 1 : admission.push(row);
    for (let i = 0; i < 48; i++) assert(send({ owner: 64, phase: 'wish_alternative', reason: String(i) }));
    assert.equal(send({ owner: 64, phase: 'wish_context', reason: 'hit_same_inputs' }), false,
        'a cheap hit cannot consume a reserved build-summary slot');
    for (let i = 0; i < 16; i++) assert(send({ owner: 64, phase: 'wish_context', gate: 'would_hold', gateDiff: 'leaf' }));
    assert.equal(admission.stats().queued, LIMITS.perSecond);
    assert.equal(send({ owner: 64, phase: 'wish_context', gate: 'would_hold' }), false, 'the original total rate cap still holds');
    assert.equal(admission.stats().drops.rate, 2);
}
// Backlogged queues preserve summary space across seconds, including tiny test capacities.
for (const [capacity, ordinary] of [[4, 3], [64, 48], [256, 192]]) {
    let at = timestamp;
    const admission = create({ config, capacity, now: () => at });
    for (let i = 0; i < ordinary; i++) { at += 1000; assert(admission.push({ owner: 64, phase: 'wish_alternative' })); }
    at += 1000;
    assert.equal(admission.push({ owner: 64, phase: 'wish_context', reason: 'hit_same_inputs' }), false);
    for (let i = ordinary; i < capacity; i++) {
        at += 1000; assert(admission.push({ owner: 64, phase: 'wish_context', gate: 'event_key' }));
    }
    at += 1000;
    assert.equal(admission.push({ owner: 64, phase: 'wish_context', gate: 'event_key' }), false);
    assert.equal(admission.stats().queued, capacity);
    assert.equal(admission.stats().drops.queue, 2);
}
const sample = create({ config: { developerDiagnostics: true, economyDiagnostics: true }, now: () => timestamp });
for (let id = 1; id <= 5000; id++) sample.enabled(id);
assert.equal(sample.stats().selected, 16); assert.equal(sample.enabled(4096), false, 'sample does not evict already logged owners');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'economy-diagnostic-writer-'));
try {
    const writer = new EconomyDiagnosticWriter(directory, { build: 'fixture', world: 'fixture', run: 'fixture' }, { maxFile: 1024, now: () => timestamp, enabled: true });
    const rows = [JSON.stringify({ owner: 64, reason: 'x'.repeat(400) })];
    for (let index = 0; index < 12; index++) assert.equal(writer.write(rows), 1);
    assert.equal(fs.readdirSync(directory).length, FILES);
    for (const name of fs.readdirSync(directory)) {
        assert(fs.statSync(path.join(directory, name)).size <= 1024);
        assert.equal(JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8').split('\n')[0]).type, 'economy_diagnostics_header');
        fs.utimesSync(path.join(directory, name), new Date(timestamp - AGE - 1000), new Date(timestamp - AGE - 1000));
    }
    writer.cleanup(); assert.equal(fs.readdirSync(directory).length, 0, 'retention deletes only old diagnostic files');
    assert.equal(writer.write(['bad\nrecord']), 0);
    assert.equal(writer.write(new Array(17).fill('{}')), 0);
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
buffer.stop(); assert.equal(buffer.stats().queued, 0);
console.log('Economy diagnostics: disabled fast path, privacy, correlation, bounded queues/bytes/sample/rate, acknowledgments, rotation and retention passed');
