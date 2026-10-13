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

const strictSpots = [{ id: 7 }, { id: '7' }, { id: NaN, name: 'first' }, { id: NaN, name: 'last' },
    { id: 0, name: 'zero' }, { id: -0, name: 'last zero' }, { id: 7, name: 'last number' }];
const strictTable = SpotIndex.strictTableFor(strictSpots);
assert.strictEqual(strictTable.get(7), strictSpots[6], 'strict view keeps the last numeric key');
assert.strictEqual(strictTable.get('7'), strictSpots[1], 'strict view does not merge numeric and string IDs');
assert.strictEqual(strictTable.get(NaN), strictSpots[3], 'Map SameValueZero keeps the last NaN key');
assert.strictEqual(strictTable.get(0), strictSpots[5], 'Map SameValueZero merges positive and negative zero');
assert.strictEqual(SpotIndex.strictTableFor(strictSpots), strictTable);
assert.strictEqual(SpotIndex.spotById(strictSpots, '7'), strictSpots[6], 'the existing string view retains its own contract');
strictSpots.push({ id: '7', name: 'appended' });
assert.strictEqual(SpotIndex.strictTableFor(strictSpots).get('7'), strictSpots[7], 'growth refreshes both views');
assert.notStrictEqual(SpotIndex.strictTableFor(strictSpots.slice()), SpotIndex.strictTableFor(strictSpots));
assert.strictEqual(SpotIndex.strictTableFor(null).size, 0);

console.log('spot index tests passed');
