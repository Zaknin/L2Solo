'use strict';
// The hunting leaf names a spot the bot may hunt (docs/architecture.md §2
// route): a solo bot whose table pick is unfit for it, or missing from the
// catalog, gets the first fitting spot of the income ranking, with that
// spot's income; with no fitting spot the table's pick stays.
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
const spot = (id, tags = []) => ({ id, avgLevel: 35, minLevel: 34, maxLevel: 36, density: 5,
    tagsAuthoritative: true, tags, npcEntries: [] });
const leafSpot = basics => basics.hunt.progressSpotId || basics.bestSpotId;
const firstOf = (ids) => ranked.find(row => ids.includes(row.spotId));

// Unfit: both table picks are party-only grounds for a solo bot.
const unfit = new Set([tableBest, tableIncome]);
const listed = [...new Set([tableBest, ...ranked.slice(0, 6).map(row => row.spotId)])];
const fitting = listed.filter(id => !unfit.has(id));
const expected = firstOf(fitting);
assert(expected, 'the fixture holds a fitting ranked spot');
const swapped = Economy.basics(state, { timestamp: at,
    spots: listed.map(id => spot(id, unfit.has(id) ? ['catacomb'] : [])) });
assert.equal(leafSpot(swapped), expected.spotId, 'the experience leaf names the first fitting ranked spot');
assert.equal(swapped.bestSpotId, expected.spotId, 'the money leaf names the same fitting spot');
assert.equal(swapped.hunt.perHour, expected.income, 'the hunt\'s income is that spot\'s');
assert.equal(swapped.hunt.expPerHour, expected.exp, 'and its exp');

// Missing: the catalog does not hold the table picks.
const present = ranked.slice(1, 6).map(row => row.spotId).filter(id => id !== tableBest);
const kept = Economy.basics(state, { timestamp: at, spots: present.map(id => spot(id)) });
assert.equal(leafSpot(kept), firstOf(present).spotId, 'a spot missing from the catalog is skipped');
assert.equal(kept.bestSpotId, firstOf(present).spotId);

// Nothing fits: the table's pick stays.
const none = Economy.basics(state, { timestamp: at, spots: listed.map(id => spot(id, ['catacomb'])) });
assert.equal(leafSpot(none), tableBest, 'with no fitting spot the progress pick is the table\'s');
assert.equal(none.bestSpotId, tableIncome, 'and the income pick is the table\'s');

console.log('test_leaf_fit passed');
