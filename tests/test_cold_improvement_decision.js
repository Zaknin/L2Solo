// L25: the post-commit improvement review of a cold bot uses the worker's
// decision made on the committed state and builds no wish network on main;
// without a decision it waits for the next worker resolve.
const assert = require('node:assert/strict');
require('../src/Global');
const { capture, stateKey } = require('../src/GameServer/Bot/Population/ColdEconomyDecision');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Database = invoke('Database');
const Service = invoke('GameServer/Bot/Economy/BotImprovementService');
const Sections = invoke('GameServer/Bot/Economy/DecisionSections');
const ColdCraft = invoke('GameServer/Bot/Economy/ColdCraftingService');
const Population = invoke('GameServer/Bot/Population/PopulationService');
const World = invoke('GameServer/World/World');

(async () => {
    const improvement = { kind: 'enchant', itemId: 4001, riskHours: 2 };
    const economy = { riskWeight: 1.5, network: { activity: { activity: 'improving', improvement, spotId: null, npcId: null } } };
    const decision = capture(economy, { characterId: 41, updatedAt: 500 });
    assert.equal(decision.updatedAt, 500);
    assert.equal(decision.key, stateKey({ characterId: 41, updatedAt: 500 }));
    assert.equal(decision.riskWeight, 1.5);
    assert.deepEqual(decision.activity.improvement, improvement);
    assert.equal(capture({ riskWeight: 1, network: { activity: { activity: 'hunting', improvement } } }, {}).activity.improvement,
        undefined, 'an improvement travels only when the bot is improving');

    const state = { characterId: 41, phase: 'cold', activity: 'hunting', updatedAt: 500, simulation: { ownerId: 'legacy_main' },
        stats: { decisionSeq: 7, activityLeaf: 18, wishFocus: ['enchant:4001'] } };
    const writes = [];
    let builds = 0, rejection = null, current = state, beforeReject = null, attempts = 0;
    const rejections = [];
    const saved = { forState: Economy.forState, apply: Database.applyBotImprovement, cached: Life.cachedState, accept: Life.acceptLifecycleRow, upsert: Life.upsertState, craft: ColdCraft.craft, registered: World.registeredActorById, npcs: World.fetchNpcsInRadius };
    Economy.forState = () => { builds += 1; return economy; };
    Database.applyBotImprovement = async (id, plan, options) => { attempts++; beforeReject?.(); if (rejection) throw typeof rejection === 'string' ? Error(rejection) : rejection; writes.push({ id, plan, options }); return { coldLifeRow: { characterId: id } }; };
    Life.cachedState = () => current;
    Life.upsertState = async next => { rejections.push(next); current = next; return next; };
    Life.acceptLifecycleRow = () => state;
    try {
        await Service.reviewCold(state, { beforeWrite: 'w', decide: () => decision });
        assert.equal(builds, 0, 'the decided state builds no network on main');
        assert.deepEqual(writes[0].plan, { ...improvement, lossHours: 3 });
        assert.equal(writes[0].options.decide, undefined, 'the decision is not passed to the writer');
        assert.equal(writes[0].options.beforeWrite, 'w');

        await Service.reviewCold(state, { beforeWrite: 'w' });
        assert.equal(builds, 0, 'without a decision no network is built');
        assert.equal(writes.length, 1, 'no improvement without a worker decision');
        rejection = 'improvement_source_changed';
        const failed = await Service.reviewCold(state, { decide: () => decision });
        assert.strictEqual(failed.state, current);
        assert.equal(current.stats.decisionSeq, 8);
        assert.equal(current.stats.activityLeaf, 0);
        assert.equal(current.stats.wishDirty, Sections.sectionBit('sources'));
        assert.equal(state.stats.decisionSeq, 7, 'accepted input is immutable');
        await Service.reviewCold(state, { decide: () => decision });
        assert.equal(rejections.length, 1, 'the old rejected tuple cannot invalidate another decision again');
        rejection = 'economy_state_changed';
        await assert.rejects(Service.reviewCold(state, { decide: () => decision }), /economy_state_changed/);
        assert.equal(rejections.length, 1, 'native CAS retry never emits a semantic rejection event');
        assert.equal(builds, 0);
        current = state; rejections.length = 0;
        const changedMaterials = { ...state, inventory: { 1864: { selfId: 1864, amount: 0 } } };
        ColdCraft.craft = async () => ({ state: changedMaterials, crafted: false, reason: 'materials_changed' });
        const rejectedCraft = await Population.resolveColdCraft(state, state, Date.now());
        assert.equal(rejectedCraft.state.stats.wishDirty, Sections.sectionBit('sources'));
        assert.equal(rejectedCraft.state.stats.activityLeaf, 0);
        assert.deepEqual(rejectedCraft.state.inventory, changedMaterials.inventory,
            'the actual craft dispatcher persists the native returned physical inventory');
        current = state;
        ColdCraft.craft = async () => ({ state, crafted: false, reason: 'station_unavailable' });
        const waiting = await Population.resolveColdCraft(state, state, Date.now());
        assert.equal(waiting.state.stats.wishDirty || 0, 0, 'station MP/unavailability remains a native wait');
        assert.equal(waiting.state.stats.decisionSeq, 7);
        const actor = { fetchId: () => 41, isDead: () => false, fetchIsOnline: () => true,
            fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0 };
        const marker = { preserved: true }, hotStats = { decisionSeq: 31, activityLeaf: 75, wishFocus: ['enchant:4001'], marker };
        const session = { actor, accountId: 'bot_41', decisionStats: { ...hotStats } };
        let registration = { actor, session };
        World.registeredActorById = () => registration;
        World.fetchNpcsInRadius = () => [];
        const hotContext = { ...economy, state: { characterId: 41, stats: hotStats }, statsPacket: { ...hotStats } };
        const semanticError = Error('improvement_source_changed');
        rejection = semanticError;
        const beforeHotWrites = rejections.length;
        await assert.rejects(Service.reviewHot(session, hotContext), error => error === semanticError,
            'a hot native semantic refusal preserves the original rejected Error');
        assert.equal(session.decisionStats.decisionSeq, 32);
        assert.equal(session.decisionStats.activityLeaf, 0);
        assert.equal(session.decisionStats.wishDirty, Sections.sectionBit('sources'));
        assert.strictEqual(session.decisionStats.marker, marker, 'hot rejection publishes only decision fields');
        await assert.rejects(Service.reviewHot(session, hotContext), error => error === semanticError);
        assert.equal(session.decisionStats.decisionSeq, 32, 'the same accepted hot tuple raises one source event');
        assert.equal(rejections.length, beforeHotWrites, 'hot errors never persist an old cold-state snapshot');
        session.decisionStats = { ...hotStats };
        rejection = Error('economy_state_changed');
        await assert.rejects(Service.reviewHot(session, hotContext), error => error === rejection);
        assert.equal(session.decisionStats.decisionSeq, 31, 'a hot native CAS retry is not a source event');
        assert.equal(session.decisionStats.wishDirty || 0, 0);
        rejection = semanticError;
        beforeReject = () => { registration = { actor, session, retired: true }; };
        await assert.rejects(Service.reviewHot(session, hotContext), error => error === semanticError);
        assert.equal(session.decisionStats.decisionSeq, 31, 'a retired actor cannot invalidate its replacement session');
        beforeReject = null; registration = { actor, session };
        const beforeLocation = attempts;
        const away = { ...hotContext, network: { activity: { activity: 'improving', improvement: { kind: 'henna' } } } };
        assert.equal(await Service.reviewHot(session, away), null);
        assert.equal(attempts, beforeLocation, 'a missing native station waits without entering a write');
        assert.equal(session.decisionStats.decisionSeq, 31);
        console.log('test_cold_improvement_decision: ok');
    } finally {
        Economy.forState = saved.forState; Database.applyBotImprovement = saved.apply;
        Life.cachedState = saved.cached; Life.acceptLifecycleRow = saved.accept; Life.upsertState = saved.upsert; ColdCraft.craft = saved.craft; World.registeredActorById = saved.registered; World.fetchNpcsInRadius = saved.npcs;
    }
    process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
