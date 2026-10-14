const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const HealingPotionStock = invoke('GameServer/Bot/AI/HealingPotionStock');
const DangerMoment = invoke('GameServer/Bot/AI/DangerMoment');

DataCache.init();

// E70: the danger moment compares drinking, fleeing, sitting and fighting on
// in the bot's hours (§13.6).
const base = { hp: 30, maxHp: 100, survivalRatio: 0.9, attacked: true, potion: { heal: 112, price: 50 },
    restHours: 0.02, deathHours: 0.5, moneyPrice: 1 / 10000, riskWeight: 1.5, roll: 0.5 };

assert.strictEqual(DangerMoment.decide(base).action, 'drink',
    'a wounded melee bot losing the race drinks a cheap potion instead of running');
assert.strictEqual(DangerMoment.decide({ ...base, hp: 100, survivalRatio: 3 }).action, 'fight',
    'a healthy bot winning the race keeps fighting');
// Live values: the admitted margin 1.5 at full HP, 8 s of rest, 30 s left to kill.
const live = { ...base, hp: 100, survivalRatio: 1.5, restHours: 8 / 3600, fightHours: 30 / 3600 };
assert.strictEqual(DangerMoment.decide(live).action, 'fight', 'a healthy bot does not run from an admitted mob');
assert.strictEqual(DangerMoment.decide({ ...live, hp: 95, survivalRatio: 1.425 }).action, 'fight',
    'one hit taken is no reason to drink');
assert.strictEqual(DangerMoment.decide({ ...base, potion: null }).action, 'flee',
    'without a potion a bot losing the race runs');
assert.strictEqual(DangerMoment.decide({ ...base, attacked: false, potion: null }).action, 'sit',
    'with nobody hitting it a wounded bot sits instead of running');
assert.notStrictEqual(DangerMoment.decide({ ...base, attacked: false }).action, 'flee',
    'nothing to run from when nobody attacks');
assert.strictEqual(DangerMoment.decide({ ...base, moneyPrice: 1 / 10 }).action, 'flee',
    'a potion priced above the risk it removes is not drunk');
assert.strictEqual(DangerMoment.decide({ ...base, survivalRatio: null }), null,
    'an unknown matchup leaves the author rule in place');
// Caution and resilience (riskWeight) move the same moment: a cautious bot
// drinks where a resilient one still fights.
const edge = { ...base, hp: 60, survivalRatio: 1.2, potion: { heal: 112, price: 300 } };
assert.strictEqual(DangerMoment.decide({ ...edge, riskWeight: 4 }).action, 'drink');
assert.strictEqual(DangerMoment.decide({ ...edge, riskWeight: 0.67 }).action, 'fight');

// Hot side: the moment reads the held economy and the live fight.
function item(selfId, amount, objectId = selfId + 100000) {
    return { fetchSelfId: () => selfId, fetchAmount: () => amount, fetchId: () => objectId };
}
let hp = 30;
const used = [];
const actor = {
    effects: {}, fetchId: () => 42, fetchClassId: () => 0, fetchLevel: () => 10,
    fetchHp: () => hp, fetchMaxHp: () => 100, fetchMp: () => 50, fetchMaxMp: () => 50,
    fetchPAtk: () => 100, fetchPDef: () => 100, fetchAtkSpd: () => 300, fetchMAtk: () => 10, fetchCastSpd: () => 333,
    state: { fetchDead: () => false, fetchCasts: () => false },
    canUseSkill: () => true,
    backpack: {
        fetchItems: () => [item(1060, 3)],
        buildItemSkill: () => ({ fetchSelfId: () => 2031 }),
        useItem: (_session, objectId) => used.push(objectId)
    }
};
const mob = { fetchId: () => 7001, fetchHp: () => 80, fetchMaxHp: () => 100, isDead: () => false,
    matchupTarget: { maxHp: 100, pAtk: 100, pDef: 100, atkSpd: 300, vulnerabilities: {} } };
const session = { coldLifeState: { stats: { decisionSeq: 3 } }, economySeq: 3,
    heldEconomy: { deathHours: 0.5, riskWeight: 1.5, moneyPrice: 1 / 10000, network: { activity: null } } };

assert.strictEqual(DangerMoment.forActor(session, actor, mob, { attackers: [mob] }).action, 'drink',
    'the hot moment at 30% HP against a fresh mob drinks');
assert(HealingPotionStock.tryUseInCombat(session, actor, mob, { dangerMoment: true }), 'the moment drinks');
hp = 50;
assert(HealingPotionStock.tryUseInCombat(session, actor, mob, { dangerMoment: true }),
    'the author cap of one potion per target gives way to the moment (E70)');
assert.strictEqual(used.length, 2);
hp = 30;
assert.strictEqual(HealingPotionStock.tryUseInCombat(session, actor, mob), null,
    'the fixed-ratio potion step yields to the moment the bot took for this target');
assert.strictEqual(DangerMoment.forActor({}, actor, mob, { attackers: [mob] }), null,
    'no held economy: the author rule decides');

console.log('Bot danger moment tests passed');
