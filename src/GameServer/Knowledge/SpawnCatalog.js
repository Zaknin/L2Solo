'use strict';

const DataCache = invoke('GameServer/DataCache');
const ItemTemplateIndex = require('../Item/ItemTemplateIndex');
const { revisionOf } = require('./CatalogueRevision');
const EMPTY = Object.freeze([]);
let current = null;

function spawnsForNpc(npcId) {
    const groups = DataCache.npcSpawns;
    if (!Array.isArray(groups)) return null;
    if (!current || current.groups !== groups || current.length !== groups.length) {
        const byNpc = new Map();
        for (const group of groups) {
            for (const definition of group.spawns || []) {
                const id = Number(definition.selfId);
                if (!Number.isSafeInteger(id) || id < 1) continue;
                if (!byNpc.has(id)) byNpc.set(id, []);
                byNpc.get(id).push(Object.freeze({ group, definition }));
            }
        }
        for (const rows of byNpc.values()) Object.freeze(rows);
        current = { groups, length: groups.length, byNpc };
    }
    return current.byNpc.get(Number(npcId)) || EMPTY;
}

// Native IDs address raw spawn groups (selfId); exported IDs address exported
// definitions. spawnsForNpc retains every native definition, including repeated
// group IDs, so a first-match group lookup never removes a variant from it.
function spawn(id) {
    return ItemTemplateIndex.findStrict(DataCache.npcSpawns, id) || null;
}

function potentialSpawnData() {
    const groups = DataCache.npcSpawns;
    if (!Array.isArray(groups)) return null;
    return { kind: 'potential_definitions', origin: 'native', revision: revisionOf(groups),
        groups, totalSemantics: 'per_explicit_coordinate_or_random_total_in_bounds',
        periodSemantics: 'day_or_night_otherwise_always', population: 'definition_only' };
}

module.exports = { spawnsForNpc, spawn, potentialSpawnData };
