'use strict';

// Grant relations read the actual supplied newbie source. Current readers keep
// fresh sets; identity-only readers retain only their own current observation.
const observations = new WeakMap();
const EMPTY = Object.freeze([]);
const numericId = row => Number(row.selfId);
function firstClassRow(source, classId) {
    return require('../ClassProgression').firstClassRow(source, classId, 'strict');
}
function grants(source, classId) {
    if (arguments.length > 1) return (source == null ? undefined : firstClassRow(source, classId))?.items || EMPTY;
    return (source || EMPTY).flatMap(row => row.items || EMPTY);
}
function ids(source, equippedOnly = false, classId) {
    const rows = arguments.length > 2 ? grants(source, classId) : grants(source);
    return new Set(rows.filter(row => !equippedOnly || (equippedOnly === 'strict' ? row.equipped === true : row.equipped)).map(numericId));
}
// The imported PK template requires every class row to carry its items array.
function importIds(source) { return new Set(source.flatMap(row => row.items.map(numericId))); }

function snapshotIds(source, observer) {
    let view = observations.get(observer);
    if (!view) {
        view = { source: null, ids: new Set() };
        observations.set(observer, view);
    }
    if (view.source !== source) {
        // Publish the observed source before construction. The old disposition
        // reader retained prior IDs after a failed transition and did not retry
        // that same source; the first failed source retains its initial empty set.
        view.source = source;
        view.ids = ids(source);
    }
    return view.ids;
}
module.exports = { firstClassRow, grants, ids, importIds, snapshotIds };
