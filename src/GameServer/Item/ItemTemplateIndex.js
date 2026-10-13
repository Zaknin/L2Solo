'use strict';

let indexes = new WeakMap();
const lastObservers = new WeakMap();
const lastCandidates = new WeakMap();
let lastSourceRevisions = new WeakMap();
let lastInvalidation = 0;
const EMPTY_ITEMS = [];
let finiteIndexes = new WeakMap();

// Catalog IDs/order are immutable after loading. Replacing the array or changing
// its length rebuilds automatically; in-place ID/order edits must invalidate it.
function indexFor(items) {
    if (!Array.isArray(items)) return null;
    let index = indexes.get(items);
    if (index && index.length === items.length) return index;
    index = { length: items.length, numeric: new Map(), strict: new Map(), scanRequired: false };
    for (let position = 0; position < items.length; position++) {
        const item = items[position];
        if (!item) {
            index.scanRequired = true;
            continue;
        }
        const id = item.selfId;
        // Array.find returns the first match, including duplicate catalog IDs.
        if (!index.strict.has(id)) index.strict.set(id, item);
        let numericId;
        try { numericId = Number(id); }
        catch (error) {
            index.scanRequired = true;
            index.numericError ||= error;
            continue;
        }
        if (!Number.isNaN(numericId) && !index.numeric.has(numericId)) index.numeric.set(numericId, item);
    }
    indexes.set(items, index);
    return index;
}

function find(items, selfId) {
    const id = Number(selfId);
    if (Number.isNaN(id)) return undefined;
    const index = indexFor(items);
    if (index?.numericError) throw index.numericError;
    return index?.numeric.get(id);
}

function findStrict(items, selfId) {
    if (Number.isNaN(selfId)) return undefined;
    const index = indexFor(items);
    if (index?.numericError) throw index.numericError;
    return index?.strict.get(selfId);
}

// These readers used an unguarded Array.find: an absent catalog is an error.
function findRequired(items, selfId) {
    if (!Array.isArray(items)) return items.find(item => Number(item.selfId) === Number(selfId));
    if (!items.length) return undefined;
    if (indexFor(items).scanRequired) return items.find(item => Number(item.selfId) === Number(selfId));
    return find(items, selfId);
}

function findStrictRequired(items, selfId) {
    if (!Array.isArray(items)) return items.find(item => item.selfId === selfId);
    if (indexFor(items).scanRequired) return items.find(item => item.selfId === selfId);
    return findStrict(items, selfId);
}

function hasStrictRequired(items, selfId) {
    if (!Array.isArray(items)) return items.some(item => item.selfId === selfId);
    const index = indexFor(items);
    if (index.scanRequired) return items.some(item => item.selfId === selfId);
    return !Number.isNaN(selfId) && index.strict.has(selfId);
}

// Dual-sword recipes compare the converted row ID with the raw product ID.
function findNumericRowRequired(items, selfId) {
    if (!Array.isArray(items)) return items.find(item => Number(item.selfId) === selfId);
    if (indexFor(items).scanRequired) return items.find(item => Number(item.selfId) === selfId);
    return typeof selfId === 'number' && !Number.isNaN(selfId)
        ? indexFor(items).numeric.get(selfId) : undefined;
}

function finiteId(value) {
    const id = Number(value);
    return Number.isFinite(id) ? id : 0;
}

function findFinite(items, selfId) {
    if (!items) return undefined;
    if (!Array.isArray(items)) return items.find(item => finiteId(item.selfId) === finiteId(selfId));
    if (!items.length) return undefined;
    let index = finiteIndexes.get(items);
    if (!index || index.length !== items.length) {
        index = { length: items.length, rows: new Map(), scanRequired: false };
        for (const item of items) {
            try {
                const id = finiteId(item.selfId);
                if (!index.rows.has(id)) index.rows.set(id, item);
            } catch {
                index.scanRequired = true;
            }
        }
        finiteIndexes.set(items, index);
    }
    if (index.scanRequired) return items.find(item => finiteId(item.selfId) === finiteId(selfId));
    return index.rows.get(finiteId(selfId));
}

function sameLastRows(left, right) {
    if (!left || left.size !== right.size) return false;
    for (const [id, row] of right) {
        if (!left.has(id) || left.get(id) !== row) return false;
    }
    return true;
}

// Each module observes only its current source. A source transition, including
// A -> B -> A, starts a new snapshot; appends freeze identity-only readers.
// Equal key/row-reference snapshots share one latest candidate per source.
function lastIndex(items, observer = lastIndex, byLength = false) {
    const source = items || EMPTY_ITEMS;
    const revision = byLength ? lastSourceRevisions.get(source) || 0 : 0;
    let view = lastObservers.get(observer);
    if (view && view.source === source && (!byLength || (view.length === source.length
        && view.revision === revision && view.invalidation === lastInvalidation))) return view.rows;
    const fresh = Array.isArray(source) ? currentLastIndex(source)
        : new Map(source.map(item => [Number(item.selfId), item]));
    const candidate = lastCandidates.get(source);
    const rows = sameLastRows(candidate, fresh) ? candidate : fresh;
    lastCandidates.set(source, rows);
    view = { source, length: source.length, rows, revision, invalidation: lastInvalidation };
    lastObservers.set(observer, view);
    return rows;
}

function findLast(items, selfId, observer = findLast) {
    return lastIndex(items, observer).get(Number(selfId));
}

function findLastByLength(items, selfId, observer = findLastByLength) {
    return lastIndex(items, observer, true).get(Number(selfId));
}

// A market detail request owns a current snapshot, including same-array edits.
// Unlike frozen readers, this boundary intentionally rebuilds on every request.
function currentLastIndex(items) {
    const rows = new Map();
    for (const item of items || []) rows.set(Number(item.selfId), item);
    return rows;
}

function invalidate(items) {
    if (items) {
        indexes.delete(items);
        lastSourceRevisions.set(items, (lastSourceRevisions.get(items) || 0) + 1);
        finiteIndexes.delete(items);
    } else {
        indexes = new WeakMap();
        lastSourceRevisions = new WeakMap();
        lastInvalidation++;
        finiteIndexes = new WeakMap();
    }
}

module.exports = { find, findStrict, findRequired, findStrictRequired, hasStrictRequired,
    findNumericRowRequired, findFinite, findLast, findLastByLength, lastIndex,
    currentLastIndex, invalidate };
