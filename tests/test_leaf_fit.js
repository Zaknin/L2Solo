'use strict';
// The hunting leaf names a spot the bot may hunt (docs/architecture.md §2
// route, BotRoute.leafFitReader): in the worker's build a solo bot whose
// table pick is unfit for it, excluded by its own risk marks, or missing from
// the catalog gets a fitting spot of the income ranking (the money leaf: the
// first by income; the experience leaf: the most exp), with that spot's
// numbers; a fitting own sample row still counts; with no fitting spot, or
// in a build that does not ask (main), the table's pick stays.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leaf-fit-'));
const priorConfig = process.env.L2NODE_CONFIG_FILE;
const priorShared = process.env.L2NODE_SHARED_CONFIG_FILE;
const config = path.join(dir, 'config.ini');
fs.writeFileSync(config, fs.readFileSync(path.join(__dirname, '../config/default.ini'), 'utf8')
    + `\n[Database]\npath=${path.join(dir, 'world.sqlite')}\nhistoryPath=${path.join(dir, 'history.sqlite')}\n`);
process.env.L2NODE_CONFIG_FILE = config;
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.on('exit', () => {
    if (priorConfig === undefined) delete process.env.L2NODE_CONFIG_FILE; else process.env.L2NODE_CONFIG_FILE = priorConfig;
    if (priorShared === undefined) delete process.env.L2NODE_SHARED_CONFIG_FILE; else process.env.L2NODE_SHARED_CONFIG_FILE = priorShared;
    fs.rmSync(dir, { recursive: true, force: true });
});
require('../src/Global');
invoke('GameServer/DataCache').init();
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Table = invoke('GameServer/Bot/AI/SpotValueTable');
const Roles = invoke('GameServer/Bot/AI/BotRoles');
const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const Gear = invoke('GameServer/Bot/AI/BotGear');
const at = Date.now();

// A level-35 human fighter wearing its whole baseline kit: no gear to earn,
// so no income route; its hunt comes from the shared table.
const inventory = {};
Gear.planFor({ classId: 1, level: 20 }).items.forEach((item, index) => {
    inventory[index + 1] = { selfId: Number(item.selfId), amount: 1, equipped: true, equippedSlots: [Number(item.slot)] };
});
const state = { characterId: 990101, level: 35, phase: 'cold', activity: 'hunting', stats: { classId: 1 }, inventory };
const role = Roles.tableRoleFor(state);
const ranked = Table.rankedIncome(role, 35, Hunt.consumablePrices(state), -7, true, { spoilSkillLevel: 0 });
const tableBest = Table.best(role, 35, true).spotId;
const tableIncome = ranked[0].spotId;
assert.notEqual(tableBest, tableIncome, 'the fixture needs two table picks: the progress spot and the income spot');
const spot = (id, tags = []) => ({ id, avgLevel: 35, minLevel: 34, maxLevel: 36, density: 10,
    tagsAuthoritative: true, tags, npcEntries: [] });
// The worker's build asks for the fit (main's builds do not).
const worker = (bot, spots) => Economy.basics(bot, { timestamp: at, spots, leafFit: true });
const leafSpot = basics => basics.hunt.progressSpotId || basics.bestSpotId;
// What the fit walk reads: the ranked rows in order, the first fitting one
// earns, the fitting one with the most exp levels.
const walk = fit => {
    const rows = ranked.slice(0, 32).filter(row => fit.includes(row.spotId));
    return { earning: rows[0], leveling: rows.reduce((top, row) => row.exp > top.exp ? row : top, rows[0]) };
};
const listed = [...new Set([tableBest, ...ranked.slice(0, 6).map(row => row.spotId)])];

// Unfit: both table picks are party-only grounds for a solo bot.
const unfit = new Set([tableBest, tableIncome]);
const fitting = walk(listed.filter(id => !unfit.has(id)));
assert(fitting.earning && fitting.leveling !== fitting.earning,
    'the fixture holds fitting ranked spots that earn and level best apart');
const catalog = listed.map(id => spot(id, unfit.has(id) ? ['catacomb'] : []));
const swapped = worker(state, catalog);
assert.equal(swapped.bestSpotId, fitting.earning.spotId, 'the money leaf names the first fitting spot by income');
assert.equal(swapped.hunt.perHour, fitting.earning.income, 'and the hunt earns that spot\'s income');
assert.equal(leafSpot(swapped), fitting.leveling.spotId, 'the experience leaf names the fitting spot with the most exp');
assert.equal(swapped.hunt.expPerHour, fitting.leveling.exp, 'and the hunt levels at that spot\'s exp');

// Main's build keeps the table's picks.
const main = Economy.basics(state, { timestamp: at, spots: catalog });
assert.deepEqual([leafSpot(main), main.bestSpotId], [tableBest, tableIncome], 'a build that does not ask keeps the table');

// The exp leaf falls back by exp: only the progress pick is unfit.
const progressOnly = walk(listed.filter(id => id !== tableBest));
const leveling = worker(state, listed.map(id => spot(id, id === tableBest ? ['catacomb'] : [])));
assert.equal(leveling.bestSpotId, tableIncome, 'a fitting income pick stays');
assert.equal(leafSpot(leveling), progressOnly.leveling.spotId, 'the progress pick is the fitting spot with the most exp');
assert.notEqual(progressOnly.leveling.spotId, progressOnly.earning.spotId, 'not the first by income');

// Excluded: the bot's own risk exclusions (spots it was turned away from as full).
const turnedAway = { ...state, stats: { ...state.stats, capacityBackoffs: [...unfit].map(spotId => ({ spotId, untilStep: 50 })) } };
const excluded = worker(turnedAway, listed.map(id => spot(id)));
assert.equal(excluded.bestSpotId, fitting.earning.spotId, 'an excluded spot is no income pick');
assert.equal(leafSpot(excluded), fitting.leveling.spotId, 'nor a progress pick');

// Missing: the catalog does not hold the table picks.
const present = ranked.slice(1, 6).map(row => row.spotId).filter(id => id !== tableBest);
const kept = worker(state, present.map(id => spot(id)));
assert.equal(kept.bestSpotId, walk(present).earning.spotId, 'a spot missing from the catalog is skipped');
assert.equal(leafSpot(kept), walk(present).leveling.spotId);

// Own samples: an unfit best row gives way to the bot's other fitting row.
let sampled = state;
for (let i = 0; i < 3; i++) for (const [spotId, adena] of [[tableBest, 9000], [fitting.earning.spotId, 3000]]) {
    sampled = { ...sampled, stats: { ...sampled.stats, huntEfficiency: Hunt.record(sampled,
        { spotId, cycleMs: 60000, exp: 100, adena, kills: 5, timestamp: at }) } };
}
const own = worker(sampled, catalog);
assert.equal(own.hunt.source, 'own', 'a fitting own row still counts');
assert.equal(own.bestSpotId, fitting.earning.spotId);

// Nothing fits: the table's pick stays.
const none = worker(state, listed.map(id => spot(id, ['catacomb'])));
assert.equal(leafSpot(none), tableBest, 'with no fitting spot the progress pick is the table\'s');
assert.equal(none.bestSpotId, tableIncome, 'and the income pick is the table\'s');

console.log('test_leaf_fit passed');
