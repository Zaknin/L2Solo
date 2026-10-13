'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Routes = invoke('GameServer/Bot/AI/LevelingRoutes');
const Matchup = invoke('GameServer/Bot/AI/BotTargetMatchup');
const drain = iterator => { let step; do step = iterator.next(); while (!step.done); return step.value; };
const timestamp = 1791825000000;
// The native C-grade kit and source species from the stalled level-55 spoiler.
const state = { characterId: 990003, level: 55, spotId: '17_20',
    vitals: { hp: 2500, mp: 700 }, stats: { race: 4, classId: 55,
        coldCombat: { classId: 55, skillSource: 'native', skills: [] } },
    inventory: Object.fromEntries([161, 1149, 354, 381, 631, 2452, 2429, 852, 882, 914].map((id, index) => {
        const item = Data.items.find(item => item.selfId === id);
        return [id, { selfId: id, amount: 1, equipped: true, equippedCount: 1,
            slot: Number(item.etc.slot), rank: item.etc.rank, kind: item.template.kind,
            instances: [{ id: 9900000 + index, amount: 1, equipped: true, slot: Number(item.etc.slot), enchant: 0 }] }];
    })) };
const spot = { id: '17_20', name: 'Thunder Wyrm fields', minLevel: 47, maxLevel: 66,
    avgLevel: 52, capacity: 8, density: 6, levelCounts: { 53: 4, 66: 2 }, tags: [],
    center: { locX: 105073, locY: 121810, locZ: -3531 },
    npcEntries: [{ selfId: 242, level: 53, count: 4 }, { selfId: 707, level: 66, count: 2 }],
    npcSelfIds: [242, 707] };
assert(Planner.soloSafeForSource(state, { npcId: 242, npcLevel: 53 }), 'the individual-source gate admits the gargoyle');
assert.equal(Routes.isSpotAllowedForState(spot, state, { mode: 'solo', timestamp }), false,
    'the native executor refuses the whole spot for this kit');
const facts = options => drain(Planner.sourceFacts(state, 951, 1,
    { spots: [spot], timestamp, spotValue: () => ({ kills: 100, valueHours: 2 }), ...options }));
const gargoyle = facts().find(row => row.npcId === 242 && row.kind === 'drop');
assert(gargoyle, 'the native gargoyle drops C weapon enchant scrolls');
assert.equal(gargoyle.reason, 'route_ineligible', 'an unsafe route cannot become a free enchant-scroll farm');
assert.deepEqual(facts({ readyOnly: true }), [], 'the wish reader receives no unreachable farm');

// A new decision must judge current combat state, while one projection shares
// the same spot verdict across all item sources and builds its profiles once.
const original = { gate: Routes.isSpotAllowedForState, profiles: Matchup.stateProfiles };
let gates = 0, profiles = 0;
try {
    Routes.isSpotAllowedForState = (_spot, _state, options) => {
        gates++; assert.equal(options.mode, 'solo'); assert.equal(options.timestamp, timestamp);
        assert.deepEqual(options.capacityStates, [state]); return true;
    };
    Matchup.stateProfiles = (...args) => { profiles++; return original.profiles(...args); };
    const routeAllowed = Planner.sourceRouteReader(state, { timestamp });
    assert(facts({ routeAllowed }).some(row => row.status === 'ready'), 'an allowed source remains available');
    facts({ routeAllowed });
    assert.equal(gates, 1, 'one spot gate per projection, not per material or NPC');
    assert.equal(profiles, 1, 'one combat profile set per projection');
    const tooLow = { ...spot, id: '8_2', minLevel: 43, maxLevel: 46, avgLevel: 45,
        levelCounts: { 43: 4, 46: 2 } };
    assert.equal(routeAllowed(tooLow), false, 'a safe spot outside the route level band is still refused');
    Routes.isSpotAllowedForState = () => false;
    assert.deepEqual(facts({ readyOnly: true }), [], 'a fresh decision discards the old allowed verdict');
} finally { Routes.isSpotAllowedForState = original.gate; Matchup.stateProfiles = original.profiles; }
console.log('test_source_route_admission: ok');
