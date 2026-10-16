'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { create, LIMITS, isPlanMismatch } = require('../src/GameServer/Bot/Economy/EconomyDiagnostics');
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
    for (let i = 0; i < LIMITS.mismatchPerSecond; i++) assert(send({ owner: 192, phase: 'wish_context', gate: 'would_hold', gateDiff: 'leaf' }));
    assert.equal(admission.stats().queued, 48 + LIMITS.mismatchPerSecond);
    assert.equal(send({ owner: 192, phase: 'wish_context', gate: 'would_hold', gateDiff: 'leaf' }), false,
        'an unselected mismatch obeys its own rate cap');
    assert.equal(admission.stats().drops.rate, 2);
}
// A mismatch flood from any bots spends its own budget, never a sampled owner's.
for (const imported of [false, true]) {
    const admission = create({ config, thread: imported ? 'main' : 'worker', now: () => timestamp });
    const send = row => imported ? admission.accept([JSON.stringify(row)]) === 1 : admission.push(row);
    let admitted = 0;
    for (let i = 0; i < LIMITS.perSecond; i++)
        admitted += send({ owner: 1000 + i, phase: 'wish_context', gate: 'would_hold', gateDiff: 'focus' }) ? 1 : 0;
    assert.equal(admitted, LIMITS.mismatchPerSecond);
    assert.equal(admission.stats().drops.rate, LIMITS.perSecond - LIMITS.mismatchPerSecond);
    assert(send({ owner: 64, phase: 'purchase', reason: 'filled' }), 'a sampled owner detail row survives the flood');
    assert(send({ owner: 128, phase: 'wish_context', gate: 'refused', reason: 'build' }), 'a sampled owner summary row survives the flood');
    assert.equal(admission.stats().queued, LIMITS.mismatchPerSecond + 2);
}
// Exact completed mismatches bypass owner selection only, on both hops.
const mismatch = { owner: 192, phase: 'wish_context', gate: 'would_hold', gateDiff: 'queue' };
for (const imported of [false, true]) {
    const admission = create({ config, thread: imported ? 'main' : 'worker', now: () => timestamp });
    assert.equal(admission.ownerIds(), '64,128');
    const send = row => imported ? admission.accept([JSON.stringify(row)]) === 1 : admission.push(row);
    for (const gateDiff of ['focus', 'leaf', 'queue', 'funded']) assert(send({ ...mismatch, gateDiff }));
    for (const invalid of [{ owner: 0 }, { owner: -1 }, { owner: 1.5 }, { owner: '192' }, { owner: Number.MAX_SAFE_INTEGER + 1 },
        { phase: 'wish_alternative' }, { gate: 'check_failed' }, { gateDiff: 'same' }, { gateDiff: 'other' }]) {
        assert.equal(isPlanMismatch({ ...mismatch, ...invalid }), false);
        assert.equal(send({ ...mismatch, ...invalid }), false, 'the mismatch path is not a generic force-record escape');
    }
    assert.equal(admission.ownerIds(), '64,128', 'the witness does not enroll an owner for detail');
    assert.equal(send({ owner: 192, phase: 'wish_alternative' }), false);
    assert.equal(admission.stats().selected, 2);
    const received = []; admission.connect(batch => { received.push(...batch.records.map(JSON.parse)); return true; });
    assert.equal(received.length, 4);
    assert(received.every(row => row.owner === 192));
}
const automatic = create({ config: { developerDiagnostics: true, economyDiagnostics: true }, now: () => timestamp });
assert(automatic.push(mismatch));
assert.equal(automatic.stats().selected, 0, 'a hash-eligible witness never calls the automatic selector');
assert.equal(automatic.ownerIds(), '0');
assert.equal(automatic.push({ ...mismatch, gateDiff: 'same', owner: 193 }), false);
const noDetail = create({ config: { developerDiagnostics: true, economyDiagnostics: false }, now: () => { throw Error('detail off samples time'); } });
assert.equal(noDetail.push(mismatch), false);
const oversizeWitness = { ...mismatch };
for (const field of ['trigger', 'reason', 'town', 'source', 'wishKey', 'commandId', 'caller', 'layer', 'outcome', 'errandKey',
    'proposalId', 'moved', 'heldFocus', 'freshFocus', 'heldLeaf', 'freshLeaf', 'social', 'choiceEvent', 'heldRoot', 'freshRoot'])
    oversizeWitness[field] = 'x'.repeat(96);
assert.equal(automatic.push(oversizeWitness), false);
assert.equal(automatic.stats().drops.size, 1, 'mismatch admission never bypasses the record byte cap');
// Backlogged queues preserve summary space across seconds, including tiny test capacities.
for (const [capacity, ordinary] of [[4, 3], [64, 48], [256, 192]]) {
    let at = timestamp;
    const admission = create({ config, capacity, now: () => at });
    for (let i = 0; i < ordinary; i++) { at += 1000; assert(admission.push({ owner: 64, phase: 'wish_alternative' })); }
    at += 1000;
    assert.equal(admission.push({ owner: 64, phase: 'wish_context', reason: 'hit_same_inputs' }), false);
    for (let i = ordinary; i < capacity; i++) {
        at += 1000; assert(admission.push(mismatch));
    }
    at += 1000;
    assert.equal(admission.push(mismatch), false);
    assert.equal(admission.stats().queued, capacity);
    assert.equal(admission.stats().drops.queue, 2);
}
// The compact all-owner row fits without changing the existing byte limit.
const maxText = 'x'.repeat(64), maxNumber = Number.MAX_SAFE_INTEGER;
const compactRows = [];
// One delivery per writer: each witness shape gets its own.
const compactWriter = () => {
    const writer = create({ config, now: () => maxNumber });
    writer.connect(batch => { compactRows.push(...batch.records.map(JSON.parse)); return true; });
    return writer;
};
const compact = compactWriter();
// A focus/leaf witness carries both sides; a queue/funded one only the held
// focus/leaf (equal by then) and its own evidence.
const witnessBase = { ...mismatch, owner: maxNumber, baselineAt: maxNumber,
    sequence: maxNumber, inputActivityLeaf: 0xffffffff, decisionSeq: maxNumber, activityLeaf: 0xffffffff,
    heldFocus: maxText, heldLeaf: maxText,
    moved: maxText, reconsidered: 1, choiceEvent: maxText, social: 'helping:focus' };
assert(compact.push({ ...witnessBase, gateDiff: 'funded',
    queueIndex: 11, heldRoot: maxText, freshRoot: maxText, heldFunded: 1, freshFunded: 0 }));
assert(compactWriter().push({ ...witnessBase, gateDiff: 'queue', queueIndex: 11, heldRoot: maxText, freshRoot: maxText,
    queueEntered: 64, queueLeft: 64, queueMoved: 'watch,gap,funded', heldRootDrift: -0.123, freshRootDrift: -12345.678 }));
assert(compactWriter().push({ ...witnessBase, gateDiff: 'focus', freshFocus: maxText, freshLeaf: maxText }));
assert.equal(compactRows.length, 3);
for (const row of compactRows) assert(Buffer.byteLength(JSON.stringify(row)) + 1 <= LIMITS.recordBytes);
assert.equal(compactRows[1].queueMoved, 'watch,gap,funded');
assert.equal(compactRows[0].freshFunded, 0, 'a current-wallet unfunded witness survives serialization');
assert.equal(compactRows[0].heldRoot, maxText);
assert.equal(compact.stats().selected, 0);

// Exercise the actual comparator against the native current-wallet owner.
{
    const { moneyQueue } = require('../src/GameServer/Bot/Economy/WishNetwork');
    const Funding = require('../src/GameServer/Bot/Economy/PurchaseFunding');
    const source = fs.readFileSync(path.join(__dirname, '../src/GameServer/Bot/Economy/EconomyContext.js'), 'utf8');
    const start = source.indexOf('function gatePlanDiff(');
    let reprices = 0;
    const compare = require('node:vm').runInNewContext(`(${source.slice(start, source.indexOf('\nfunction occupancyToken(', start))})`,
        { Funding, moneyQueue(...args) { reprices++; return moneyQueue(...args); } });
    const wish = (key, price = 10, valueHours = 10) => ({ key, price, valueHours, ratio: valueHours / price });
    const network = queue => ({ focus: ['power:1'], activity: { key: 'leaf:1' }, queue });
    const check = (left, right, kind, expected, watch = [[], []]) => {
        const evidence = {}; reprices = 0;
        assert.equal(compare({ adena: 15 }, { plan: { network: left, survivalReserve: 0, hourAdena: 100, watchList: watch[0] } },
            { network: right, survivalReserve: 0, hourAdena: 100, watchList: watch[1] }, {}, evidence), kind);
        assert.deepEqual(evidence, expected);
        // Only a queue witness reprices beyond the funded compare (diagnostics only).
        assert.equal(reprices, ['same', 'funded', 'queue'].includes(kind) ? 2 : 0, 'witness capture reprices once per side');
    };
    const queueWitness = (fields, rest) => ({ queueEntered: 0, queueLeft: 0, queueMoved: 'order',
        heldRootDrift: undefined, freshRootDrift: undefined, ...fields, ...rest });
    check(network([wish('a')]), { ...network([wish('b')]), focus: ['power:2'], activity: { key: 'leaf:2' } }, 'focus', {});
    check(network([wish('a')]), { ...network([wish('b')]), activity: { key: 'leaf:2' } }, 'leaf', {});
    // A wish set change at index 1: the gap moves from b to c (only a funds at adena 15).
    check(network([wish('a'), wish('b')]), network([wish('a'), wish('c')]), 'queue',
        queueWitness({ queueIndex: 1, heldRoot: 'b', freshRoot: 'c' }, { queueEntered: 1, queueLeft: 1, queueMoved: 'gap' }));
    check(network([wish('a'), wish('b')]), network([wish('c')]), 'queue',
        queueWitness({ queueIndex: 0, heldRoot: 'a', freshRoot: 'c' }, { queueEntered: 1, queueLeft: 2, queueMoved: 'gap,funded' }));
    check(network([wish('a')]), network([wish('a'), wish('b')]), 'queue',
        queueWitness({ queueIndex: 1, heldRoot: undefined, freshRoot: 'b' }, { queueEntered: 1, queueMoved: 'gap' }));
    check(network([wish('a'), wish('b')]), network([wish('a')]), 'queue',
        queueWitness({ queueIndex: 1, heldRoot: 'b', freshRoot: undefined }, { queueLeft: 1, queueMoved: 'gap' }));
    // The same wishes swapped by a small ratio drift, nothing a reader sees: an order-only miss.
    check(network([wish('a', 5, 10), wish('b', 5, 9.9), wish('c', 20)]), network([wish('b', 5, 9.9), wish('a', 5, 9.8), wish('c', 20)]), 'queue',
        queueWitness({ queueIndex: 0, heldRoot: 'a', freshRoot: 'b' }, { heldRootDrift: -0.02, freshRootDrift: 0 }));
    // The same swap with another top watched item: TradeIntent's reader moved.
    check(network([wish('a', 5, 10), wish('b', 5, 9.9)]), network([wish('b', 5, 9.9), wish('a', 5, 9.8)]), 'queue',
        queueWitness({ queueIndex: 0, heldRoot: 'a', freshRoot: 'b' }, { queueMoved: 'watch', heldRootDrift: -0.02, freshRootDrift: 0 }),
        [[{ itemId: 1 }, { itemId: 2 }], [{ itemId: 2 }, { itemId: 1 }]]);
    check(network([{ ...wish('a'), funded: false }]), network([{ ...wish('a', 20), funded: true }]), 'funded',
        { queueIndex: 0, heldRoot: 'a', freshRoot: 'a', heldFunded: 1, freshFunded: 0 });
    check(network([{ ...wish('a'), funded: false }]), network([{ ...wish('a'), funded: true }]), 'same', {});
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
