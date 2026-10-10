const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const ProgressionRates = invoke('GameServer/ProgressionRates');
const BackgroundDropResolver = invoke('GameServer/Bot/Population/BackgroundDropResolver');
const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const BackgroundPartyResolver = invoke('GameServer/Bot/Population/BackgroundPartyResolver');

DataCache.init();

const spot = {
    id: 'starter_gremlin',
    name: 'Gremlin field',
    avgLevel: 1,
    density: 1,
    npcSelfIds: [1],
    rewards: { exp: 10, sp: 2, adenaMin: 7, adenaMax: 10 },
    mob: { hp: 8, damage: 1 }
};

const direct = BackgroundDropResolver.rollForFight({ spot, killerLevel: 1, rng: () => 0 });
assert.strictEqual(direct.length, 2, 'cold loot must roll every normal drop group, like the hot NPC path');
assert.strictEqual(direct[0].selfId, 1121, 'the selected item must come from the real Gremlin rewards');
assert.strictEqual(direct[0].kind, 'Armor.Wear');
assert.strictEqual(direct[0].sourceMobLevel, 1, 'background loot must retain the source-mob level for sale policy');
assert.strictEqual(direct[1].selfId, 1864, 'a later guaranteed material group must not be discarded');

const mixedRewardRoll = BackgroundDropResolver.rollRewardsForFight({
    spot: {
        avgLevel: 67,
        npcEntries: [{ selfId: 1509, count: 1 }],
        npcSelfIds: [1509],
        npcNames: ['Splinter Stakato Walker']
    },
    killerLevel: 67,
    npcSelfId: 1509,
    rng: () => 0
});
assert(mixedRewardRoll.adena > 0, 'a mixed reward group may select its Adena entry');
assert(!mixedRewardRoll.items.some((item) => [2391, 4082].includes(item.selfId)),
    'a mixed group must not also award one of the item alternatives after selecting Adena');

const originalRewardGroupRoll = ProgressionRates.rewardGroupRoll;
let rolledNpcLevel = null;
ProgressionRates.rewardGroupRoll = (group, kind, context, rng) => {
    rolledNpcLevel = context.npcLevel;
    return originalRewardGroupRoll(group, kind, context, rng);
};
BackgroundDropResolver.rollForFight({ spot: { ...spot, avgLevel: 99 }, killerLevel: 1, npcSelfId: 1, rng: () => 0 });
ProgressionRates.rewardGroupRoll = originalRewardGroupRoll;
assert.strictEqual(rolledNpcLevel, 1, 'deep-blue rules must use the defeated NPC level, not the spot average');

const nameOnly = BackgroundDropResolver.rollForFight({
    spot: { ...spot, npcSelfIds: [], npcNames: ['Gremlin'] },
    killerLevel: 1,
    rng: () => 0
});
assert.strictEqual(nameOnly[0].selfId, 1121, 'world spots without reward ids must resolve the real drop list by NPC name');

const state = {
    characterId: 71,
    name: 'ColdHunter',
    level: 1,
    levelBand: '1-3',
    activity: 'hunting',
    vitals: { hp: 100, maxHp: 100, mp: 50, maxMp: 50 },
    stats: {},
    party: { role: 'dps' }
};
const result = BackgroundResolver.resolveSolo({ state, spot, elapsedMs: 12000, rng: () => 0 });
assert.strictEqual(result.materialize.items.length, 2);
assert.strictEqual(result.materialize.items[0].selfId, 1121);
assert.strictEqual(result.materialize.items[0].name, "Apprentice's Shoes");
assert.strictEqual(result.materialize.items[0].kind, 'Armor.Wear');
assert.strictEqual(result.materialize.adena, 7, 'cold combat must roll the exact NPC Adena group');

const partyResult = BackgroundPartyResolver.resolve({
    party: { partyId: 'drop_party', cohesion: 1, risk: 0, roleCoverage: {} },
    members: [{ ...state, characterId: 72 }, { ...state, characterId: 73 }],
    spot,
    elapsedMs: 10000,
    rng: () => 0
});
const partyItems = partyResult.memberResults.flatMap((entry) => entry.result.materialize.items);
assert.strictEqual(partyItems[0].selfId, 1121, 'party rewards should use the same real drop data');

console.log('Bot background drop checks passed');

// perf C3: a cold resolve adds loot to a stack and Adena to the wallet row
// without dropping the rows' other fields (one row, one shape; a shape flip
// changed the economy review's input key).
(async () => {
    const Life = invoke('GameServer/Bot/Population/BotLifeState');
    const full = (selfId, amount, kind) => ({ selfId, name: `Item ${selfId}`, amount, equipped: false, equippedCount: 0,
        equippedSlots: [], stackable: true, slot: 0, rank: 'none', kind, enchant: 0 });
    const bagged = { ...state, level: 3, levelBand: '1-3', exp: 400, stats: { classId: 0 }, phase: 'cold', spotId: spot.id, adena: 100, loc: { locX: 0, locY: 0, locZ: 0 }, timing: {},
        inventory: { 57: full(57, 100, 'Other.None'), 1864: full(1864, 3, 'Other.Material') } };
    const looted = BackgroundResolver.resolveSolo({ state: bagged, spot, elapsedMs: 12000, rng: () => 0 });
    const projected = await Life.prepareResolve(bagged, looted, { persist: false, timestamp: 1800000000000, projectClassProgression: true });
    const gained = looted.materialize.items.filter(item => item.selfId === 1864).reduce((sum, item) => sum + item.amount, 0);
    assert(gained > 0 && looted.materialize.adena > 0, 'the fight loots the material and Adena');
    assert.deepStrictEqual(projected.inventory[1864], { ...full(1864, 3 + gained, 'Other.Material'), name: projected.inventory[1864].name },
        'a looted stack keeps its fields');
    assert.deepStrictEqual(projected.inventory[57], full(57, projected.adena, 'Other.None'), 'the Adena row keeps its fields');
    console.log('test_bot_background_drops: row shape ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
