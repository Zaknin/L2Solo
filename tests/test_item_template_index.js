const assert = require('assert');
const Index = require('../src/GameServer/Item/ItemTemplateIndex');

const first = { selfId: 7, etc: { slot: 8 } };
const numericString = { selfId: '7' };
const duplicate = { selfId: 7, etc: { slot: 0 } };
const items = [first, numericString, duplicate];
assert.strictEqual(Index.find(items, '7'), first, 'numeric lookup preserves first-match precedence');
assert.strictEqual(Index.findStrict(items, '7'), numericString, 'strict lookup preserves string/number distinction');
assert.strictEqual(Index.findStrict(items, 7), first);
assert.strictEqual(Index.find(items, 'missing'), undefined);
assert.strictEqual(Index.findStrict([{ selfId: NaN }], NaN), undefined);
assert.strictEqual(Index.find(null, 7), undefined);
items.push({ selfId: 8 });
assert.strictEqual(Index.find(items, 8), items[3], 'appended templates rebuild the index');
const replacement = [{ selfId: 7, etc: { slot: 14 } }];
assert.strictEqual(Index.find(replacement, 7), replacement[0], 'a replaced catalog has its own index');
first.etc.slot = 9;
assert.strictEqual(Index.find(items, 7).etc.slot, 9, 'template objects are shared without stale copies');
items[0] = { selfId: 9 };
Index.invalidate(items);
assert.strictEqual(Index.find(items, 7), numericString, 'explicit invalidation supports same-length catalog edits');
assert.strictEqual(Index.find(items, 9), items[0]);

const rows = [{ selfId: 7 }, { selfId: '7' }, { selfId: 7 }, { selfId: 'invalid' }, { selfId: NaN }];
assert.strictEqual(Index.findLast(rows, '7'), rows[2], 'numeric Map readers retain the last duplicate');
assert.strictEqual(Index.findLast(rows, 'invalid'), rows[4], 'LAST retains the Map NaN key');
assert.strictEqual(Index.findLastByLength(rows, 7), rows[2]);
assert.strictEqual(Index.lastIndex(rows), Index.lastIndex(rows), 'frozen readers share their source index');
const appended = { selfId: 7 };
rows.push(appended);
assert.strictEqual(Index.findLast(rows, 7), rows[2], 'identity-only readers retain their first snapshot');
assert.strictEqual(Index.findLastByLength(rows, 7), appended, 'identity+length readers see appended duplicates');
Index.invalidate(rows);
assert.strictEqual(Index.findLast(rows, 7), rows[2], 'live-source invalidation does not refresh frozen snapshots');
assert.strictEqual(Index.findLastByLength(rows, 7), appended);
const sameLengthEdit = { selfId: 7 };
rows[5] = sameLengthEdit;
assert.strictEqual(Index.currentLastIndex(rows).get(7), sameLengthEdit, 'current requests see same-length row replacement');
sameLengthEdit.selfId = 8;
assert.strictEqual(Index.currentLastIndex(rows).get(8), sameLengthEdit, 'current requests see in-place ID edits');
assert.strictEqual(Index.findLastByLength(rows, 8), undefined, 'length snapshots retain their previous keys');
Index.invalidate(rows);
assert.strictEqual(Index.findLastByLength(rows, 8), sameLengthEdit, 'explicit invalidation refreshes live source indices');
assert.strictEqual(Index.findLast([{ selfId: 8 }], 8)?.selfId, 8, 'new source identity starts a new LAST snapshot');

const observerA = () => {};
const observerB = () => {};
const observerC = () => {};
const lengthObserver = () => {};
const early = { selfId: 11 };
const late = { selfId: '11' };
const sourceA = [early];
const earlyMap = Index.lastIndex(sourceA, observerA);
assert.strictEqual(Index.lastIndex(sourceA, observerB), earlyMap,
    'readers observing equal key/row references share one candidate map');
sourceA.push(late);
const lateMap = Index.lastIndex(sourceA, observerC);
assert.strictEqual(lateMap.get(11), late, 'a later first observation sees current rows');
assert.notStrictEqual(lateMap, earlyMap, 'different observations retain different current snapshots');
assert.strictEqual(Index.findLast(sourceA, 11, observerA), early, 'an unchanged source freezes the early reader');
assert.strictEqual(Index.findLast(sourceA, 11, observerB), early, 'updating a candidate cannot alter earlier readers');
assert.strictEqual(Index.findLastByLength(sourceA, 11, lengthObserver), late);
const sourceB = [{ selfId: 11 }];
Index.findLast(sourceB, 11, observerA);
Index.findLastByLength(sourceB, 11, lengthObserver);
const returned = { selfId: 12 };
sourceA[1] = returned;
assert.strictEqual(Index.findLast(sourceA, 12, observerA), returned,
    'A -> B -> A rebuilds an identity-only reader after same-length row edits');
assert.strictEqual(Index.findLastByLength(sourceA, 12, lengthObserver), returned,
    'A -> B -> A rebuilds a length-aware reader after same-length row edits');
assert.strictEqual(Index.findLast(sourceA, 11, observerC), late,
    'a reader which never left A retains its own old snapshot');
const next = { selfId: 13 };
sourceA[1] = next;
Index.invalidate(sourceA);
assert.strictEqual(Index.findLast(sourceA, 12, observerA), returned, 'targeted invalidation leaves frozen keys intact');
assert.strictEqual(Index.findLastByLength(sourceA, 13, lengthObserver), next,
    'targeted invalidation refreshes only length-aware observations');
next.selfId = 14;
Index.invalidate();
assert.strictEqual(Index.findLastByLength(sourceA, 14, lengthObserver), next,
    'global invalidation also refreshes length-aware observations');
assert.strictEqual(Index.findLast(sourceA, 12, observerA), returned, 'global invalidation leaves frozen observations intact');

const finiteRows = [{ selfId: 'invalid' }, { selfId: 0 }, { selfId: Infinity }, { selfId: '7' }, { selfId: 7 }];
assert.strictEqual(Index.findFinite(finiteRows, Infinity), finiteRows[0], 'clan helpers map non-finite IDs to zero');
assert.strictEqual(Index.findFinite(finiteRows, NaN), finiteRows[0]);
assert.strictEqual(Index.findFinite(finiteRows, '7'), finiteRows[3], 'finite lookup preserves first numeric match');
assert.strictEqual(Index.findFinite(undefined, 7), undefined, 'optional clan catalogs remain optional');
assert.strictEqual(Index.findNumericRowRequired(finiteRows, 7), finiteRows[3], 'dual recipes convert row IDs');
assert.strictEqual(Index.findNumericRowRequired(finiteRows, '7'), undefined, 'dual recipes keep the raw product ID');
assert.strictEqual(Index.findRequired(rows, '7'), rows[0]);
assert.strictEqual(Index.findStrictRequired(rows, '7'), rows[1]);
assert.strictEqual(Index.hasStrictRequired(rows, '7'), true, 'existence readers return a boolean');
assert.strictEqual(Index.hasStrictRequired(rows, NaN), false, 'strict NaN never matches');
assert.strictEqual(Index.hasStrictRequired(Array(1), 7), false, 'Array.some skips sparse holes');
assert.throws(() => Index.hasStrictRequired([undefined], 7), TypeError, 'explicit undefined rows still throw in some');
for (const reader of [Index.findRequired, Index.findStrictRequired, Index.findNumericRowRequired, Index.hasStrictRequired]) {
    assert.throws(() => reader(undefined, 7), TypeError, 'unguarded callers retain absent-catalog errors');
    assert.throws(() => reader([null, { selfId: 7 }], 7), TypeError, 'unguarded scans retain malformed-row errors');
}
assert.strictEqual(Index.findStrictRequired([{ selfId: 7 }, null], 7)?.selfId, 7,
    'an early strict match still precedes a malformed row');
const symbol = Symbol('raw ID');
assert.strictEqual(Index.findStrictRequired([{ selfId: symbol }], symbol)?.selfId, symbol,
    'strict callers do not convert raw IDs');
assert.strictEqual(Index.findRequired([], symbol), undefined, 'an empty numeric scan never converts its query');
assert.strictEqual(Index.findRequired(undefined || [], 7), undefined, 'an optional absent numeric catalog stays empty');
assert.throws(() => Index.findRequired(Array(1), 7), TypeError, 'an optional numeric find still visits sparse holes');
assert.strictEqual(Index.findFinite([{ selfId: 7 }, null], 7)?.selfId, 7);
assert.strictEqual(Index.findFinite([], symbol), undefined, 'an empty finite scan never converts its query');
assert.throws(() => Index.findFinite([null, { selfId: 7 }], 7), TypeError);
assert.throws(() => Index.findLast(Object.assign(Array(2), { 1: { selfId: 7 } }), 7), TypeError, 'LAST builders retain sparse-row errors');
assert.strictEqual(Index.currentLastIndex(undefined).size, 0, 'current optional source retains the empty fallback');
console.log('Item template index FIRST/LAST, ID types, lifetimes and required-input checks passed');
