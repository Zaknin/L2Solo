const assert = require('assert');

require('../src/Global');

const SpotIndex = invoke('GameServer/Bot/AI/SpotIndex');

// One id table per spot list, shared by every lookup of a spot by its id.
const spots = [{ id: '7_18', name: 'a' }, { id: 'raid:10305', name: 'b' }];
assert.strictEqual(SpotIndex.spotById(spots, '7_18'), spots[0]);
assert.strictEqual(SpotIndex.spotById(spots, 'raid:10305'), spots[1]);
assert.strictEqual(SpotIndex.spotById(spots, 'missing'), null);
assert.strictEqual(SpotIndex.spotById(spots, undefined), null);
assert.strictEqual(SpotIndex.spotById(null, '7_18'), null, 'no list, no spot');
assert.strictEqual(SpotIndex.tableFor(spots), SpotIndex.tableFor(spots), 'the table is built once per list');

// The cold worker fills its planning list in place: the table follows it.
spots.push({ id: 42, name: 'c' });
assert.strictEqual(SpotIndex.spotById(spots, '42'), spots[2], 'a list grown in place gets a new table');
assert.strictEqual(SpotIndex.spotById(spots, 42), spots[2], 'ids are compared as strings');

// A repeated id keeps the last spot and does not rebuild the table per lookup.
spots.push({ id: '7_18', name: 'again' });
assert.strictEqual(SpotIndex.spotById(spots, '7_18'), spots[3]);
assert.strictEqual(SpotIndex.tableFor(spots), SpotIndex.tableFor(spots), 'a repeated id does not rebuild the table');

const topology = [{ id: 'same', npcEntries: [{ selfId: 1, count: 8 }] },
    { id: 'same', npcEntries: [{ name: 'alias', count: 3 }] },
    { id: 'other', npcEntries: [{ selfId: 1, count: 0 }, { selfId: '1', count: 2 }] }];
const npcSpots = SpotIndex.spotsForNpc(topology, 1);
assert.deepStrictEqual(npcSpots, [topology[2]], 'canonical rows only; aliases and duplicate NPC entries add no false links');
assert.strictEqual(SpotIndex.spotsForNpc(topology, '1'), npcSpots, 'numeric NPC lookup shares prepared rows');
topology.push({ id: 'new', npcEntries: [{ selfId: 1, count: 4 }] });
assert.deepStrictEqual(SpotIndex.spotsForNpc(topology, 1), [topology[2], topology[3]], 'grown list refreshes both directions');
assert.strictEqual(SpotIndex.spotsForNpc(null, 1), null);
assert.deepStrictEqual(SpotIndex.spotsForNpc(topology, 9999), []);

console.log('spot index tests passed');
