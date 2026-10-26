// One lookup table per spot list: spot id -> spot. Every lookup of a spot by
// its id in a spot list (the world's spots, the profile catalogue, a worker's
// planning list) reads this table instead of scanning the list or keeping a
// table of its own.
const tables = new WeakMap();
const EMPTY = Object.freeze([]);
const weights = new WeakMap();

function indexFor(spots) {
    let built = tables.get(spots);
    // A list filled in place (the cold worker's) gets a new table. The list's
    // length is compared, not the table's size: a repeated id must not make
    // every lookup rebuild the table.
    if (!built || built.length !== spots.length) {
        built = { length: spots.length };
        tables.set(spots, built);
    }
    return built;
}

function tableFor(spots) {
    const built = indexFor(spots);
    if (!built.table) built.table = new Map(spots.map((spot) => [String(spot.id), spot]));
    return built.table;
}

// Occupancy's native Map contract: LAST row, SameValueZero keys, no string
// coercion. Share the source lifetime without changing the public string view.
function strictTableFor(spots) {
    if (!Array.isArray(spots)) return new Map();
    const built = indexFor(spots);
    if (!built.strictTable) built.strictTable = new Map(spots.map(spot => [spot.id, spot]));
    return built.strictTable;
}

function spotById(spots, spotId) {
    return Array.isArray(spots) ? tableFor(spots).get(String(spotId)) || null : null;
}

// A spot's place in its list (by identity, its first row), -1 for a spot
// the list does not hold: the index of a per-spot array a reader keeps over
// the list (GearAcquisitionPlanner.sourceGround). Built at the first ask.
function ordinalFor(spots, spot) {
    if (!Array.isArray(spots)) return -1;
    const built = indexFor(spots);
    if (!built.ordinals) {
        built.ordinals = new Map();
        for (let at = 0; at < spots.length; at++) if (!built.ordinals.has(spots[at])) built.ordinals.set(spots[at], at);
    }
    return built.ordinals.get(spot) ?? -1;
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

// Planner composition weights deliberately differ from physical integer
// counts: fractional weights are admitted, negatives/NaN contribute zero,
// and repeated numeric NPC IDs are summed in their original entry order.
function npcWeights(spot, npcId) {
    if (!spot) return null;
    const entries = spot.npcEntries || EMPTY;
    let built = weights.get(spot);
    if (!built || built.entries !== entries || built.length !== entries.length) {
        let totalCount = 0;
        const byNpc = new Map();
        for (const entry of entries) {
            const count = Math.max(0, Number(entry.count) || 0), id = Number(entry.selfId);
            totalCount += count;
            if (!Number.isNaN(id)) byNpc.set(id, (byNpc.get(id) || 0) + count);
        }
        built = { entries, length: entries.length, totalCount, byNpc };
        weights.set(spot, built);
    }
    return { count: built.byNpc.get(Number(npcId)) || 0, totalCount: built.totalCount };
}

module.exports = { tableFor, strictTableFor, spotById, ordinalFor, spotsForNpc, npcWeights };
