'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Goals = invoke('GameServer/Bot/Goals/GoalService');
const State = invoke('GameServer/Bot/Goals/GoalState');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const decisions = invoke('GameServer/Bot/Population/ColdSimulationCoordinator').economyDecisions;
const originals = { snapshot: State.snapshot, set: State.set, decided: decisions.decided, forState: Economy.forState };
const bot = { characterId: 2004384, name: 'Baran', phase: 'cold', activity: 'shopping', level: 31,
    adena: 33749393, currentRegion: 'Giran', inventory: {},
    vitals: { hp: 978, maxHp: 978, mp: 263, maxMp: 344 },
    stats: { classId: 56, clanId: 6000050, money: [468794, 2.14e-6, 7650, 0, 7.13e-5, 11880, 736] } };
let snapshot = { characterId: bot.characterId, current: { type: 'upgrade_gear', status: 'active',
    nextReviewAt: Date.now() + 60000, target: { itemId: 166, amount: 1, adena: 1223467 },
    plan: { expectedBenefit: 'market_search_for_gear', marketTown: 'Giran', wishKey: 'power:166:7' } } };
let decision = { inputHash: 12, activity: { activity: 'shopping', sourceType: 'npc', town: 'Giran',
    rootKey: 'stock:scrolls', itemId: 736, amount: 10, heldAtDecision: 0, price: 11880, unitPrice: 1188, r: 7.13e-5 } };
(async () => {
    try {
        State.snapshot = () => snapshot;
        State.set = async (id, goal) => (snapshot = { characterId: id, current: goal });
        decisions.decided = () => decision;
        Economy.forState = () => { throw Error('arrival must not rebuild the income forecast on main'); };
        const fresh = await Goals.currentForMarket(bot);
        assert.equal(fresh.current.type, 'buy_craft_material');
        assert.equal(fresh.current.target.itemId, 736, 'arrival uses the selected scroll refill instead of the departure weapon goal');
        assert.equal(fresh.current.target.amount, 10);
        assert.equal(fresh.current.plan.valueRate, 7.13e-5, 'the selected card retains its native funding terms');
        decision = { inputHash: 13, activity: { ...decision.activity, rootKey: 'power:166:7',
            itemId: 166, amount: 1, price: 1223467, unitPrice: 1223467, r: 1.6e-5 } };
        const gear = await Goals.currentForMarket({ ...bot,
            inventory: { 736: { selfId: 736, amount: 10 } } });
        assert.equal(gear.current.type, 'upgrade_gear');
        assert.equal(gear.current.target.itemId, 166, 'the next town pass can buy the selected weapon after refill');
        decisions.decided = () => { throw Error('a hunting bot retains its active goal without an arrival review'); };
        assert.equal(await Goals.currentForMarket({ ...bot, activity: 'hunting' }), snapshot);
        console.log('PASS market arrival: refresh active departure goal from the worker card, refill then gear, no main income calculation');
    } finally {
        State.snapshot = originals.snapshot; State.set = originals.set;
        decisions.decided = originals.decided; Economy.forState = originals.forState;
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
