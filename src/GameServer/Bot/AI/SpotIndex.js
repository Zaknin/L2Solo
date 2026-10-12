// One lookup table per spot list: spot id -> spot. Every lookup of a spot by
// its id in a spot list (the world's spots, the profile catalogue, a worker's
// planning list) reads this table instead of scanning the list or keeping a
// table of its own.
const tables = new WeakMap();
const EMPTY = Object.freeze([]);

function tableFor(spots) {
    let built = tables.get(spots);
    // A list filled in place (the cold worker's) gets a new table. The list's
    // length is compared, not the table's size: a repeated id must not make
    // every lookup rebuild the table.
    if (!built || built.length !== spots.length) {
        built = { length: spots.length, table: new Map(spots.map((spot) => [String(spot.id), spot])) };
        tables.set(spots, built);
    }
    return built.table;
}

function spotById(spots, spotId) {
    return Array.isArray(spots) ? tableFor(spots).get(String(spotId)) || null : null;
}

// Physical topology uses the same canonical last row as spotById, without
// constructing a loot/planner view. Build only when this reverse is requested.
function spotsForNpc(spots, npcId) {
    if (!Array.isArray(spots)) return null;
    const table = tableFor(spots), built = tables.get(spots);
    if (!built.byNpc) {
        built.byNpc = new Map();
        for (const spot of table.values()) {
            const seen = new Set();
            for (const entry of spot.npcEntries || []) {
                const id = Number(entry.selfId);
                if (!Number.isSafeInteger(id) || id < 1 || seen.has(id)) continue;
                seen.add(id);
                if (!built.byNpc.has(id)) built.byNpc.set(id, []);
                built.byNpc.get(id).push(spot);
            }
        }
        for (const rows of built.byNpc.values()) Object.freeze(rows);
    }
    return built.byNpc.get(Number(npcId)) || EMPTY;
}

module.exports = { tableFor, spotById, spotsForNpc };
