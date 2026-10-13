'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
require('./helpers/databaseIsolation');
const fixture = isMainThread ? require('./helpers/isolatedSocialDatabase')('b-grade-craft-progression') : null;
if (isMainThread) require('../src/Global');
else require(workerData.workerPath);
const Data = invoke('GameServer/DataCache');
if (isMainThread) Data.init();
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const Shops = invoke('GameServer/Bot/Economy/CraftShopService');
const Providers = invoke('GameServer/Bot/Economy/WishProviders');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Progression = invoke('GameServer/Bot/AI/PersonalGearProgression');
const Gear = invoke('GameServer/Bot/AI/BotGear');
const { BoardIndex } = invoke('GameServer/AfkTrade/BoardIndex');
const timestamp = 1791813240000;
const readyFixtures = new Map();

function equipped(inventory, selfId, slot) {
    const previous = inventory[selfId], slots = [...(previous?.equippedSlots || []), slot];
    inventory[selfId] = { selfId, amount: slots.length, equipped: true,
        equippedCount: slots.length, equippedSlots: slots, slot };
}

function verify(recipeId, missing = false, slot = 14, classId = 3) {
    const recipe = Recipes.resolveByRecipeId(recipeId);
    const variants = Recipes.resolveVariantsByProductId(recipe.productId);
    assert(variants.some(row => row.successRate < 100));
    assert(variants.includes(recipe) && recipe.successRate === 100);
    assert.equal(Recipes.resolveByProductId(recipe.productId), variants[0], 'existing callers keep their canonical recipe');
    assert(Object.isFrozen(variants), 'the shared native variant catalogue cannot be changed by a review');
    const station = Shops.publishedStationRecipes().stationByRecipeId.get(recipeId);
    assert(station, 'the exact native recipe is published');
    const state = { characterId: 990410, name: 'CraftBuyer', level: 55, classId,
        phase: 'cold', activity: 'hunting', currentRegion: 'Giran', adena: 100000000,
        loc: { locX: 81100, locY: 148000, locZ: -3466 },
        vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 }, inventory: {},
        stats: { classId, exp: Data.experience[54] + 1,
            wishFocus: [`power:${recipe.productId}:${slot}`, 0, 0],
            persona: { primaryDrive: 'progression', understanding: 1,
                traits: { ambition: 0, commitment: 0, caution: 0, empathy: 0, sociability: 0 } } } };
    for (const row of Gear.planFor({ classId, level: 40 }).items) equipped(state.inventory, row.selfId, row.slot);
    assert.equal(Progression.assess(state).required, false, 'the C milestone is closed');
    // Other slots are already top B; the selected equipment improvement remains a
    // choice of sources, with only this published recipe's complete stock.
    const conflicts = [7, 14].includes(slot) ? [7, 14]
        : [10, 11, 15].includes(slot) ? [slot, 15, ...(slot === 15 ? [10, 11] : [])] : [slot];
    for (const [otherSlot, rows] of Providers.gearCandidates(state)) {
        if (conflicts.includes(otherSlot)) continue;
        for (const row of Object.values(state.inventory)) if (row.equippedSlots?.includes(otherSlot)) {
            row.equippedSlots = row.equippedSlots.filter(side => side !== otherSlot);
            row.equippedCount = row.equippedSlots.length; row.equipped = row.equippedCount > 0;
        }
        equipped(state.inventory, rows[0].selfId, otherSlot);
    }
    for (const material of recipe.materials) state.inventory[material.selfId] = { selfId: material.selfId, amount: material.amount };
    for (const id of [1464, 1061, 736]) state.inventory[id] = { selfId: id, amount: 100000 };
    const fragment = recipe.materials[1];
    assert(fragment && fragment.selfId !== recipe.recipeItemId, 'native B equipment requires its key material');
    const board = new BoardIndex();
    if (missing) {
        state.inventory[fragment.selfId].amount--;
        board.put({ id: 77, ownerId: 990411, storeType: 1, kind: 'shop', town: 'Giran',
            lines: [{ lineId: 78, selfId: fragment.selfId, count: 1, price: 1, enchant: 0 }] });
    }
    const fee = Shops.productPrice(recipe);
    const service = { characterId: 990412, recipeId, price: fee, entryPrice: fee,
        capacityBatches: 1, townName: 'Giran', loc: station.loc };
    const context = Economy.forState(state, { timestamp, board, spots: [], npcOffersFor: () => [],
        workshop: null, knownRecipes: [], withNodes: true, knowledgeEnabled: false,
        routeRows: invoke('GameServer/Bot/Economy/EconomicTrip').towns.map(() => [true, 0, 0]),
        workshops: id => id === recipeId ? [service] : [], rememberContext: false });
    const productNode = context.projection.nodes.find(row => row.key === `item:${recipe.productId}`);
    assert(productNode?.paths.some(row => row.kind === 'craft' && row.recipeId === recipeId),
        'the published 100% variant survives the earlier unavailable lower-success variant');
    const leaf = context.network.activity;
    assert.equal(leaf?.rootKey, `power:${recipe.productId}:${slot}`, 'native network accepts the B equipment goal');
    assert.equal(leaf.activity, missing ? 'shopping' : 'crafting');
    assert.equal(missing ? leaf.itemId : leaf.recipeId, missing ? fragment.selfId : recipeId);
    const plan = Providers.personalCraftPlan(state, context);
    assert.equal(plan?.recipeId, recipeId);
    assert.equal(plan.craftProviders[recipeId].characterId, service.characterId);
    assert.equal(plan.target.selfId, recipe.productId);
    assert.equal(plan.target.slot, slot, 'the selected paperdoll slot reaches the equipment receipt');
    if (!missing) readyFixtures.set(recipeId, { state: { ...state,
        stats: { ...state.stats, ...context.statsPacket } }, plan, station });
    return { recipeId, productId: recipe.productId, missing, activity: leaf.activity };
}

async function verifyNativeCrafts() {
    const Database = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
    const Craft = invoke('GameServer/Bot/Economy/ColdCraftingService');
    const Workshops = invoke('GameServer/Bot/Economy/CraftWorkshopService');
    const owners = new Map();
    fixture.assertConfigured(options.default);
    async function seed(accountName, name, classId, level, inventory, loc, stats) {
        await Database.createAccount(accountName, 'fixture');
        const race = Data.classTemplates.find(row => row.classId === classId).template.race;
        const characterId = Number((await Database.createCharacter(accountName, { name, classId, race,
            maxHp: 1000, maxMp: 1000, sex: 0, face: 0, hair: 0, hairColor: 0, ...loc })).insertId);
        await Database.execute(['UPDATE characters SET level=?, exp=?, hp=1000, mp=1000 WHERE id=?',
            [level, Data.experience[level - 1], characterId]]);
        for (const row of Object.values(inventory)) {
            const name = Data.items.find(item => item.selfId === row.selfId)?.template.name;
            const slots = row.equippedSlots || [];
            for (const slot of slots) await Database.setItem(characterId, { selfId: row.selfId, name,
                amount: 1, equipped: true, slot, enchant: 0 });
            if (row.amount > slots.length) await Database.setItem(characterId, { selfId: row.selfId, name,
                amount: row.amount - slots.length, equipped: false, slot: 0, enchant: 0 });
        }
        return Life.upsertState({ characterId, accountName, name, level, phase: 'cold', activity: 'crafting',
            currentRegion: 'Giran', loc, adena: inventory[57].amount,
            inventory: Life.inventorySummaryFromItems(await Database.fetchItems(characterId)),
            vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
            stats: { ...stats, classId }, timing: {} }, 'b_craft_fixture');
    }
    try {
        await Database.init(); await Life.init();
        for (const [recipeId, { state, plan, station }] of readyFixtures) {
            const recipe = Recipes.resolveByRecipeId(recipeId);
            let owner = owners.has(station.id) ? Life.cachedState(owners.get(station.id))
                : await seed(Craft.crafterAccount(station), `Forge${recipeId}`, 57, 70,
                    { 57: { selfId: 57, amount: 1000 } }, station.loc, { craftStationId: station.id });
            owners.set(station.id, owner.characterId);
            await Shops.ensureRecipes(owner.characterId, Shops.profileFor(owner));
            owner = await Workshops.review(Life.cachedState(owner.characterId));
            const provider = { ...plan.craftProviders[recipeId], characterId: owner.characterId };
            let buyer = await seed(`bot_b_craft_${recipeId}`, `Buyer${recipeId}`, state.classId, 55,
                { ...state.inventory, 57: { selfId: 57, amount: state.adena } }, station.loc,
                { ...state.stats, equipmentPlan: { ...plan, craftProviders: { ...plan.craftProviders, [recipeId]: provider } } });
            const before = buyer.adena, ownerBefore = (await Database.fetchItems(owner.characterId)).find(row => row.selfId === 57).amount;
            const committedPlan = buyer.stats.equipmentPlan;
            buyer = await Life.upsertState({ ...buyer, stats: { ...buyer.stats, equipmentPlan: {
                ...committedPlan, recipeId: Recipes.resolveByProductId(recipe.productId).recipeId } } }, 'b_other_recipe');
            await assert.rejects(Workshops.craft(owner.characterId, recipeId, buyer.characterId,
                { funding: { r: plan.valueRate } }), /economy_material_protected/,
            'another recipe variant cannot consume the personal goal reservation');
            const reservedId = recipe.materials[1].selfId;
            buyer = await Life.upsertState({ ...Life.cachedState(buyer.characterId),
                stats: { ...Life.cachedState(buyer.characterId).stats, equipmentPlan: committedPlan },
                inventory: { ...buyer.inventory, [reservedId]: { ...buyer.inventory[reservedId], protectedAmount: 1 } } }, 'b_explicit_protection');
            await assert.rejects(Workshops.craft(owner.characterId, recipeId, buyer.characterId,
                { funding: { r: plan.valueRate } }), /economy_material_protected/,
            'explicitly protected units stay protected even for the selected recipe');
            const unchanged = await Database.fetchItems(buyer.characterId);
            assert.equal(unchanged.find(row => row.selfId === 57).amount, before, 'refusals spend no fee');
            assert(!unchanged.some(row => row.selfId === recipe.productId), 'refusals produce no weapon');
            buyer = await Life.upsertState({ ...Life.cachedState(buyer.characterId), inventory: {
                ...buyer.inventory, [reservedId]: { ...buyer.inventory[reservedId], protectedAmount: 0 } } }, 'b_selected_recipe');
            const result = await Craft.craft(buyer, () => 0);
            assert.equal(result.crafted, true, `${recipeId}: ${result.reason} ${result.error || ''}`);
            buyer = await Life.upsertState(result.state, 'b_craft_receipt');
            const physical = await Database.fetchItems(buyer.characterId);
            const product = physical.filter(row => row.selfId === recipe.productId);
            assert.equal(product.length, 1, 'one native B equipment receipt');
            assert.equal(Number(product[0].equipped), 1, 'the B equipment is physically worn');
            assert.equal(Number(product[0].slot), plan.target.slot, 'paired jewelry and full body armor keep their selected paperdoll slot');
            assert.equal(buyer.inventory[recipe.productId].equippedCount, 1);
            assert.equal(buyer.stats.equipmentPlan, undefined, 'the accepted craft plan closes after equipment receipt');
            for (const material of recipe.materials)
                assert.equal(physical.filter(row => row.selfId === material.selfId).reduce((n, row) => n + row.amount, 0), 0);
            assert.equal(buyer.adena, before - provider.price, 'the buyer pays exactly the quoted service fee');
            assert.equal((await Database.fetchItems(owner.characterId)).find(row => row.selfId === 57).amount,
                ownerBefore + provider.price, 'the station receives the paid fee in its physical wallet');
            assert.equal((await Craft.craft({ ...buyer, activity: 'crafting' }, () => 0)).crafted, false,
                'a completed equipment receipt never crafts the equipment again');
        }
        console.log('PASS native B craft receipts: selected variants -> station fee -> equipped weapons, Adamantite, Zubei and Avadon -> closed plan');
    } finally { await Database.close(); }
}

const cases = [[461], [457], [329, 2], [331, 5], [333, 3], [342, 10],
    [362, 10, 8], [368, 10, 12], [358, 10], [366, 15, 8], [479, 8, 5]];
const results = cases.flatMap(([recipeId, slot = 14, classId = 3]) =>
    [verify(recipeId, false, slot, classId), verify(recipeId, true, slot, classId)]);
console.log(`PASS B recipe variants and native craft/material goals (${isMainThread ? 'main' : 'worker'})`);
if (isMainThread) {
    const workerCheck = new Promise((resolve, reject) => {
        const worker = new Worker(__filename, { workerData: {
            workerPath: path.resolve(__dirname, '../src/GameServer/Bot/Population/ColdSimulationWorker.js'),
            workerEpoch: 'b-grade-craft-test' } });
        const timer = setTimeout(() => { worker.terminate(); reject(Error('B craft worker timed out')); }, 60000);
        worker.on('message', message => {
            if (message.type !== 'b_grade_craft_result') return;
            clearTimeout(timer);
            try { assert.deepEqual(message.results, results, 'real cold worker and main select the same B steps'); resolve(); }
            catch (error) { reject(error); }
            worker.terminate();
        });
        worker.on('error', error => { clearTimeout(timer); reject(error); });
    });
    Promise.all([workerCheck, verifyNativeCrafts()])
        .catch(error => { console.error(error); process.exitCode = 1; })
        .finally(() => require('node:fs').rmSync(fixture.directory, { recursive: true, force: true }));
} else parentPort.postMessage({ type: 'b_grade_craft_result', results });
