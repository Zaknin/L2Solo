'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.env.L2NODE_CONFIG_FILE = 'config/default.ini';
require('../src/Global');
const path = require('node:path'), { Worker } = require('node:worker_threads');
const Data = invoke('GameServer/DataCache'); Data.init();
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const { npcPlanningCatalogRows } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const spots = require('./helpers/wishSectionSpots')();
const spot = spots.find(row => row.npcEntries?.some(entry => entry.selfId === 414));
const timestamp = Date.now(), id = 92081;
const state = { characterId: id, level: 35, exp: Number(Data.experience[34]), sp: 0,
    adena: 50, phase: 'cold', activity: 'hunting', updatedAt: timestamp, spotId: String(spot.id),
    currentRegion: 'Giran', loc: { ...spot.center },
    vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
    inventory: invoke('GameServer/Bot/Population/BotLifeState').inventorySummaryFromItems([
        { id: 920811, selfId: 1, amount: 1, equipped: 1, slot: 7 },
        { id: 920812, selfId: 1835, amount: 10000, equipped: 0, slot: 0 },
        { id: 920813, selfId: 1869, amount: 1000, equipped: 0, slot: 0 },
        { id: 920814, selfId: 57, amount: 50, equipped: 0, slot: 0 }]),
    stats: { classId: 1, generatedCold: true, classProgressionClassId: 1, classProgressionLevel: 35,
        coldCombat: { version: invoke('GameServer/Bot/Population/ColdCombatProfile').PROFILE_VERSION,
            classId: 1, skillSource: 'database', skills: [] } },
    timing: { lastResolvedAt: timestamp, nextResolveAt: timestamp + 60000 } };
// Exercise the real worker's planning/projection callbacks and canonical
// publications, including eviction. A direct helper test cannot prove this.
const observer = String.raw`
module.exports.wishSectionsProbe = async id => {
    const assert = require('node:assert/strict');
    const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
    const Providers = invoke('GameServer/Bot/Economy/WishProviders');
    const Events = invoke('GameServer/Bot/AI/DecisionEvents');
    const original = Providers.build;
    let builds = 0;
    Providers.build = (...args) => { builds++; return original(...args); };
    try {
        let state = kernel.states.get(id).state, clock = Number(state.updatedAt);
        // Accept the initial native acquisition metadata before the counted
        // steady rounds; the actual plan is then carried through publication.
        for (let at = 0; at < 3; at++) {
            const entry = kernel.states.get(id);
            const plan = await kernel.planLifecycle({ state, context: entry.context, timestamp: clock });
            state = { ...plan.plannedState, stats: { ...plan.plannedState.stats, ...plan.statsPacket } };
            kernel.states.set(id, { ...entry, state });
        }
        const accepted = kernel.states.get(id).context.wishAdvisory;
        assert(accepted, 'native worker retains a bounded accepted decision');
        assert.equal(accepted.card.activity.activity, 'hunting');
        const focus = state.stats.wishFocus, leaf = state.stats.activityLeaf;
        const seq = state.stats.decisionSeq, planBefore = state.stats.equipmentPlan;
        const before = builds;
        for (let at = 0; at < 4; at++) {
            const entry = kernel.states.get(id);
            Economy.forgetContext(id); // a cold population exceeds cache64
            const planned = await kernel.planLifecycle({ state, context: entry.context, timestamp: clock });
            assert.equal(builds, before, 'an ordinary native lifecycle retains its accepted preparation after eviction');
            assert.deepEqual(planned.acquisitionPlan, planBefore, 'a valid accepted native goal remains selected');
            const result = await kernel.projectResolve(planned.plannedState, {
                patch: { inventory: { ...planned.plannedState.inventory, 1835: {
                    ...planned.plannedState.inventory[1835], amount: planned.plannedState.inventory[1835].amount - 1 } } },
                materialize: { exp: 1, sp: 1, adena: 1, items: [{ selfId: 1869, amount: 1 }] },
                // Two completed fights and two unfinished slices; the native
                // learning threshold is tested separately below.
                debug: { shotActions: 1, fights: at < 2 ? 1 : 0, wins: at < 2 ? 1 : 0 },
                events: [], nextResolveAt: clock + 60000
            }, ++clock);
            state = result.state;
            assert.equal(state.inventory[1835].amount, 9999 - at, 'native consumption remains physical');
            assert.equal(state.inventory[1869].amount, 1001 + at, 'native loot is never cached away');
            assert.equal(state.adena, 51 + at);
            assert.equal(state.inventory[57].amount, state.adena, 'the real money stack follows the actual wallet');
            assert.deepEqual(state.stats.wishFocus, focus);
            assert.equal(state.stats.activityLeaf, leaf);
            assert.equal(state.stats.decisionSeq, seq);
            const currentCard = ColdEconomyDecision.compact(result.economyDecision);
            assert.equal(currentCard.updatedAt, state.updatedAt);
            assert.equal(currentCard.key, ColdEconomyDecision.stateKey(state));
            const cards = new ColdEconomyDecision.ColdEconomyDecisions();
            cards.accept(id, result.economyDecision);
            assert(cards.decided(state));
            assert.equal(cards.decided({ ...state, adena: state.adena + 1 }), null,
                'reuse cannot grant spending authority for another real wallet');
            const incomingContext = { ...entry.context };
            assert.equal(Object.hasOwn(incomingContext, 'wishAdvisory'), false, 'advice never enters transport context');
            // Main's native publication reflects the new quantity in both
            // the aggregate and its same owned stack; IDs never change here.
            state = { ...state, inventory: invoke('GameServer/Bot/Population/BotLifeState').inventorySummaryFromItems([
                { id: 920811, selfId: 1, amount: 1, equipped: 1, slot: 7 },
                { id: 920812, selfId: 1835, amount: state.inventory[1835].amount, equipped: 0, slot: 0 },
                { id: 920813, selfId: 1869, amount: state.inventory[1869].amount, equipped: 0, slot: 0 },
                { id: 920814, selfId: 57, amount: state.adena, equipped: 0, slot: 0 }]) };
            kernel.states.set(id, { ...entry, state, context: incomingContext });
            assert(kernel.states.get(id).context.wishAdvisory, 'technical publication retains runtime advice');
        }
        assert.equal(builds, before, 'ordinary consuming rounds do not reconstruct providers after cache eviction');
        const ordinaryBuilds = builds - before;
        // A still-valid calculation never suppresses the native route-failure
        // counter, including with developer diagnostics disabled.
        const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
        const Selection = invoke('GameServer/Bot/AI/GearPlanSelection');
        const acquisitionState = state;
        const ownedItems = Object.values(acquisitionState.inventory).filter(row => row.amount > 0)
            .map(row => DataCache.items.find(item => item.selfId === row.selfId)).filter(Boolean);
        let target, source;
        for (const item of DataCache.items) {
            if (!Planner.considerable(item, acquisitionState)
                || !Planner.isSlotUpgrade(item, ownedItems, Planner.roleFor(acquisitionState), acquisitionState.stats.classId)) continue;
            const route = Planner.sourceForItem(item.selfId, planningSpots, acquisitionState)
                .find(row => Planner.isPlanSourceViableForState(acquisitionState, { next: row }));
            if (route) { target = item; source = route; break; }
        }
        assert(source, 'native catalogue supplies an actual upgrade with an eligible drop source');
        let active = { ...acquisitionState, stats: { ...acquisitionState.stats, equipmentPlan: {
            status: 'active', strategy: 'direct_drop',
            grade: invoke('GameServer/Bot/AI/PersonalGearProgression').acquisitionRankFor(acquisitionState),
            plannedForLevel: acquisitionState.level, plannedForGrade: Planner.gradeForLevel(acquisitionState.level), startedAt: clock,
            rateModelVersion: Planner.RATE_MODEL_VERSION, rateProfileSignature: Planner.rateProfileSignature(),
            target: { selfId: target.selfId, slot: target.etc.slot },
            next: { ...source, itemId: target.selfId },
            targetProgress: { npcId: source.npcId, resolves: 0, targetKills: 0 },
            progressionBaseline: { level: acquisitionState.level, exp: acquisitionState.exp }, recoveryTargets: []
        }, targetCombat: { populationTargets: { [source.npcId]: { resolves: 0, targetKills: 0 } } } } };
        const routeRows = await occupationFor(active, clock, kernel.states.get(id).context, 'wish');
        const workshop = await occupationFor(active, clock, { ...kernel.states.get(id).context,
            routeRows, routeKey: EconomicTrip.key(active) });
        const deps = { spots: planningSpots, occupancy: currentPlanningOccupancy(clock), timestamp: clock,
            board: boardReady(), routeRows, workshop };
        const prepared = Economy.forState(active, deps);
        active = { ...active, stats: { ...active.stats, ...prepared.statsPacket } };
        const advice = ColdEconomyDecision.advisory(prepared, active);
        const failed = { ...active, stats: { ...active.stats,
            targetCombat: { populationTargets: { [source.npcId]: {
                resolves: Planner.DIRECT_FAILURE_RESOLVE_LIMIT, targetKills: 0 } } } } };
        assert.equal(Planner.replanContextFor(failed, failed.stats.equipmentPlan, clock).failure.reason, 'combat_unviable');
        assert(ColdEconomyDecision.refreshAdvisory(failed, advice, deps),
            'failure counters alone leave the expensive calculation proof valid');
        const nativeSelection = Selection.selectAcquisitionPlan;
        let failureChecked = false;
        Selection.selectAcquisitionPlan = (...args) => {
            assert.equal(args[2].preparedReplanContext.failure.reason, 'combat_unviable');
            failureChecked = true; return nativeSelection(...args);
        };
        try {
            await kernel.planLifecycle({ state: failed, context: { ...kernel.states.get(id).context,
                wishAdvisory: advice }, timestamp: clock });
            assert(failureChecked, 'the native lifecycle bypasses thin reuse on a failed acquisition route');
        } finally { Selection.selectAcquisitionPlan = nativeSelection; }
        kernel.states.set(id, { ...kernel.states.get(id), state, context: { wishAdvisory: accepted } });
        const beforeLearning = builds;
        const learned = await kernel.projectResolve(state, {
            patch: { inventory: { ...state.inventory, 1835: { ...state.inventory[1835], amount: state.inventory[1835].amount - 1 } } },
            materialize: { exp: 1, sp: 1, adena: 1, items: [{ selfId: 1869, amount: 1 }] },
            debug: { shotActions: 1, fights: 1, wins: 1 }, events: [], nextResolveAt: clock + 60000
        }, ++clock);
        state = learned.state;
        assert(state.stats.wishSections.sample.length > 0, 'the third native sample creates usable own knowledge');
        assert(builds > beforeLearning, 'new usable income knowledge remains a real calculation trigger');
        kernel.states.set(id, { ...kernel.states.get(id), state });
        const currentSeq = state.stats.decisionSeq;
        const dead = { ...state, activity: 'dead', stats: { ...state.stats, deaths: Number(state.stats.deaths || 0) + 1 } };
        Events.reconcile(state, dead, ++clock);
        assert.equal(dead.stats.decisionSeq, currentSeq + 1, 'a real death remains a decision event');
        assert.equal(ColdEconomyDecision.refreshAdvisory(dead, kernel.states.get(id).context.wishAdvisory,
            { timestamp: clock }), null);
        const entry = kernel.states.get(id);
        kernel.states.set(id, { ...entry, state: { ...state, phase: 'hot' } });
        assert.equal(kernel.states.get(id).context.wishAdvisory, null, 'cold advice releases on the native hot handoff');
        kernel.states.delete(id);
        assert.equal(kernel.states.has(id), false, 'retirement releases the existing advice owner');
        return { ordinaryRounds: 4, additionalProviderBuilds: ordinaryBuilds,
            forbiddenLoaded: Object.keys(require.cache).filter(key => /\/Database\.js$|\/Network\/|\/World\/World\.js$/.test(key)) };
    } finally { Providers.build = original; }
};`;
const wrapper = String.raw`
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const { parentPort, workerData } = require('node:worker_threads');
const loaded = new Module(workerData.workerPath, module);
loaded.filename = workerData.workerPath; loaded.paths = Module._nodeModulePaths(path.dirname(workerData.workerPath));
loaded._compile(fs.readFileSync(workerData.workerPath, 'utf8') + workerData.observer, workerData.workerPath);
parentPort.on('message', message => {
    if (!message.wishSectionsProbe) return;
    loaded.exports.wishSectionsProbe(message.wishSectionsProbe).then(value => parentPort.postMessage({ probeId: message.msgId, value }))
        .catch(error => parentPort.postMessage({ probeId: message.msgId, error: error.stack }));
});`;
(async () => {
    const epoch = 'native:wish-sections', messages = []; let fault;
    const worker = new Worker(wrapper, { eval: true, workerData: { workerEpoch: epoch, observer,
        workerPath: path.resolve(__dirname, '../src/GameServer/Bot/Population/ColdSimulationWorker.js') } });
    worker.on('message', message => messages.push(message)); worker.on('error', error => { fault = error; });
    const wait = async predicate => { const deadline = Date.now() + 60000;
        while (!messages.some(predicate)) { if (fault) throw fault;
            const rejected = messages.find(message => message.type === 'fault'); if (rejected) throw Error(JSON.stringify(rejected));
            if (Date.now() > deadline) throw Error('native wish section timeout');
            await new Promise(resolve => setTimeout(resolve, 10)); }
        return messages.find(predicate); };
    const send = (type, payload, msgId) => worker.postMessage(Protocol.envelope(type, epoch, payload, msgId));
    try {
        await wait(message => message.type === 'ready' && message.payload.phase === 'loaded');
        const catalog = npcPlanningCatalogRows();
        for (let at = 0; at < catalog.length; at += Protocol.MAX_BATCH) send('catalog_page', { catalog: 'npc_offers',
            rows: catalog.slice(at, at + Protocol.MAX_BATCH), done: at + Protocol.MAX_BATCH >= catalog.length });
        for (let at = 0; at < spots.length; at += Protocol.MAX_BATCH) send('catalog_page', { catalog: 'spots', rows: spots.slice(at, at + Protocol.MAX_BATCH) });
        send('init', { config: { loopIntervalMs: 1000 } }, 'init');
        await wait(message => message.type === 'ready' && message.payload.phase === 'running'); send('pause', {}, 'pause');
        send('table_page', { tables: [{ name: 'board', from: null, to: 0, full: true, rows: [], removed: [], last: true },
            { name: 'market', from: null, to: 0, full: true, rows: [], removed: [], last: true }] });
        send('snapshot_page', { rows: [{ state, context: {} }], ack: true }, 'state');
        await wait(message => message.type === 'ready' && message.msgId === 'state');
        worker.postMessage({ ...Protocol.envelope('pause', epoch, {}, 'probe'), wishSectionsProbe: id });
        const response = await wait(message => message.probeId === 'probe'); if (response.error) throw Error(response.error);
        assert.equal(response.value.additionalProviderBuilds, 0);
        assert.deepEqual(response.value.forbiddenLoaded, []);
        console.log('Native worker keeps goals and fresh resources through four consuming rounds and cache eviction');
    } finally { await worker.terminate(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
