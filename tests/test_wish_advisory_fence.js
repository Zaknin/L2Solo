'use strict';
const assert = require('node:assert/strict');
const { deflateRawSync } = require('node:zlib');
require('../src/Global');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const fixture = require('./fixtures/wish_advisory_large_fence.json');
const order = rows => [...rows].sort(([a], [b]) => String(a).localeCompare(String(b)));
const proof = Economy.encodeCalculationFence(fixture.fields);
assert(proof, 'the complete native 18471-byte fence fits without dropping one source');
assert.equal(Buffer.byteLength(JSON.stringify(fixture.fields)), fixture.originalBytes);
assert.equal(fixture.fields[2].length, 748);
assert(proof.byteLength + fixture.cardBytes <= 4096, 'the complete accepted decision retains the original 4KB total budget');
assert.equal(proof.buffer.byteLength, proof.byteLength, 'no hidden zlib pooled backing buffer is retained');
const decoded = Economy.decodeCalculationFence(proof);
assert.deepEqual(decoded.slice(0, 2), fixture.fields.slice(0, 2), 'structural key, every market ID and every version remain exact');
assert.deepEqual(order(decoded[2]), order(fixture.fields[2]), 'every competing spot ID and occupancy version roundtrips exactly');
assert.deepEqual(decoded.slice(3), fixture.fields.slice(3), 'quantity bounds and physical bag safety remain exact');

const unusual = ['-0_1', '01_2', '1_-0', '9007199254740992_1', '35:necropolis', 17];
const exact = [fixture.fields[0], [[], []], unusual.map((id, at) => [id, String(at)]), [], null];
assert.deepEqual(order(Economy.decodeCalculationFence(Economy.encodeCalculationFence(exact))[2]), order(exact[2]),
    'noncanonical, large and numeric IDs are never coerced to grid coordinates');
assert.equal(Economy.decodeCalculationFence(new Uint8Array([1, 255])), null);
assert.equal(Economy.decodeCalculationFence(new Uint8Array(4097)), null);
const pack = fields => { const compressed = deflateRawSync(Buffer.from(JSON.stringify(fields)));
    return new Uint8Array([1, ...compressed]); };
for (const spots of [[['0'], [0, 0, 1], []], [['0'], [0, .5, 0], []], [['0'], [Number.MAX_SAFE_INTEGER, 0, 0, 1, 0, 0], []],
    [['0'], [0, 0, 0, 0, 0, 0], []], [['0'], [0], []], [['0'], [], [['opaque', undefined]]]]) {
    assert.equal(Economy.decodeCalculationFence(pack(['key', [[], []], spots, [], null])), null,
        'malformed coordinate, version or duplicate source fails closed');
}
assert.equal(Economy.decodeCalculationFence(pack(['key', [['token'], [1, 1]], [[], [], []], [], null])), null,
    'a missing market version cannot become an absent supplier');
const expanded = deflateRawSync(Buffer.alloc(65537, 32));
assert.equal(Economy.decodeCalculationFence(new Uint8Array([1, ...expanded])), null, 'inflate cannot exceed its bounded temporary payload');
console.log(`Native fence ${fixture.originalBytes}B -> ${proof.byteLength}B; with exact ${fixture.cardBytes}B card: ${proof.byteLength + fixture.cardBytes}B; all 748 sources preserved`);
