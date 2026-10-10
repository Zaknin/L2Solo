'use strict';
const assert = require('node:assert/strict');
const { Worker, isMainThread, parentPort } = require('node:worker_threads');
require('./helpers/databaseIsolation');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Gear = invoke('GameServer/Bot/AI/BotGear');
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Progression = invoke('GameServer/Bot/AI/PersonalGearProgression');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const Occupation = invoke('GameServer/Bot/Population/ColdOccupationSources');
const Valuation = invoke('GameServer/Bot/Economy/EconomicValuation');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const timestamp = 1791669000000;
function kit(classId, level) {
    const inventory = {};
    for (const row of Gear.planFor({ classId, level }).items) {
        const previous = inventory[row.selfId];
        const equippedSlots = [...previous?.equippedSlots || [], row.slot];
        inventory[row.selfId] = { ...row, amount: equippedSlots.length, equippedSlots,
            equippedCount: equippedSlots.length, equipped: true };
    }
    return inventory;
}
function bot(classId = 54, level = 33) {
    const state = { characterId: 990331, level, adena: 10000000, phase: 'cold', activity: 'hunting',
        currentRegion: 'Giran', loc: { locX: 83396, locY: 147904, locZ: -3400 },
        inventory: kit(classId, 20), stats: { classId, exp: Data.experience[level - 1] } };
    state.stats.coldCombat = Profile.legacySnapshot(state, Profile.skillRecordsFromTree(classId, level), timestamp);
    return state;
}
function review(state, board = new BoardIndex(), extra = {}) {
    Economy.reset(); Profile.forgetBuild(state.characterId);
    return Economy.forState(state, { spots: [], board, timestamp, npcOffersFor: () => [],
        routeRows: Array.from({ length: require('../src/GameServer/Bot/Economy/EconomicTrip').towns.length },
            () => [true, 0, 0]), workshop: { known: true, recipeId: 0, incomePerHour: 0 }, ...extra });
}
const source = bot(), before = structuredClone(source);
assert.equal(Progression.assess(source).required, false);
const prepared = Progression.preparation(source);
assert.equal(prepared.level, 40);
assert.deepEqual(source, before, 'preparation never changes the physical kit or level');
for (const classId of [0, 10, 18, 25, 38, 49, 50, 53, 54, 56]) {
    const complete = bot(classId);
    assert(Progression.preparation(complete), `full D admits class ${classId}`);
    const missing = structuredClone(complete);
    const weapon = Object.values(missing.inventory).find(row => row.equippedSlots.some(slot => [7, 14].includes(slot)));
    delete missing.inventory[weapon.selfId];
    assert.equal(Progression.preparation(missing), null, 'a missing D weapon blocks early C');
    assert(Progression.assess({ ...complete, level: 40 }).required, 'D opens the C milestone at 40');
    assert.equal(Progression.assess({ ...complete, level: 52 }).required, false);
}
assert.equal(Progression.preparation({ ...source, clanId: 1 }), null, 'clan progression keeps its existing owner');
assert.equal(Progression.assess({ ...source, level: 40, clanId: 1 }).required, false);

const board = new BoardIndex();
board.put({ id: 91, ownerId: 990332, storeType: 1, kind: 'shop', town: 'Giran',
    lines: [{ lineId: 1, selfId: 162, count: 1, enchant: 0, price: 10000 }] });
const ctx = review(source, board);
assert(ctx.projection.roots.some(key => /^power:/.test(key)
    && Data.items.find(item => item.selfId === Number(key.split(':')[1]))?.etc.rank === 'c'),
    'native wishes compare C sources before 40 after completing D');
const missing = structuredClone(source);
delete missing.inventory[Object.values(missing.inventory).find(row => row.equippedSlots.includes(12)).selfId];
assert(!review(missing, board).projection.roots.some(key => /^power:/.test(key)
    && Data.items.find(item => item.selfId === Number(key.split(':')[1]))?.etc.rank === 'c'),
    'native wishes fill the D gap first');
assert(Planner.preferredTarget(source, { wishTargetId: 162 }), 'native acquisition accepts the chosen early C target');
const sourcePlan = Planner.planFor(source, { wishTargetId: 162, board, spots: [] });
assert.equal(sourcePlan.target.selfId, 162, 'native replan retains the early C target');
const recipe = invoke('GameServer/Items/C4RecipeItems').resolveByProductId(162);
assert(recipe, 'authored War Axe recipe');
const inputs = Object.fromEntries(recipe.materials.map(row => [row.selfId, { ...row, equipped: false }]));
const customer = { ...source, inventory: { ...source.inventory, ...inputs } };
const service = { characterId: 990334, recipeId: recipe.recipeId, price: 1, entryPrice: 1,
    revision: 2, townName: 'Giran', loc: source.loc, capacityBatches: 1 };
const crafted = review(customer, board, { workshops: id => id === recipe.recipeId ? [service] : [] });
const provider = crafted.projection.nodes.find(row => row.key === 'item:162')?.paths.find(row => row.kind === 'craft');
assert(provider?.workshop, 'a full D customer can use a real C workshop before 40');
assert.equal(provider.requiresRecipeLearning, false, 'the customer does not learn the dwarf recipe');
assert(!provider.grossRequirements.some(row => row.key === `item:${recipe.recipeItemId}`));
const exchangePath = ctx.projection.nodes.find(row => row.key === 'item:162')?.paths.find(row => row.kind === 'luxury_exchange');
assert(exchangePath, 'native C choices include the authored Luxury route');
assert.deepEqual(exchangePath.grossRequirements, [{ key: 'item:1458', amount: 5375 }]);
assert(!ctx.projection.nodes.some(row => row.key === 'item:1459'), 'the bot Luxury path never acquires C crystals');
const stocked = { ...source, level: 40, inventory: { ...source.inventory, 1463: { selfId: 1463, amount: 100000 } } };
const dStock = { ...stocked, inventory: { ...stocked.inventory, 1458: { selfId: 1458, amount: 10000 } } };
const readyExchange = review(dStock);
assert.equal(readyExchange.network.activity?.kind, 'luxury_exchange', 'a prepared native Luxury leaf is executable');
assert.equal(readyExchange.network.activity.activity, 'improving');
const exchangePlan = invoke('GameServer/Bot/Economy/WishProviders').personalCraftPlan(dStock, readyExchange);
assert.equal(exchangePlan?.strategy, 'luxury_exchange');
assert(exchangePlan.materials.every(row => row.selfId === 1458));
const crystalBoard = new BoardIndex();
crystalBoard.put({ id: 92, ownerId: 990333, storeType: 1, kind: 'shop', town: 'Giran',
    lines: [{ lineId: 2, selfId: 1458, count: 10000, enchant: 0, price: 1 }] });
const waitingExchange = review(stocked, crystalBoard);
assert.equal(waitingExchange.network.activity.itemId, 1458, 'missing D crystals become a real acquisition leaf');
assert.equal(waitingExchange.network.activity.activity, 'shopping');
assert(!review(source).network.leaves?.some(row => row.kind === 'luxury_exchange'), 'missing inputs cannot execute the exchange');
const Crystals = invoke('GameServer/Bot/Economy/BotCrystallization');
const spareId = Crystals.catalog().find(id => !stocked.inventory[id]);
const gearBoard = new BoardIndex();
gearBoard.put({ id: 93, ownerId: 990335, storeType: 1, kind: 'shop', town: 'Giran',
    lines: [{ lineId: 3, selfId: spareId, count: 16, enchant: 0, price: 1 }] });
const gearInput = review(stocked, gearBoard);
assert.equal(gearInput.network.activity.itemId, spareId, 'a cheap D market item can fund Luxury crystals');
assert.equal(gearInput.network.activity.activity, 'shopping');
const fromGear = invoke('GameServer/Bot/Economy/WishProviders').personalCraftPlan(stocked, gearInput);
assert(fromGear.materials.some(row => row.selfId === spareId && row.amount >= 1 && row.amount <= Crystals.BATCH_LIMIT),
    'the native plan reserves a bounded purchase batch');
const readyBag = { ...stocked, inventory: { ...stocked.inventory, [spareId]: { selfId: spareId, amount: 16, equipped: false } } };
const readyCrystals = review(readyBag, gearBoard);
assert.equal(readyCrystals.network.activity.kind, 'crystallize');
assert(readyCrystals.network.activity.improvement.amount >= 1);
const card = invoke('GameServer/Bot/Population/ColdEconomyDecision').capture(readyCrystals, readyBag);
assert.equal(card.activity.improvement.amount, readyCrystals.network.activity.improvement.amount);
assert(card.data.byteLength <= 800, 'the worker/native decision keeps its byte bound');
const mixedIds = Crystals.catalog().filter(id => !stocked.inventory[id]).slice(0, 4);
const mixedBag = { ...stocked, inventory: { ...stocked.inventory,
    ...Object.fromEntries(mixedIds.map(id => [id, { selfId: id, amount: 2, equipped: false }])) } };
const mixed = Crystals.choices(mixedBag, () => null, { known: true, hours: 0, fees: 0 })[0];
assert.equal(mixed.inputs.length, 4, 'one bounded batch can combine distinct spare types');
assert(mixed.inputs.reduce((count, row) => count + row.amount, 0) <= Crystals.BATCH_LIMIT);
assert.equal(mixed.net, mixed.inputs.reduce((count, row) => count
    + row.amount * Crystals.reward(Data.items.find(item => item.selfId === row.selfId)).net, 0));
const mixedActivity = { ...readyCrystals.network.activity, improvement: {
    kind: 'crystallize', npcId: Crystals.npcId, items: mixed.inputs, amount: 1 } };
const mixedCard = invoke('GameServer/Bot/Population/ColdEconomyDecision').capture({ ...readyCrystals,
    network: { ...readyCrystals.network, activity: mixedActivity } }, mixedBag);
assert.deepEqual(mixedCard.activity.improvement.items, mixed.inputs);
assert(mixedCard.data.byteLength <= 800, 'mixed batch transport keeps the same byte bound');
const townPlan = invoke('GameServer/Bot/Economy/WishProviders').personalCraftPlan(readyBag, readyCrystals);
const townReady = { ...readyBag, stats: { ...readyBag.stats, equipmentPlan: townPlan } };
assert(Crystals.ready(townReady), 'owned inputs admit the finite town command');
assert.equal(invoke('GameServer/Bot/Population/ColdSimulationKernel').lifecycleKind(townReady), 'command');
assert(!Crystals.ready({ ...townReady, inventory: { ...townReady.inventory,
    [spareId]: { ...townReady.inventory[spareId], amount: 0 } } }));
assert(!Crystals.ready({ ...townReady, clanId: 1 }), 'clan scheduling stays unchanged');
const Improvement = invoke('GameServer/Bot/Economy/BotImprovementService');
const outside = { ...townReady, activity: 'hunting', currentRegion: 'Dion',
    loc: { locX: 18748, locY: 145437, locZ: -3132 } };
const townTrip = Improvement.acquisitionTravel(outside, readyCrystals.network.activity, timestamp);
assert.equal(townTrip.activity, 'traveling');
assert.equal(townTrip.stats.travel.townName, 'Giran', 'the selected NPC operation owns the destination');
assert(townTrip.adena < outside.adena, 'the real gatekeeper trip debits its fee');
assert.equal(Improvement.acquisitionTravel(townReady, readyCrystals.network.activity, timestamp), null);
assert.equal(Improvement.acquisitionTravel({ ...outside, clanId: 1 }, readyCrystals.network.activity, timestamp), null);
assert.equal(invoke('GameServer/Bot/Population/ColdSimulationCoordinator').routeFor(outside, null, null, [], {}), null,
    'a ready NPC operation suppresses the competing hunting route');
const npcInput = review(stocked, new BoardIndex(), { npcOffersFor: id => id === spareId
    ? [{ selfId: id, price: 1, sourceType: 'npc', town: 'Giran', available: true }] : [] });
assert.equal(npcInput.network.activity.itemId, spareId, 'native shop equipment is also a crystal source');
const adultKit = kit(54, 40);
for (const id of Object.keys(adultKit)) if (adultKit[id].equippedSlots.some(slot => [7, 14].includes(slot))) delete adultKit[id];
const dWeapon = Object.values(stocked.inventory).find(row => row.equippedSlots?.some(slot => [7, 14].includes(slot)));
const weaponOnly = { ...stocked, inventory: { ...adultKit, [dWeapon.selfId]: dWeapon, 1463: stocked.inventory[1463] } };
const multiple = review(weaponOnly, gearBoard);
assert(multiple.network.activity.amount > 1 && multiple.network.activity.itemId === spareId,
    'a larger C gap orders several real D items, rather than assuming a fractional item');

const stashed = { ...source, inventory: { ...source.inventory,
    162: { selfId: 162, amount: 1, slot: 7, equipped: false },
    883: { selfId: 883, amount: 2, slot: 4, equipped: false } } };
const physical = Planner.equipInventoryUpgrades(stashed, stashed.inventory);
assert.equal(physical[162].equipped, false, 'C remains in the bag before expertise');
assert.equal(physical[883].equipped, false);
assert.equal(Progression.preparedAmounts(stashed)[162], 1);
assert.equal(Progression.preparedAmounts(stashed)[883], 2, 'both future rings are reserved');
assert.equal(Disposition.reservedEquipmentAmounts(stashed)[162], 1);
const steps = Occupation.reservations(stashed); let step;
do step = steps.next(); while (!step.done);
assert.equal(step.value[162], 1, 'worker production and native sales share future gear reservation');
assert.equal(step.value[883], 2);
assert(!Disposition.saleCandidates(stashed).some(row => [162, 883].includes(row.selfId)),
    'prepared equipment is not sold as surplus');
assert(!review(stashed, board).projection.roots.includes('power:162:7'), 'owned future weapon is not bought twice');
const wearable = Planner.equipInventoryUpgrades({ ...stashed, level: 40 }, stashed.inventory);
assert(wearable[162].equipped && wearable[883].equippedCount === 2, 'native reconciliation wears C from level 40');
assert.equal(Valuation.readyBenefit({ valueHours: 12, benefitPerHour: 1, horizonHours: 18,
    notBeforeHours: 6, delayHours: 3 }), 12, 'preparing early cannot earn combat benefit before 40');
assert.equal(Valuation.readyBenefit({ valueHours: 12, benefitPerHour: 1, horizonHours: 18,
    notBeforeHours: 6, delayHours: 9 }), 9, 'late readiness loses only usable C hours');
assert.equal(Valuation.readyBenefit({ valueHours: 12, benefitPerHour: 1, horizonHours: 18,
    notBeforeHours: 6, delayHours: 100 }), 0);
console.log(`PASS native C preparation: full D gate, classes, future horizon, workshop/Luxury/input goals, stash and expertise ${isMainThread ? 'main' : 'worker'}`);
if (isMainThread) {
    const worker = new Worker(__filename);
    worker.on('error', error => { console.error(error); process.exitCode = 1; });
    worker.on('exit', code => { if (code) process.exitCode = code; });
} else parentPort.postMessage('verified');
