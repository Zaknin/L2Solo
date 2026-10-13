'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const root = path.resolve(__dirname, '..');

// Isolate native data contracts without loading World or the live database.
function loader(fixtures = {}) {
    const cache = new Map();
    const injected = new Map(Object.entries(fixtures).map(([name, value]) => [path.join(root, name), value]));
    function load(file) {
        file = path.resolve(file);
        if (injected.has(file)) return injected.get(file);
        if (cache.has(file)) return cache.get(file).exports;
        if (file.endsWith('.json')) return require(file);
        const module = { exports: {} };
        cache.set(file, module);
        const nativeRequire = Module.createRequire(file);
        const localRequire = name => name.startsWith('.') ? load(nativeRequire.resolve(name)) : nativeRequire(name);
        const run = new Function('require', 'module', 'exports', 'invoke', fs.readFileSync(file, 'utf8'));
        run(localRequire, module, module.exports, () => ({}));
        return module.exports;
    }
    return name => load(path.join(root, name));
}

const symbols = [{ id: 1, dyeSelfId: 5 }, { id: 1, dyeSelfId: 6 }, { id: '1', dyeSelfId: '5' }];
const trees = { 1: [1], 4: [1, 1, '1', 404], '01': ['1'] };
const hennaData = { symbols };
const hennaLoad = loader({ 'data/Henna/c4-henna.json': hennaData,
    'data/Henna/c4-henna-trees.json': { trees }, 'src/GameServer/ClassProgression.js': { lineage: () => [0, 1] } });
const Henna = hennaLoad('src/GameServer/Henna/HennaRules.js');
const earlyServiceView = Henna.serviceView();
assert.equal(Henna.symbol('1'), symbols[1], 'LAST strict symbol map with numeric public query');
assert.equal(Henna.symbolStrict('1'), symbols[2], 'strict service reader does not convert saved IDs');
assert.equal(Henna.symbol('missing'), null);
assert.deepEqual(Henna.availableForClass('4'), [symbols[1], symbols[1], symbols[2]]);
const returnedHennas = Henna.availableForClass(4);
returnedHennas.length = 0;
assert.equal(Henna.availableForClass(4).length, 3, 'available lists belong to caller');
assert.equal(earlyServiceView.hasSymbolForClass(1, '1'), true, 'numeric tree Map retains LAST colliding class keys');
assert.deepEqual(Henna.availableForClass(1), [symbols[1]], 'available tree uses its original direct property');
assert.equal(Henna.symbolForClass(4, '1'), symbols[2]);
assert.equal(Henna.symbolForClass(4, NaN), undefined);
assert.equal(Henna.isTattooDye('5'), true);
symbols[0].dyeSelfId = 50;
assert.equal(Henna.isTattooDye(5), false, 'fresh dye reader retains strict row IDs');
assert.equal(Henna.isTattooDye(50), true);
symbols[1].id = 91;
assert.equal(Henna.symbol(1), symbols[1], 'import map keeps original keys');
assert.equal(Henna.symbolForClass(4, 91), symbols[1], 'class lookup compares the current row payload ID');
symbols.push({ id: 8, dyeSelfId: 88 });
assert.equal(Henna.symbol(8), null, 'symbol import snapshot ignores appended keys');
assert.equal(Henna.isTattooDye(88), true, 'dye scan sees appended symbols');
const laterServiceView = Henna.serviceView();
assert.equal(earlyServiceView.symbol(8), null, 'earlier service view retains its own import snapshot');
assert.equal(laterServiceView.symbol(8), symbols[3], 'later service view sees its own import snapshot');
assert.equal(laterServiceView.symbol(1), symbols[0]);
assert.equal(Henna.symbol(1), symbols[1], 'rules snapshot remains separate after a later service import');
trees[1] = [91];
assert.equal(earlyServiceView.hasSymbolForClass(1, 91), false, 'class Map retains original list reference');
const HennaService = hennaLoad('src/GameServer/Henna/HennaService.js');
assert.equal(HennaService.symbol(8), symbols[3]);
HennaService.STAT_KEYS.pop();
assert.equal(Henna.STAT_KEYS.length, 6, 'service vocabulary array remains independently mutable');
const sparseClass = [,,1];
trees[5] = sparseClass;
assert.deepEqual(Henna.availableForClass(5), [symbols[1]]);
assert.equal(Henna.symbolForClass(5, 91), symbols[1]);
trees[6] = '1';
assert.throws(() => Henna.symbolForClass(6, 1), TypeError, 'malformed tree keeps existing map/filter exception');

const routes = [{ classId: 2, npcs: [7, 7, NaN] }, { classId: 2, npcs: ['7', 8] }, { classId: '2', npcs: [7] }];
const Profession = loader({ 'data/Templates/second_profession_trials.json': routes })('src/GameServer/SecondProfessionCatalog.js');
assert.equal(Profession.routeForClass(2), routes[0]);
assert.equal(Profession.routeForClass('2'), routes[2]);
assert.equal(Profession.routeForClass(NaN), undefined);
assert.deepEqual(Profession.routesForNpc(7), [routes[0], routes[2]], 'duplicate NPC membership does not duplicate route');
assert.deepEqual(Profession.routesForNpc('7'), [routes[1]]);
assert.equal(Profession.hasNpc(NaN), true, 'includes membership retains NaN');
assert.equal(Profession.handles('7'), true);
Profession.routesForNpc(7).pop();
assert.equal(Profession.routesForNpc(7).length, 2);
routes[0].classId = 4;
routes[0].npcs[0] = 9;
routes[0].npcs[1] = 9;
assert.equal(Profession.routeForClass(2), routes[1]);
assert.deepEqual(Profession.routesForNpc(7), [routes[2]]);
assert.deepEqual(Profession.routesForNpc(9), [routes[0]]);
const alternativeRoutes = [{ classId: 4, npcs: [40] }];
assert.equal(Profession.routeForClass(4, alternativeRoutes), alternativeRoutes[0]);
routes[0].classId = 40;
assert.equal(Profession.routeForClass(40), routes[0], 'A-B-A current frame sees source changes');
const publishedProfession = { routes: undefined };
assert.throws(() => Profession.routeForClass(40, publishedProfession.routes), error =>
    error instanceof TypeError && error.message.includes("reading 'find'"),
    'forwarded missing Service.routes keeps the original find error');
assert.throws(() => Profession.routesForNpc(7, publishedProfession.routes), error =>
    error instanceof TypeError && error.message.includes("reading 'filter'"),
    'analogous explicit missing route source must not default to internal routes');

const diamondData = { npcs: [7, '8', NaN], recipes: [{ itemId: 1 }, { itemId: 1 }, { itemId: '1' }, { itemId: NaN }] };
const Diamonds = loader({ 'data/Items/dimensional_diamond_exchanges.json': diamondData })('src/GameServer/Items/DimensionalDiamondCatalog.js');
assert.equal(Diamonds.recipe(1), diamondData.recipes[0]);
assert.equal(Diamonds.recipe('1'), diamondData.recipes[2]);
assert.equal(Diamonds.recipe(NaN), undefined);
assert.equal(Diamonds.hasRecipe(NaN), false);
assert.equal(Diamonds.hasNpc(8), false);
assert.equal(Diamonds.hasNpc('8'), true);
assert.equal(Diamonds.hasNpc(NaN), true);
diamondData.recipes[0].itemId = 2;
assert.equal(Diamonds.recipe(1), diamondData.recipes[1]);
diamondData.recipes = [{ itemId: 5 }];
diamondData.npcs[0] = 9;
assert.equal(Diamonds.recipe(5), diamondData.recipes[0]);
assert.equal(Diamonds.hasNpc(7), false);
assert.equal(Diamonds.hasNpc(9), true);

const saData = { blacksmiths: [7300], recipes: [
    { id: 'dup', station: 'blacksmith', sourceId: 1, operation: 'install' },
    { id: 'dup', station: 'blacksmith', sourceId: 1, operation: 'install' },
    { id: 'string', station: 'blacksmith', sourceId: '1', operation: 'install' },
    { id: 'nan', station: 'blacksmith', sourceId: NaN, operation: NaN }
] };
const SA = loader({ 'data/Items/weapon_sa_exchanges.json': saData,
    'data/Items/soul_crystals.json': { crystals: {} } })('src/GameServer/Items/C4WeaponSAExchange.js');
const expectedOptions = (npc, source, operation) => saData.recipes.filter(row =>
    row.station === SA.station(npc) && row.sourceId === Number(source) && row.operation === operation);
assert.equal(SA.resolve(7300, 'dup'), saData.recipes[1], 'LAST import recipe map stays separate');
assert.deepEqual(SA.options(7300, '1', 'install'), expectedOptions(7300, '1', 'install'));
SA.options(7300, 1, 'install').pop();
assert.equal(SA.options(7300, 1, 'install').length, 2);
saData.recipes[0].sourceId = 2;
saData.recipes.reverse();
assert.deepEqual(SA.options(7300, 1, 'install'), expectedOptions(7300, 1, 'install'));
assert.deepEqual(SA.options(7300, 'bad', NaN), []);
assert.deepEqual(SA.options(999, Symbol('no matching station'), 'install'), []);
assert.throws(() => SA.options(7300, Symbol('matching station'), 'install'), TypeError);
let calls = 0;
const movingSource = { valueOf: () => ++calls };
calls = 0; const originalMoving = expectedOptions(7300, movingSource, 'install');
calls = 0; assert.deepEqual(SA.options(7300, movingSource, 'install'), originalMoving);

const unsealData = { recipes: [{ sourceId: 1, productId: 2 }, { sourceId: 1, productId: 2 }, { sourceId: 1, productId: '2' }] };
const Unseal = loader({ 'data/Items/c4_unseal.json': unsealData })('src/GameServer/Items/C4Unseal.js');
assert.equal(Unseal.resolve('1', '2'), unsealData.recipes[0]);
assert.equal(Unseal.resolve(1, NaN), null);
assert.equal(Unseal.options(1), Unseal.options('1'), 'existing source bucket retains shared mutable array');
Unseal.options(1).shift();
assert.equal(Unseal.resolve(1, 2), unsealData.recipes[1]);
unsealData.recipes[1].productId = 3;
assert.equal(Unseal.resolve(1, 2), null);
assert.equal(Unseal.resolve(1, 3), unsealData.recipes[1]);
unsealData.recipes.push({ sourceId: 4, productId: 5 });
assert.deepEqual(Unseal.options(4), [], 'source import snapshot is unchanged');

const hallData = { halls: [{ id: 1, managerIds: [7], doormanIds: [8] },
    { id: 1, managerIds: [8], doormanIds: [7] }], auctioneerIds: [] };
const hallLoad = loader({ 'data/ClanHalls/catalog.json': hallData, 'src/GameServer/ClanHall/Runtime.js': {} });
const Halls = hallLoad('src/GameServer/ClanHall/Policy.js');
let managerReads = 0;
const secondManagers = hallData.halls[1].managerIds;
Object.defineProperty(hallData.halls[1], 'managerIds', {
    configurable: true, get() { managerReads++; return secondManagers; }
});
assert.equal(Halls.definition('1'), hallData.halls[0]);
assert.equal(managerReads, 0, 'definition stops at the first hall ID without projecting NPC lists');
Object.defineProperty(hallData.halls[1], 'managerIds', { configurable: true, writable: true, value: secondManagers });
assert.equal(Halls.hallForNpc('7'), hallData.halls[0]);
assert.equal(Halls.hallForNpc(8), hallData.halls[0], 'manager/doorman overlaps choose first hall in raw order');
hallData.halls.reverse();
assert.equal(Halls.definition(1), hallData.halls[0]);
assert.equal(Halls.hallForNpc(7), hallData.halls[0]);
hallData.halls[0].managerIds[0] = 9;
hallData.halls[0].doormanIds[0] = 10;
assert.equal(Halls.hallForNpc(7), hallData.halls[1]);
assert.equal(Halls.hallForNpc(10), hallData.halls[0]);
const HallNpc = hallLoad('src/GameServer/ClanHall/Npc.js');
const replacementHall = { id: 77, managerIds: [77], doormanIds: [] };
Halls.catalog = { halls: [replacementHall], auctioneerIds: [] };
assert.equal(HallNpc.handles(77), true, 'NPC reader retains current exported Policy.catalog source');
assert.equal(HallNpc.handles(7), false);
assert.equal(Halls.definition(1), hallData.halls[0], 'Policy definition retains internal import source');
Halls.catalog.halls = undefined;
assert.throws(() => HallNpc.handles(77), error =>
    error instanceof TypeError && error.message.includes("reading 'find'"),
    'forwarded missing published Policy.catalog.halls keeps the original find error');
assert.equal(Halls.hallForNpc(7), hallData.halls[1], 'omitted source still uses internal import');

const Pets = loader({ 'data/Pets/c4-stats.json': { rows: [] } })('src/GameServer/Pets/PetRules.js');
const wolf = Pets.TYPES[2375], hatchling = Pets.TYPES[3500];
assert.equal(Pets.typeForNpc('12077'), wolf);
assert.equal(Pets.typeForNpc(NaN), undefined);
hatchling.npcId = wolf.npcId;
assert.equal(Pets.typeForNpc(wolf.npcId), wolf, 'FIRST Object.values enumeration');
delete Pets.TYPES[2375];
assert.equal(Pets.typeForNpc(12077), hatchling, 'object deletion and in-place reverse key edits remain visible');

const Buffs = loader()('src/GameServer/Effects/BuffCatalog.js');
assert.equal(Buffs.byTypeOrKey('windwalk'), Buffs.ALL_BUFFS.windwalk);
assert.equal(Buffs.byTypeOrKey('windWalk'), Buffs.ALL_BUFFS.windwalk);
assert.equal(Buffs.byTypeOrKey('constructor'), Object, 'direct inherited property takes priority');
Buffs.ALL_BUFFS.shield.key = 'windWalk';
assert.equal(Buffs.byTypeOrKey('windWalk'), Buffs.ALL_BUFFS.windwalk);
Buffs.ALL_BUFFS.windwalk.key = 'changed';
assert.equal(Buffs.byTypeOrKey('windWalk'), Buffs.ALL_BUFFS.shield);
assert.equal(Buffs.byTypeOrKey('changed'), Buffs.ALL_BUFFS.windwalk);
Buffs.ALL_BUFFS.alias = { key: 'windWalk' };
assert.equal(Buffs.byTypeOrKey('alias'), Buffs.ALL_BUFFS.alias);
assert.equal(Buffs.byTypeOrKey(NaN), undefined);

const Gate = loader()('src/GameServer/World/C4GatekeeperTeleports.js');
assert.deepEqual(Gate.destination('7427', '30'), { locX: 48736, locY: 248463, locZ: -6162, price: 0 });
assert.equal(Gate.destination(7427, NaN), null);
Gate.lists[7427][0][0] = '30';
assert.equal(Gate.destination(7427, 30), null, 'strict source candidate vs numeric query');
Gate.lists[7427] = [[30, 'replacement']];
assert.equal(Gate.destination(7427, '030'), null, 'DESTINATIONS property lookup retains raw request key');
assert.equal(Gate.destination(7427, 30).price, 0);
Gate.lists[7427] = [];
assert.equal(Gate.destination(7427, Symbol('empty')), null, 'empty list never converts request');
Gate.lists[7427] = 0;
assert.throws(() => Gate.destination(7427, 30), TypeError, 'falsy malformed list keeps original exception');
assert.throws(() => Gate.destination('constructor', 30), TypeError, 'inherited LISTS property semantics remain');

console.log('PASS native service catalogue contracts: strict/FIRST/LAST/order/duplicates/mutable sources/fallbacks');
