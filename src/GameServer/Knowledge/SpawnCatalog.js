'use strict';

const DataCache = invoke('GameServer/DataCache');
const ItemTemplateIndex = require('../Item/ItemTemplateIndex');
const { revisionOf } = require('./CatalogueRevision');
const EMPTY = Object.freeze([]);
let current = null;
const zoneNpcIds = new WeakMap();

function sourceFor() {
    const groups = DataCache.npcSpawns;
    if (!Array.isArray(groups)) return null;
    if (!current || current.groups !== groups || current.length !== groups.length) {
        current = { groups, length: groups.length };
    }
    return current;
}

function spawnsForNpc(npcId) {
    const source = sourceFor();
    if (!source) return null;
    if (!source.byNpc) {
        const byNpc = new Map();
        for (const group of source.groups) {
            for (const definition of group.spawns || []) {
                const id = Number(definition.selfId);
                if (!Number.isSafeInteger(id) || id < 1) continue;
                if (!byNpc.has(id)) byNpc.set(id, []);
                byNpc.get(id).push(Object.freeze({ group, definition }));
            }
        }
        for (const rows of byNpc.values()) Object.freeze(rows);
        source.byNpc = byNpc;
    }
    return source.byNpc.get(Number(npcId)) || EMPTY;
}

// Raw-zone order and native centroid arithmetic, including uncoerced source
// coordinates. Merchant locations and distances are evaluated by the caller.
function boundedSpawnZones() {
    const source = sourceFor();
    if (!source) return null;
    if (!source.boundedZones) {
        const rows = [];
        source.groups.forEach(group => {
            if (!group.bounds || group.bounds.length === 0) return;
            let sumX = 0, sumY = 0;
            group.bounds.forEach(point => {
                sumX += point.locX;
                sumY += point.locY;
            });
            rows.push(Object.freeze({ group, centerX: sumX / group.bounds.length,
                centerY: sumY / group.bounds.length }));
        });
        source.boundedZones = Object.freeze(rows);
    }
    return source.boundedZones;
}

// Strict Set semantics retain number/string distinctions and first spawn
// order. The borrowed relation follows replacement/growth of a zone's rows.
function npcIdsForSpawnZone(zone) {
    const spawns = zone.spawns;
    if (!spawns) return EMPTY;
    let prepared = zoneNpcIds.get(zone);
    if (!prepared || prepared.spawns !== spawns || prepared.length !== spawns.length) {
        const ids = new Set();
        spawns.forEach(spawn => ids.add(spawn.selfId));
        prepared = { spawns, length: spawns.length, ids: Object.freeze([...ids]) };
        zoneNpcIds.set(zone, prepared);
    }
    return prepared.ids;
}

// Observer contract: last raid-marked template, first spawn per numeric ID,
// and spawn-file order. Borrow payloads; presentation/respawn stay with readers.
function raidBossDefinitions() {
    const source = sourceFor(), npcs = DataCache.npcs;
    if (!source || !Array.isArray(npcs)) return null;
    if (!source.raids || source.npcs !== npcs || source.npcsLength !== npcs.length) {
        const templates = new Map();
        for (const npc of npcs) if (npc?.template?.raidBoss === true) templates.set(Number(npc.selfId), npc);
        const seen = new Set(), rows = [];
        for (const group of source.groups) for (const spawn of group?.spawns || EMPTY) {
            const npc = templates.get(Number(spawn?.selfId)), id = Number(spawn?.selfId || 0);
            if (!npc || !Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
            seen.add(id);
            rows.push(Object.freeze({ spawn, npc }));
        }
        source.npcs = npcs; source.npcsLength = npcs.length;
        source.raids = Object.freeze(rows);
    }
    return source.raids;
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

module.exports = { spawnsForNpc, spawn, potentialSpawnData, raidBossDefinitions, boundedSpawnZones, npcIdsForSpawnZone };
