'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('crystal-fallback');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const DB = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
const Native = require('./helpers/nativeMarketFixture');
const Gear = invoke('GameServer/Bot/AI/BotGear');
const Crystals = invoke('GameServer/Bot/Economy/BotCrystallization');
const Service = invoke('GameServer/Bot/Economy/BotImprovementService');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Decision = invoke('GameServer/Bot/Population/ColdEconomyDecision');
const Luxury = invoke('GameServer/Bot/Economy/BotLuxuryExchange');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const town = { locX: 83396, locY: 147904, locZ: -3400 };
const field = { locX: 78088, locY: 124933, locZ: -2792 };
const template = id => Data.items.find(row => row.selfId === id);
const proposal = { kind: 'crystallize', sourceSelfId: 626, amount: 4 };
async function seed(id, crafter, outdoors, inputId = 626, copies = 4) {
    const classId = crafter ? 57 : 54, loc = outdoors ? field : town;
    await Native.character(DB, id, `CrystalBuyer${id}`, `bot_crystal_buyer_${id}`, loc);
    await DB.execute(['UPDATE characters SET level=49,classId=?,race=4,exp=? WHERE id=?', [classId, Data.experience[48], id]]);
    await DB.setItem(id, { selfId: 57, name: 'Adena', amount: 30000000 });
    await DB.setItem(id, { selfId: 1463, name: 'Soulshot: D-grade', amount: 100000 });
    for (const row of Gear.planFor({ classId, level: 20 }).items)
        await DB.setItem(id, { ...row, amount: 1, equipped: true, name: template(row.selfId).template.name });
    for (let i = 0; i < copies; i++) await DB.setItem(id, { selfId: inputId, name: template(inputId).template.name, amount: 1 });
    if (crafter) await DB.setSkill({ selfId: 248, name: 'Crystallize', level: 1, passive: true }, id);
    const state = { characterId: id, accountName: `bot_crystal_buyer_${id}`, name: `CrystalBuyer${id}`,
        level: 49, phase: 'cold', activity: 'hunting', currentRegion: outdoors ? 'Breka Orc Overlord fields' : 'Giran', loc,
        inventory: Life.inventorySummaryFromItems(await DB.fetchItems(id)), adena: 30000000,
        vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 }, stats: { classId } };
    state.stats.coldCombat = Profile.legacySnapshot(state, await DB.fetchSkills(id));
    return Life.upsertState(state, 'crystal_fixture');
}
async function apply(state, improvement) {
    const decision = Decision.capture({ riskWeight: 1, network: { activity: { activity: 'improving', improvement } } }, state);
    return Service.reviewCold(state, { decide: () => decision });
}
async function run() {
    try {
        await DB.init(); await Life.init();
        let crafter = await seed(9751, true, true);
        const own = Crystals.choices(crafter, () => null, { known: false });
        assert(own.length, 'a learned crafter can break physical spares without a market or Giran route');
        assert.equal(own[0].net, Crystals.reward(template(626)).gross, 'self crystallization pays no service fee');
        const leaf = { activity: 'improving', improvement: { ...proposal, mode: 'self' } };
        assert.equal(Service.acquisitionTravel(crafter, leaf), null, 'own skill does not send the crafter to a service');
        const worn = (await DB.fetchItems(crafter.characterId)).filter(row => row.equipped);
        const broken = await apply(crafter, leaf.improvement);
        assert(broken.changed, 'the native cold command crystallizes outside town');
        crafter = broken.state;
        assert.equal(crafter.inventory[1458].amount, 4 * Crystals.reward(template(626)).gross);
        assert(!crafter.inventory[626]);
        assert.deepEqual((await DB.fetchItems(crafter.characterId)).filter(row => row.equipped), worn);
        assert.equal(crafter.adena, 30000000);
        assert.equal(crafter.currentRegion, 'Breka Orc Overlord fields');
        await assert.rejects(DB.applyBotImprovement(crafter.characterId, leaf.improvement, { coldState: crafter }), /improvement_source_changed/);

        crafter = await Life.upsertState({ ...crafter, activity: 'shopping', currentRegion: 'Giran', loc: town }, 'luxury_arrival');
        const exchanged = await apply(crafter, { kind: 'luxury_exchange', ...Luxury.recipes().get(883) });
        assert(exchanged.changed);
        assert(exchanged.state.inventory[883].equipped, 'the acquired crystals become a physically equipped C ring');
        assert.equal(exchanged.state.inventory[1458].amount, 4 * Crystals.reward(template(626)).gross - 130);
        assert((await DB.fetchItems(crafter.characterId)).some(row => row.selfId === 883 && row.equipped));

        let ordinary = await seed(9752, false, true);
        const bag = await DB.fetchItems(ordinary.characterId);
        await assert.rejects(DB.applyBotImprovement(ordinary.characterId, { ...proposal, mode: 'self' }, { coldState: ordinary }), /invalid_bot_crystallization/);
        assert.deepEqual(await DB.fetchItems(ordinary.characterId), bag, 'an unlearned self skill cannot bypass the native service');
        assert.equal((await apply(ordinary, { ...proposal, npcId: Crystals.npcId })).changed, false);
        ordinary = await Life.upsertState({ ...ordinary, activity: 'shopping', currentRegion: 'Giran', loc: town }, 'service_arrival');
        const serviced = await apply(ordinary, { ...proposal, npcId: Crystals.npcId });
        assert(serviced.changed);
        assert.equal(serviced.state.inventory[1458].amount, 4 * Crystals.reward(template(626)).net);
        assert.equal(serviced.state.adena, ordinary.adena);

        const board = new BoardIndex();
        board.put({ id: 1, ownerId: 9800, storeType: 1, kind: 'shop', town: 'Giran',
            lines: [{ lineId: 1, selfId: 1458, count: 0, enchant: 0, price: 1 },
                { lineId: 2, selfId: 626, count: 16, enchant: 0, price: 1 }] });
        const buyer = await seed(9753, false, false);
        const inputBuyer = { ...buyer, inventory: { ...buyer.inventory } };
        delete inputBuyer.inventory[626];
        Economy.reset();
        const context = Economy.forState(inputBuyer, { board, spots: [], rememberContext: false, npcOffersFor: () => [],
            routeRows: require('../src/GameServer/Bot/Economy/EconomicTrip').towns.map(() => [true, 0, 0]),
            workshop: { known: true, recipeId: 0, incomePerHour: 0 } });
        assert.equal(context.network.activity.itemId, 626, 'sold-out crystals select a real dismantling input instead of waiting');
        assert.equal(context.network.activity.activity, 'shopping');
        const retail = Economy.forState(inputBuyer, { board: new BoardIndex(), spots: [], rememberContext: false,
            npcOffersFor: id => id === 626 ? [{ selfId: 626, price: 1, count: 1, town: 'Giran', sourceType: 'npc' }] : [],
            routeRows: require('../src/GameServer/Bot/Economy/EconomicTrip').towns.map(() => [true, 0, 0]),
            workshop: { known: true, recipeId: 0, incomePerHour: 0 } });
        assert.equal(retail.network.activity.itemId, 626, 'an empty player market can source dismantling gear from an actual NPC quote');
        assert.equal(retail.network.activity.sourceType, 'npc');
        const crystalPath = context.projection.nodes.find(row => row.key === 'item:1458').paths.find(row => row.kind === 'crystallize');
        assert.equal(crystalPath.improvement.npcId, Crystals.npcId);
        const selectedPlan = invoke('GameServer/Bot/Economy/WishProviders').personalCraftPlan(inputBuyer, context);
        assert(selectedPlan?.materials.some(row => row.selfId === 626));
        const received = { ...buyer, stats: { ...buyer.stats, equipmentPlan: selectedPlan } };
        const afterReceipt = Economy.forState(received, { board, spots: [], rememberContext: false, npcOffersFor: () => [],
            routeRows: require('../src/GameServer/Bot/Economy/EconomicTrip').towns.map(() => [true, 0, 0]),
            workshop: { known: true, recipeId: 0, incomePerHour: 0 } });
        assert.equal(afterReceipt.network.activity.kind, 'crystallize',
            'the selected exchange may consume its own reserved inputs immediately after physical delivery');
        const selfContext = Economy.forState({ ...buyer, stats: { ...buyer.stats, coldCombat: {
            ...buyer.stats.coldCombat, skills: Profile.skillSnapshotsFromRecords([{ selfId: 248, level: 1 }]) } } },
            { board, spots: [], rememberContext: false, npcOffersFor: () => [],
                routeRows: require('../src/GameServer/Bot/Economy/EconomicTrip').towns.map(() => [true, 0, 0]),
                workshop: { known: true, recipeId: 0, incomePerHour: 0 } });
        assert.equal(selfContext.network.activity.kind, 'crystallize');
        assert.equal(selfContext.network.activity.improvement.mode, 'self', 'the selected wish and compact command retain the own-skill method');
        assert.equal(Decision.capture(selfContext, buyer).activity.improvement.mode, 'self');
        for (const [id, ownSkill] of [[9754, true], [9755, false]]) {
            let complete = await seed(id, ownSkill, false, 274, 5);
            const review = state => Economy.forState(state, { board: new BoardIndex(), spots: [], rememberContext: false,
                npcOffersFor: () => [], routeRows: require('../src/GameServer/Bot/Economy/EconomicTrip').towns.map(() => [true, 0, 0]),
                workshop: { known: true, recipeId: 0, incomePerHour: 0 } });
            const beforeBreak = review(complete);
            assert.equal(beforeBreak.network.activity.kind, 'crystallize');
            const plan = invoke('GameServer/Bot/Economy/WishProviders').personalCraftPlan(complete, beforeBreak);
            assert(plan, 'a crystal goal with all physical inputs survives its absent money-queue row');
            complete = await Life.upsertState({ ...complete, stats: { ...complete.stats, equipmentPlan: plan } }, 'selected_crystal_goal');
            const brokenGoal = await apply(complete, beforeBreak.network.activity.improvement);
            assert(brokenGoal.changed);
            complete = brokenGoal.state;
            assert.equal(Crystals.completionKey(complete), `power:${plan.target.selfId}:${plan.target.slot}`);
            const paused = { ...complete, stats: { ...complete.stats,
                equipmentPlan: { ...plan, strategy: 'none', status: 'deferred', reason: 'wish_focus' } } };
            assert.equal(Crystals.completionKey(paused), Crystals.completionKey(complete),
                'a survival restock pauses the exchange without losing its ready continuation');
            const afterBreak = review(complete);
            assert.equal(afterBreak.network.activity.kind, 'luxury_exchange', 'the actual wish review finishes its own crystallization goal');
            assert.equal(afterBreak.network.activity.itemId, plan.target.selfId);
            const finished = await apply(complete, afterBreak.network.activity.improvement);
            assert(finished.changed);
            assert((await DB.fetchItems(id)).some(row => row.selfId === plan.target.selfId && row.equipped),
                'the selected native chain ends with its C weapon physically equipped');
        }
        console.log('PASS empty crystal market -> input purchase / own skill or Giran service -> native crystals -> equipped C gear');
    } finally { await DB.close(); fs.rmSync(fixture.directory, { recursive: true, force: true }); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
