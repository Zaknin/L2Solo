'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-events-'));
const config = path.join(dir, 'config.ini');
fs.writeFileSync(config, fs.readFileSync(path.join(__dirname, '../config/default.ini'), 'utf8')
    + `\n[Database]\npath=${path.join(dir, 'world.sqlite')}\nhistoryPath=${path.join(dir, 'history.sqlite')}\n`);
process.env.L2NODE_CONFIG_FILE = config;
delete process.env.L2NODE_SHARED_CONFIG_FILE;
require('../src/Global');
const DiagnosticConfig = invoke('GameServer/Bot/Population/PopulationConfig');
DiagnosticConfig.developerDiagnostics = true;
const Hunting = invoke('GameServer/Bot/AI/States/HuntingState');
const Events = invoke('GameServer/Bot/AI/DecisionEvents');
const Funding = invoke('GameServer/Bot/Economy/PurchaseFunding');
const { WishNetwork } = invoke('GameServer/Bot/Economy/WishNetwork');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const World = invoke('GameServer/World/World');
const Floor = invoke('GameServer/Bot/Population/SurvivalFloor');
const money = [100000, 0.001, 15000, 1200000, .002, 20000, 1463];
assert.equal(Funding.moneyReached({ adena: 1234999, stats: { money } }), false);
assert.equal(Funding.moneyReached({ adena: 1235000, stats: { money } }), true);
assert.equal(Funding.moneyReached({ adena: 9999999, stats: {} }), false);
assert.equal(Funding.moneyReached({ adena: 9999999, stats: { money: [1, 1, 1, 0] } }), false);

World.user = { sessions: [] }; World.npc = { spawns: [], grid: {} };
invoke('GameServer/Bot/AI/HotTownRebuff').syncVisit = () => null;
invoke('GameServer/Bot/AI/HotTownRebuff').needsVisit = () => false;
invoke('GameServer/Bot/AI/BotBuffs').needsNewbieRefresh = () => false;
invoke('GameServer/Bot/AI/PartyAwareness').npcThreateningActor = () => null;
invoke('GameServer/Bot/AI/RestPolicy').needsRest = () => false;
Floor.forActor = () => null;
let wallet = 1000, level = 30, load = 10, slots = 1;
const items = [{ fetchId: () => 7001, fetchSelfId: () => 57, fetchAmount: () => wallet }];
const actor = { fetchId: () => 701, fetchLevel: () => level, fetchClassId: () => 1,
    fetchRace: () => 0, fetchMaxLoad: () => 1000, fetchKarma: () => 0,
    fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0,
    fetchHp: () => 100, fetchMaxHp: () => 100, fetchMp: () => 100, fetchMaxMp: () => 100,
    backpack: { fetchItems: () => items, fetchTotalLoad: () => load, fetchTotalAdena: () => wallet },
    state: { fetchDead: () => false, fetchTowards: () => false, fetchHits: () => false,
        fetchCasts: () => false, fetchSeated: () => false }, unselect() {}, automation: { abortAll() {} } };
const session = { accountId: 'bot_events', actor, plan: 'hunting', coldLifeState: {
    stats: { decisionSeq: 5, activityLeaf: 0, wishFocus: ['hunt', 0, 0] } },
    spotRelocation: { method: 'clan_hall', arrivalPending: true, startedAt: Date.now() } };
const network = new WishNetwork();
const build = WishNetwork.prototype.build;
let builds = 0;
WishNetwork.prototype.build = function(input) { builds++; return build.call(this, input); };
Economy.forActor = (bot, current) => {
    const stats = Events.statsFor(current);
    const result = network.build({ actorKey: `character:${bot.fetchId()}`, characterId: bot.fetchId(),
        inputKey: `loot:${wallet}:${stats.decisionSeq}`, decisionSeq: stats.decisionSeq, activityLeaf: stats.activityLeaf,
        previous: { focus: stats.wishFocus || current.heldEconomy?.statsPacket.wishFocus },
        wallet, hourAdena: 100, roots: ['hunt'],
        nodes: [{ key: 'hunt', need: 'power', valueHours: 1, paths: [{ activity: 'hunting', costHours: 1 }] }] });
    return { stock: () => ({ itemId: 1835, usePerHour: 0 }), network: result, statsPacket: { decisionSeq: result.decisionSeq, activityLeaf: result.activityLeaf,
        wishFocus: result.focus, money: [100, .01, 0, 0] } };
};
const tick = () => Hunting.tick(session, actor, {}, { say() {} });
tick();
assert.equal(builds, 1);
builds = 0;
for (let i = 0; i < 1000; i++) { wallet++; actor.backpack.inventoryRevision = i; tick(); }
assert.equal(builds, 0, '1,000 real hunting ticks with loot changes reuse one decision');
assert(Buffer.byteLength(JSON.stringify(session.heldEconomy)) < 1024);
level++;
tick();
assert.equal(builds, 1, 'level up rebuilds once');
builds = 0;
session.plan = 'resting'; session.plan = 'hunting'; tick();
assert.equal(builds, 0, 'resting resumes the held decision');
const Shopping = invoke('GameServer/Bot/AI/States/ShoppingState');
invoke('GameServer/Bot/TradeService').findBestBuyerForActor = () => null;
invoke('GameServer/Bot/TradeService').findAfkBuyerForActor = () => null;
invoke('GameServer/Bot/Economy/TownServiceCatalog').targetFor = () => null;
invoke('GameServer/Bot/Economy/TownServiceCatalog').targetNear = () => null;
invoke('GameServer/Bot/AI/TownChatter').say = () => {};
session.plan = 'shopping'; session.shoppingEquipmentPlanChecked = true; session.shoppingWarehouseDone = true;
const beforeTown = session.coldLifeState.stats.decisionSeq;
Shopping.tick(session, actor, {}, { getClosestTown: () => ({ name: 'Test town' }), say() {} });
assert.equal(session.plan, 'hunting');
assert.equal(session.coldLifeState.stats.decisionSeq, beforeTown + 1, 'the shopping call site raises the town event');
builds = 0; tick();
assert.equal(builds, 1, 'shopping completion invalidates exactly one decision');
builds = 0;
tick(); assert.equal(builds, 0, 'the returned packet seq does not cause an extra rebuild');
load = 600; actor.backpack.inventoryRevision++; tick(); assert.equal(builds, 1);
tick(); assert.equal(builds, 1, 'unchanged weight step is not another event');
while (items.length < 80) items.push({ fetchId: () => 7001 + items.length, fetchSelfId: () => 1 });
actor.backpack.inventoryRevision++; tick(); assert.equal(builds, 2);
tick(); assert.equal(builds, 2, 'a bag that stays full raises once');
session.coldLifeState.stats.money = money; wallet = 1234999;
Events.observe(session, actor);
wallet++; tick(); assert.equal(builds, 3, 'reaching the funded-prefix plus gap raises once');
tick(); assert.equal(builds, 3, 'the next packet resets the threshold mark');
session.coldLifeState.stats.money = money; wallet = 1235000;
Events.observe(session, actor);
const beforeLoss = session.coldLifeState.stats.decisionSeq;
wallet = 34999;
level++;
Events.observe(session, actor);
assert.equal(session.coldLifeState.stats.decisionSeq, beforeLoss + 1,
    'a funded-prefix loss and level event coalesce into one decision');
assert.equal(Events.held(session), null, 'the native hot holder notices loss as well as gain');
const Data = invoke('GameServer/DataCache'); Data.init();
const Sections = invoke('GameServer/Bot/Economy/DecisionSections');
const Valuation = invoke('GameServer/Bot/Economy/EconomicValuation');
const persona = { understanding: .8, traits: { commitment: .5 } };
level = 39;
let experience = Number(Data.experience[38]);
const stageRemaining = Number(Data.experience[39]) - experience;
actor.fetchExp = () => experience;
const progressSession = { accountId: 'bot_progress', actor, plan: 'hunting',
    spotRelocation: { method: 'clan_hall', arrivalPending: true, startedAt: Date.now() },
    coldLifeState: { persona, stats: { decisionSeq: 50, activityLeaf: 0, exp: 0 } } };
const priorEconomyForActor = Economy.forActor;
Economy.forActor = (bot, current) => {
    const context = priorEconomyForActor(bot, current);
    if (current === progressSession) {
        const progress = { level: bot.fetchLevel(), adena: wallet, stats: { exp: bot.fetchExp(), money: context.statsPacket.money } };
        context.statsPacket.wishSections = { wallet, cashBounds: [-1, null], moneyError: -1,
            funding: Sections.fundingMark(progress), expHour: 1000,
            horizon: Valuation.stageHours(progress, 1000, persona), incomeError: Sections.incomeError(progress, persona) };
    }
    return context;
};
const progressTick = () => Hunting.tick(progressSession, actor, {}, { say() {} });
progressTick();
const progressBuilds = builds, progressSeq = progressSession.coldLifeState.stats.decisionSeq;
assert(.2 > progressSession.coldLifeState.stats.wishSections.incomeError);
experience += stageRemaining * .02;
progressTick();
assert.equal(builds, progressBuilds, 'small native XP reuses the accepted horizon');
experience += stageRemaining * .18;
progressTick();
assert.equal(level, 39);
assert.equal(builds, progressBuilds + 1, '20% less remaining stage at the same level refreshes the hot decision');
assert.equal(progressSession.coldLifeState.stats.decisionSeq, progressSeq + 1);
progressTick();
assert.equal(builds, progressBuilds + 1, 'the accepted new horizon is the next anchor, with no repeated roll');
experience += stageRemaining * .2;
progressTick();
assert.equal(builds, progressBuilds + 2, 'later meaningful XP is compared with the last accepted horizon');
Economy.forActor = priorEconomyForActor;
const fallback = { actor, plan: 'hunting' };
Events.raiseDecision(fallback, 'revived');
Hunting.economyForHunt(fallback, actor);
assert.deepEqual(Object.keys(fallback.decisionStats).sort(), ['activityLeaf', 'decisionSeq', 'wishDirty']);
assert(Events.summary(1, Date.now() + 60000).total >= 6);
DiagnosticConfig.developerDiagnostics = false;
const observedClock = Date.now;
Date.now = () => { throw Error('optional summary clock off'); };
try { assert.deepEqual(Events.summary(1), { enabled: false }); } finally { Date.now = observedClock; }
assert.equal(invoke('Database').isReady(), false);
assert.deepEqual(fs.readdirSync(dir), ['config.ini']);
console.log('PASS gap money edge / 1,000 hot ticks / level / town / weight / bag / no SQL');
fs.rmSync(dir, { recursive: true, force: true });
