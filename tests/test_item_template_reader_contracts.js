const assert = require('assert');
require('../src/Global');

const Data = invoke('GameServer/DataCache');
const Database = invoke('Database');
const Step = invoke('GameServer/Quest/QuestStep');
const PetStep = invoke('GameServer/Pets/PetQuest');
const Names = invoke('GameServer/Quest/SecondProfessionQuest');
const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const Warehouse = invoke('GameServer/Bot/Economy/BotWarehouseService');
const Enchant = invoke('GameServer/Bot/Economy/ColdSafeEnchantService');
const Market = invoke('GameServer/Bot/Economy/MarketSnapshot');
const Observer = invoke('WorldObserver/WorldObserverServer');
const Dual = invoke('GameServer/Items/C4DualSwordCombinations');
const Companion = invoke('GameServer/Bot/AI/CompanionDualSwordCrafting');
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Roles = invoke('GameServer/Bot/AI/BotRoles');
const Compatibility = invoke('GameServer/Bot/AI/BotEquipmentCompatibility');
const Progression = invoke('GameServer/Bot/AI/PersonalGearProgression');
const Acquisition = require('../src/GameServer/Items/ItemAcquisitionCatalog');
const AdminShop = invoke('GameServer/World/Generics/NpcBypasses/AdminShop');
const { TYPES } = require('../src/GameServer/Pets/PetRules');

const row = (selfId, name, kind = 'Weapon.Dual') => ({ selfId,
    template: { name, kind, price: 10 }, etc: { rank: 'd', slot: 14, stackable: true } });
const first = row(700001, 'first');
const string = row('700001', 'string');
const last = row(700001, 'last', 'Other.Quest');
Data.items = [first, string, last];
Data.npcs = [row(700001, 'first NPC'), row('700001', 'string NPC'), row(700001, 'last NPC')];
assert.strictEqual(Names.itemName(700001), 'first');
assert.strictEqual(Names.itemName('700001'), 'string');
assert.strictEqual(Names.npcName('700001'), 'string NPC');
assert.strictEqual(Names.itemName(700002), '700002');
assert.strictEqual(Disposition.isQuestItem({ selfId: 700001 }), true, 'disposition uses numeric LAST');
assert.strictEqual(Observer.compactItem({ selfId: 700001 }).name, 'last', 'observer uses numeric LAST');
Data.items.push(row(700001, 'appended'));
assert.strictEqual(Disposition.isQuestItem({ selfId: 700001 }), true, 'disposition retains its identity snapshot');
assert.strictEqual(Observer.compactItem({ selfId: 700001 }).name, 'last', 'observer retains its identity snapshot');

const observedSource = [row(700010, 'early quest', 'Other.Quest')];
Data.items = observedSource;
assert.strictEqual(Disposition.isQuestItem({ selfId: 700010 }), true);
observedSource.push(row('700010', 'late weapon', 'Weapon.Sword'));
assert.strictEqual(Observer.compactItem({ selfId: 700010 }).name, 'late weapon',
    'the observer first sees its own current rows, after disposition observed the source');
assert.strictEqual(Planner.isRealCatalogItem(row(700010, 'projected weapon')), true,
    'the gear planner also begins its own observation after the appended duplicate');
assert.strictEqual(Warehouse.retentionAmount({ selfId: 700010, amount: 5 }), Warehouse.MAX_GEAR_COPIES_PER_TYPE,
    'the warehouse begins with its own late weapon snapshot');
assert.strictEqual(Disposition.isQuestItem({ selfId: 700010 }), true,
    'later module observations cannot refresh disposition');
observedSource.push(row(700010, 'latest quest', 'Other.Quest'));
assert.strictEqual(Observer.compactItem({ selfId: 700010 }).name, 'late weapon');
assert.strictEqual(Planner.isRealCatalogItem(row(700010, 'projected weapon')), true);
assert.strictEqual(Warehouse.retentionAmount({ selfId: 700010, amount: 5 }), Warehouse.MAX_GEAR_COPIES_PER_TYPE);
const observedState = { inventory: { 700010: { selfId: 700010, equipped: true, slot: 7 } } };
assert.deepStrictEqual(Enchant.targetNeeds(observedState), { weapon: 0, armor: 0 },
    'safe enchant begins with the most recent quest row');

Data.items = [row(700010, 'source B', 'Other.Quest')];
Disposition.isQuestItem({ selfId: 700010 });
Observer.compactItem({ selfId: 700010 });
Planner.isRealCatalogItem(row(700010, 'projected weapon'));
Warehouse.retentionAmount({ selfId: 700010, amount: 5 });
Enchant.targetNeeds(observedState);
observedSource[1] = row(700011, 'returned weapon', 'Weapon.Sword');
observedSource[2] = row(700012, 'returned quest', 'Other.Quest');
Data.items = observedSource;
assert.strictEqual(Disposition.isQuestItem({ selfId: 700012 }), true, 'disposition refreshes after A -> B -> A');
assert.strictEqual(Observer.compactItem({ selfId: 700012 }).name, 'returned quest', 'observer refreshes after A -> B -> A');
assert.strictEqual(Planner.isRealCatalogItem(row(700012, 'projected weapon')), false, 'planner refreshes after A -> B -> A');
assert.strictEqual(Warehouse.retentionAmount({ selfId: 700011, amount: 5 }), Warehouse.MAX_GEAR_COPIES_PER_TYPE,
    'warehouse refreshes after A -> B -> A');
assert.deepStrictEqual(Enchant.targetNeeds({ inventory: { 700011: { selfId: 700011, equipped: true, slot: 7 } } }),
    { weapon: 3, armor: 0 }, 'safe enchant refreshes after A -> B -> A');
Data.items = [first, string, last, row(700001, 'appended')];

const currentMarket = selfId => Market.buildDetail({ transactions: [], stores: [{ source: 'player',
    ownerId: 1, storeType: 1, town: 'Giran', items: [{ selfId, count: 1, price: 2 }] }] }).items[0];
assert.strictEqual(currentMarket(700001).name, 'appended', 'market sees the current LAST row');
Data.items[3] = row(700001, 'replaced');
assert.strictEqual(currentMarket(700001).name, 'replaced', 'market sees same-length row replacement');
Data.items[3].selfId = 700002;
assert.strictEqual(currentMarket(700002).name, 'replaced', 'market sees in-place ID changes');
assert.strictEqual(currentMarket(700001).name, 'last', 'market removes an edited ID from its previous key');

Data.items = [row(700003, 'weapon', 'Weapon.Sword'), row('700003', 'armor', 'Armor.Light')];
const state = { inventory: { 700003: { selfId: 700003, equipped: true, slot: 10, enchant: 0 } } };
assert.deepStrictEqual(Enchant.targetNeeds(state), { weapon: 0, armor: 3 }, 'safe enchant uses numeric LAST');
Data.items.push(row(700003, 'weapon after append', 'Weapon.Sword'));
assert.deepStrictEqual(Enchant.targetNeeds(state), { weapon: 0, armor: 3 }, 'safe enchant retains its identity snapshot');

const food = Object.values(TYPES)[0].food[0];
Data.items = [row(String(food), 'string food')];
assert.deepStrictEqual(AdminShop.itemIdsForSource('pet:food'), [], 'admin existence keeps strict ID types');
Data.items = [row(food, 'number food')];
assert.deepStrictEqual(AdminShop.itemIdsForSource('pet:food'), [food]);

Data.items = [row(2516, 'earlier invalid product', 'Other.Quest'), row('2516', 'last dual'),
    row(123, 'sword', 'Weapon.Sword')];
assert(Dual.resolveByProductId(2516), 'dual catalog validates the LAST product row');
Data.items.push(row(2516, 'appended invalid product', 'Other.Quest'));
assert(Dual.resolveByProductId(2516), 'dual recipes keep their identity snapshot');
const dualSource = Data.items;
Data.items = [];
assert.strictEqual(Dual.resolveByProductId(2516), null);
Data.items = dualSource;
assert.strictEqual(Dual.resolveByProductId(2516), null,
    'dual recipe rebuild sees current product rows after A -> B -> A');
const originals = { resolve: Dual.resolveByRecipeId, role: Roles.inferRole, classId: Roles.classIdOf,
    profile: Compatibility.profileFor, grade: Planner.gradeForLevel };
try {
    Data.items = [row('700004', 'dual')];
    const recipe = { productId: '700004' };
    Dual.resolveByRecipeId = () => recipe;
    Roles.inferRole = () => 'melee';
    Roles.classIdOf = () => 0;
    Compatibility.profileFor = () => ({ weaponKinds: ['Weapon.Dual'] });
    Planner.gradeForLevel = () => 'd';
    assert.strictEqual(Companion.recipeFor({ level: 40 }), null, 'companion keeps the raw string product ID');
    recipe.productId = 700004;
    assert.strictEqual(Companion.recipeFor({ level: 40 }), recipe, 'companion converts the row ID only');
} finally {
    Dual.resolveByRecipeId = originals.resolve;
    Roles.inferRole = originals.role;
    Roles.classIdOf = originals.classId;
    Compatibility.profileFor = originals.profile;
    Planner.gradeForLevel = originals.grade;
}

const rankOriginals = { items: Data.items, assess: Progression.assess,
    recipes: Dual.loadRecipes, allows: Acquisition.allowsRecipe };
const rankPassed = new Error('recipe rank read completed');
const rankOptions = { recipeId: 123, craftRecipes: [{ type: 'dwarven', recipeId: 123, productId: 700001 }],
    get excludedTargetIds() { throw rankPassed; } };
const rankState = { inventory: {}, stats: { classId: 0, role: 'melee' } };
try {
    Progression.assess = () => ({});
    Dual.loadRecipes = () => [];
    Acquisition.allowsRecipe = () => true;
    Data.items = undefined;
    assert.throws(() => Planner.preferredTarget(rankState, rankOptions), error => error === rankPassed,
        'recipe rank accepts an absent optional catalog before the next planning step');
    for (const malformed of [[null], Array(1)]) {
        Data.items = malformed;
        assert.throws(() => Planner.preferredTarget(rankState, rankOptions), TypeError,
            'recipe rank retains the original malformed/hole find error');
    }
} finally {
    Data.items = rankOriginals.items;
    Progression.assess = rankOriginals.assess;
    Dual.loadRecipes = rankOriginals.recipes;
    Acquisition.allowsRecipe = rankOriginals.allows;
}

(async () => {
    Data.items = [first, string, last];
    const state = { session: { actor: { fetchId: () => 1 } }, quest: { id: 1 },
        variables: {}, state: 'started', getInt: () => 0 };
    const stop = new Error('transaction captured');
    for (const [method, run] of [
        ['applyQuestStep', () => Step.apply(state, { gives: [[700001, 1]] })],
        ['applyPetQuestStep', () => PetStep.step(state, {}, [], [[700001, 1]])]
    ]) {
        const original = Database[method];
        let rewards;
        try {
            Database[method] = async (...args) => { rewards = args[5]; throw stop; };
            await assert.rejects(run(), error => error === stop);
            assert.strictEqual(rewards[0].name, 'first', `${method} keeps strict FIRST before its transaction`);
            Data.items = undefined;
            await assert.rejects(run(), TypeError, `${method} keeps the absent-catalog error`);
        } finally {
            Database[method] = original;
            Data.items = [first, string, last];
        }
    }
    console.log('Actual item readers preserve FIRST/LAST, strict/raw IDs, snapshots, fresh market data and quest boundaries');
})().catch(error => { console.error(error); process.exitCode = 1; });
