'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('clan-strategy-offline');
require('../src/Global');
const Data = invoke('GameServer/DataCache'), Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Gear = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Spots = invoke('GameServer/Bot/Population/SpotProfiles');
const Gateway = invoke('GameServer/Bot/AI/OpenRouterGateway');
const Budget = invoke('GameServer/Bot/AI/BotInferenceBudget');
const Goals = require('../src/GameServer/Clan/ClanGoalService');
const Strategy = require('../src/GameServer/Clan/ClanStrategyService');
const Policy = require('../src/GameServer/Clan/ClanStrategyPolicy');
const Config = require('../src/GameServer/Clan/ClanSimulationConfig');
const Candidates = require('../src/GameServer/Clan/ClanGoalCandidateService');
const Coordinator = require('../src/GameServer/Clan/ClanPlanningCoordinator');
const original = { gateway: Gateway.config, gear: Gear.planFor, spots: Spots.ensure, worker: Coordinator.enabled,
    llm: Config.llmGoalManagementEnabled, strategic: Config.strategicManagementEnabled };
const q = (sql, values = []) => Database.execute([sql, values]);
const fresh = () => Goals.clanProjectionById(771);
const valid = { enabled: true, provider: 'openai-compatible', apiUrl: 'http://test.invalid/v1/chat/completions', model: 'offline-fixture' };
const traits = { empathy: 1, ambition: 0, caution: 0, sociability: 0, commitment: 1, resilience: 1, assertiveness: 0.5 };
let configuration = { ...valid, enabled: false }, calls = 0, unblock = null;

async function reset(strategy = null) {
    Strategy.reset(); Candidates.reset();
    await q('UPDATE clan_simulation_clans SET stateJson=?,updatedAt=100 WHERE clanId=771',
        [JSON.stringify({ mode: 'autonomous', updatedAt: 100, goal: null, strategy })]);
}

async function main() {
    Data.init(); await Database.init(); await Database.initClanHalls();
    try {
        Config.llmGoalManagementEnabled = true; Config.strategicManagementEnabled = true;
        Gateway.config = overrides => ({ ...configuration, ...overrides });
        Gateway.setTransport(async () => { calls++; throw Error('Offline planning must not call inference'); });
        Coordinator.enabled = () => false;
        Spots.ensure = () => [];
        Gear.planFor = state => state.inventory?.[192]?.equipped ? { status: 'complete' }
            : { status: 'active', grade: 'c', strategy: 'direct_drop', partyNeed: 'solo_ok', requiresParty: false,
                expectedKills: 10, target: { selfId: 192, name: 'Crystal Staff', slot: 7 },
                next: { spotId: 'fixture', npcId: 1234, itemId: 192 } };
        await q("INSERT INTO accounts(username,password) VALUES('bot_pop_offline_strategy','fixture')");
        await q("INSERT INTO clans(id,name,level,leaderId) VALUES(771,'OfflineStrategy',4,4810001)");
        await q("INSERT INTO clan_simulation_clans(clanId,mode,stateJson,createdAt,updatedAt) VALUES(771,'autonomous','{}',100,100)");
        for (let index = 0; index < 5; index++) {
            const id = 4810001 + index, classId = [4, 15, 21, 43, 11][index];
            await q(`INSERT INTO characters(id,username,name,classId,race,level,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ,clanId)
                VALUES(?,'bot_pop_offline_strategy',?,?,0,55,500,250,0,0,0,0,83400,148600,-3400,771)`, [id, `Offline${index}`, classId]);
            await q(`INSERT INTO bot_life_state(characterId,accountName,characterName,level,adena,activity,phase,inventorySummary,statsJson,updatedAt)
                VALUES(?,'bot_pop_offline_strategy',?,55,100000,'hunting','cold',?,?,1)`, [id, `Offline${index}`,
                JSON.stringify({ 57: { selfId: 57, amount: 100000 } }), JSON.stringify({ generatedCold: true, classId, clanId: 771 })]);
            await q('INSERT INTO bot_personas(characterId,seed,primaryDrive,archetype,traitsJson) VALUES(?,\'offline\',\'progression\',\'steady_achiever\',?)',
                [id, JSON.stringify(traits)]);
        }
        await Life.init();

        for (const [name, cfg, llm, strategic] of [
            ['AI disabled', { ...valid, enabled: false }, true, true],
            ['endpoint missing', { ...valid, apiUrl: '' }, true, true],
            ['model missing', { ...valid, model: '' }, true, true],
            ['OpenRouter key missing', { ...valid, provider: 'openrouter', apiKey: '' }, true, true],
            ['clan LLM disabled', valid, false, true],
            ['strategic layer disabled', { ...valid, enabled: false }, true, false]
        ]) {
            configuration = cfg; Config.llmGoalManagementEnabled = llm; Config.strategicManagementEnabled = strategic;
            await reset();
            const first = await Goals.resolveClan(await fresh());
            assert(first.ok && !first.pending, name);
            assert.equal(first.goal?.type, 'equipment', `${name}: legacy equipment planning still executes`);
            assert.equal((await fresh()).state.strategy, null, `${name}: no strategic state is required`);
            assert.equal(calls, 0, `${name}: no transport calls`);
            console.log(`PASS offline legacy lifecycle: ${name}`);
        }

        Config.llmGoalManagementEnabled = true; Config.strategicManagementEnabled = true;
        configuration = { ...valid, enabled: false }; await reset();
        const first = await Goals.resolveClan(await fresh());
        await Database.setItem(first.goal.target.memberId, { selfId: 192, name: 'Crystal Staff', amount: 1, equipped: true, slot: 7 });
        const equipped = await Life.refreshInventory(await Life.findByCharacterId(first.goal.target.memberId), { equip: true });
        await Life.upsertState(equipped, 'offline_equipment_progress');
        const second = await Goals.resolveClan(await fresh());
        assert(second.ok && !second.pending && second.goal?.type === 'equipment');
        assert.notEqual(second.goal.target.memberId, first.goal.target.memberId, 'without AI, a completed upgrade advances to the next member');
        console.log('PASS offline native equipment completion and rotation');

        const timestamp = Date.now();
        await q(`UPDATE bot_life_state SET statsJson=json_remove(statsJson,'$.equipmentPlan'),
            mindJson=json_remove(COALESCE(mindJson,'{}'),'$.equipmentPlan') WHERE characterId BETWEEN 4810001 AND 4810005`);
        await reset({ version: 1, objective: 'treasury', target: { adena: 0 }, status: 'active', source: 'llm',
            label: Policy.LABELS.treasury, selectedAt: timestamp, progressAt: timestamp,
            achievements: { upgrades: 2, recent: [] }, inference: { requests: 3, promptTokens: 1000, completionTokens: 30 } });
        const next = await Goals.resolveClan(await fresh());
        assert(next.ok && !next.pending);
        const projected = await fresh();
        assert.equal(projected.state.strategy.objective, 'equip_roster', 'offline strategy rotation discovers fresh native equipment plans');
        assert.equal(projected.state.strategy.source, 'deterministic');
        assert.equal(projected.state.strategy.achievements.upgrades, 2, 'disabling inference preserves earned progress');
        assert.equal(projected.state.strategy.inference.requests, 3, 'offline fallback does not invent inference requests');
        assert.equal(next.goal?.type, 'equipment', 'the offline strategic choice executes through the native lifecycle');
        console.log('PASS saved LLM strategy continues and replans without AI');

        await reset(projected.state.strategy);
        await q("UPDATE clan_simulation_clans SET stateJson=json_set(stateJson,'$.goal',json(?)) WHERE clanId=771",
            [JSON.stringify(Strategy.waitingGoal(projected.state.strategy))]);
        Config.strategicManagementEnabled = false;
        const legacy = await Goals.resolveClan(await fresh());
        assert(legacy.ok && !legacy.pending && legacy.goal?.type === 'equipment',
            'disabling the strategic layer removes its waiting goal and restores native planning');
        for (const kind of ['equipment', 'level', 'hall']) assert(Policy.spendingAllowed(await fresh(), kind),
            'disabled strategic state cannot reserve native spending');
        assert.equal(calls, 0);
        Config.strategicManagementEnabled = true;
        console.log('PASS disabling an already-persisted strategic layer');

        // Explicit disablement retires pending advice immediately, while the
        // already-started request still settles its original budget normally.
        await reset(); configuration = valid;
        const released = new Promise(resolve => { unblock = resolve; });
        Gateway.setTransport(async () => {
            calls++; await released;
            return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content:
                JSON.stringify({ choice: 'treasury', reason: 'recovery' }) } }] }) };
        });
        assert((await Strategy.review(await fresh())).pending);
        const running = Strategy.waitFor(771);
        configuration = { ...valid, enabled: false };
        assert.equal((await Strategy.review(await fresh())).managed, false);
        const detached = await Promise.race([Strategy.waitFor(771), new Promise(resolve => setTimeout(() => resolve('still-pending'), 50))]);
        assert.equal(detached, null, 'disabled inference cannot leave the clan waiting for an old request');
        assert.equal((await fresh()).state.strategy, null, 'disabling inference cannot adopt pending advice');
        configuration = valid;
        const resumed = await Strategy.review(await fresh());
        assert(resumed.ok && !resumed.pending, 'reconnection can continue natively while the retired request settles');
        assert.equal(resumed.strategy.source, 'deterministic');
        assert.equal(calls, 1, 'reconnecting cannot overlap another request for the same clan');
        const nativeChoice = resumed.strategy.objective;
        unblock(); unblock = null; await running;
        assert.equal(Budget.globalStatus().inFlight, 0);
        assert.equal((await fresh()).state.strategy.objective, nativeChoice, 'late model output cannot replace the native choice');
        console.log('PASS disabling inference during an in-flight request');
    } finally {
        unblock?.(); Gateway.config = original.gateway; Gear.planFor = original.gear; Spots.ensure = original.spots;
        Coordinator.enabled = original.worker; Config.llmGoalManagementEnabled = original.llm;
        Config.strategicManagementEnabled = original.strategic;
        Gateway.resetTransport(); Gateway.resetCircuit(); Budget.reset(); Strategy.reset(); Candidates.reset();
        await Database.close(); fs.rmSync(isolated.directory, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
