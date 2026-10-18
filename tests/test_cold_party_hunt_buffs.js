const assert = require('assert');

require('../src/Global');
// This file reads the developer telemetry counter of party buff casts.
options.default.BotPopulation.developerDiagnostics = true;

const DataCache = invoke('GameServer/DataCache');
const ColdCombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const BackgroundPartyResolver = invoke('GameServer/Bot/Population/BackgroundPartyResolver');
const PopulationMetrics = invoke('GameServer/Bot/Population/PopulationMetrics');

DataCache.init();

// F23: an ordinary cold party hunt casts the party buffs with the same
// function as the raid preparation, when the earliest buff is about to expire.
const timestamp = 1_750_000_000_000;
const BUFF_MS = 1_200_000;
const member = (characterId, classId, role) => {
    const base = {
        characterId, name: `Hunt${characterId}`, level: 40, activity: 'hunting',
        vitals: { hp: 2000, maxHp: 2000, mp: 1500, maxMp: 1500 },
        stats: { classId }, inventory: {}, party: { role }
    };
    const snapshot = ColdCombatProfile.legacySnapshot(base, ColdCombatProfile.skillRecordsFromTree(classId, 40), timestamp);
    return { ...base, stats: { classId, coldCombat: { ...snapshot, effects: [] } } };
};
const spot = {
    id: 'party_buff_field', name: 'Party buff field', avgLevel: 1, density: 1, npcSelfIds: [],
    rewards: { exp: 10, sp: 2, adenaMin: 1, adenaMax: 1 }, mob: { hp: 100000, damage: 1 }
};
const hunt = (members, at, stats = {}) => BackgroundPartyResolver.resolve({
    party: { partyId: 'cold_hunt_buffs', cohesion: 1, risk: 0, roleCoverage: {}, stats },
    members, spot, elapsedMs: 12000, timestamp: at, rng: () => 0.1
});
const stateOf = (result, index, members) => ({
    ...members[index],
    vitals: result.memberResults[index].result.patch.vitals,
    stats: result.memberResults[index].result.patch.stats
});
const effects = (result, index) => result.memberResults[index].result.patch.stats.coldCombat.effects || [];

const members = [member(1, 52, 'buffer'), member(2, 0, 'dps'), member(3, 0, 'dps')];
const first = hunt(members, timestamp);
assert(first.debug.partyBuffCasts > 0, 'an ordinary party hunt must cast the party buffs when none are active');
assert(effects(first, 1).some((effect) => effect.key.startsWith('chant_of')), 'a fighter must carry the Warcryer chant after the hunt');
assert(first.memberResults[0].result.patch.vitals.mp < members[0].vitals.mp, 'the cast spends the provider MP');
assert.strictEqual(members[1].stats.coldCombat.effects.length, 0, 'the caller input is not mutated');

const soon = hunt(members.map((_, index) => stateOf(first, index, members)), timestamp + 60000);
assert.strictEqual(soon.debug.partyBuffCasts || 0, 0, 'fresh buffs are not recast');

const late = hunt(members.map((_, index) => stateOf(first, index, members)), timestamp + BUFF_MS - 60000);
assert(late.debug.partyBuffCasts > 0, 'buffs about to expire are cast again');

// A party where no member has a cold party buff casts nothing and returns
// its members as they are.
const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const fighters = [member(4, 0, 'dps'), member(5, 0, 'dps'), member(6, 0, 'tank')];
const plain = BackgroundResolver.castHuntPartyBuffs(fighters, timestamp);
assert.strictEqual(plain.buffCasts, 0);
assert.strictEqual(plain.members, fighters, 'a party without a buffer keeps its members');
assert(BackgroundResolver.castHuntPartyBuffs(members, timestamp).buffCasts > 0, 'a party with a buffer still casts');

const originalCounters = PopulationMetrics.counters;
const originalSummary = PopulationMetrics.lastSummaryCounters;
PopulationMetrics.counters = Object.fromEntries(Object.keys(PopulationMetrics.counters).map((key) => [key, 0]));
PopulationMetrics.lastSummaryCounters = { ...PopulationMetrics.counters };
PopulationMetrics.recordCombat(first.debug);
PopulationMetrics.recordCombat(late.debug);
assert.strictEqual(PopulationMetrics.snapshot().delta.partyBuffCasts, first.debug.partyBuffCasts + late.debug.partyBuffCasts,
    'population telemetry must count party buff casts of ordinary hunts');
// The cold worker records each member's debug, not the outer aggregate:
// the owner (index 0) carries the casts once, the others none.
const memberDebug = (result, index) => result.memberResults[index].result.debug;
assert.strictEqual(memberDebug(first, 0).partyBuffCasts, first.debug.partyBuffCasts);
assert.strictEqual(memberDebug(first, 1).partyBuffCasts, undefined, 'only the telemetry owner carries the casts');
PopulationMetrics.snapshot(); // a snapshot starts the next delta
first.memberResults.forEach((_, index) => PopulationMetrics.recordCombat(memberDebug(first, index)));
assert.strictEqual(PopulationMetrics.snapshot().delta.partyBuffCasts, first.debug.partyBuffCasts,
    'the worker path counts the party buff casts once per party resolve');
PopulationMetrics.counters = originalCounters;
PopulationMetrics.lastSummaryCounters = originalSummary;

console.log('cold party hunt buffs ok');
