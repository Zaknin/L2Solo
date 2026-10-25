'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
const Policy = require('../src/GameServer/Clan/ClanStrategyPolicy');
const Service = require('../src/GameServer/Clan/ClanStrategyService');
const Capabilities = require('../src/GameServer/Clan/ClanCandidateCapabilities');
const Equipment = invoke('GameServer/Clan/ClanEquipmentService');
const Gateway = invoke('GameServer/Bot/AI/OpenRouterGateway');
const Budget = invoke('GameServer/Bot/AI/BotInferenceBudget');
const Database = invoke('Database');
const Observer = invoke('WorldObserver/WorldObserverServer');
const saved = { config: Gateway.config, save: Database.updateAutonomousClanStrategy,
    achievements: Database.fetchClanEquipmentAchievements,
    capability: Capabilities.contextualCapability, raid: Equipment.activeRaidPartyForClan, committed: Equipment.raidAssemblyCommitted };
const now = 1000000;
const persona = (drive, traits = {}) => ({ primaryDrive: drive, traits: { ambition: 0.5, caution: 0.5,
    empathy: 0.5, sociability: 0.5, commitment: 0.5, assertiveness: 0.5, resilience: 0.5, ...traits } });
function fixture() {
    const members = [4, 16, 17].map((classId, at) => ({ characterId: at + 1, classId, level: 55,
        phase: 'cold', inventory: {}, stats: {}, persona: persona('progression'), capabilities: [['tank'], ['healer'], ['mainBuffer']][at] }));
    return { id: 77, level: 3, leaderId: 1, members, state: { mode: 'autonomous', updatedAt: 100 } };
}
const plan = (itemId, raid = false) => ({ status: 'active', strategy: 'direct_drop', target: { selfId: itemId, slot: 7 },
    expectedKills: 20, next: { raidBoss: raid, spotId: raid ? 'raid:12001' : 'fixture' } });
function inputs() { return { warehouse: [{ selfId: 57, amount: 10000 }], halls: [], income: 10000,
    plans: new Map([[1, plan(1001)], [2, plan(1002, true)]]) }; }
let calls = 0, wanted = 'treasury', release = null, fail = false, invalid = false;
async function main() {
    try {
        Database.fetchClanEquipmentAchievements = async () => ({ upgrades: 0, recent: [] });
        Capabilities.contextualCapability = (member, kind) => member.capabilities?.includes(kind) === true;
        Equipment.activeRaidPartyForClan = () => null;
        Equipment.raidAssemblyCommitted = () => false;
        Gateway.config = overrides => ({ enabled: true, provider: 'openai-compatible', model: 'strategy-test',
            apiUrl: 'http://test.invalid/v1/chat/completions', ...overrides });
        Database.updateAutonomousClanStrategy = async ({ expectedUpdatedAt, strategy }) => {
            assert.equal(expectedUpdatedAt, clan.state.updatedAt);
            return { ok: true, state: { ...clan.state, updatedAt: clan.state.updatedAt + 1, strategy } };
        };
        Gateway.setTransport(async (_url, init) => {
            calls++;
            const body = JSON.parse(init.body), payload = JSON.parse(body.messages[1].content);
            assert.equal(body.max_tokens || body.max_completion_tokens, 128);
            assert(body.messages[0].content.includes('commitment'));
            assert.equal(payload.leader.traits.caution, Math.round(clan.members[0].persona.traits.caution * 10));
            assert(!JSON.stringify(payload).includes('inventory'));
            assert(Math.ceil(JSON.stringify({ messages: body.messages, responseSchema: Service.schema(Policy.snapshot(clan, input).candidates) }).length / 4)
                <= Service.MAX_PROMPT_TOKENS);
            if (release) await release.promise;
            if (fail) return { ok: false, status: 503, json: async () => ({ error: 'offline' }) };
            const choice = invalid ? 'invented_objective' : payload.options.some(option => option.id === wanted) ? wanted : payload.options[0].id;
            return { ok: true, status: 200, json: async () => ({ choices: [{ message: {
                content: JSON.stringify({ choice, reason: 'leader_preference' }) } }], usage: { prompt_tokens: 600, completion_tokens: 20 } }) };
        });
        let clan = fixture(), input = inputs();
        // The saved callback and transport see the same current projection.
        const wealthy = Policy.snapshot({ ...clan, members: clan.members.map(member => ({ ...member,
            persona: persona('wealth', { caution: 1, ambition: 0, empathy: 0, sociability: 0 }) })) }, input);
        const ambitious = Policy.snapshot({ ...clan, members: clan.members.map(member => ({ ...member,
            persona: persona('progression', { caution: 0, ambition: 1, empathy: 0, sociability: 0 }) })) }, input);
        assert.equal(Policy.fallback(wealthy).objective, 'treasury');
        assert.notEqual(Policy.fallback(ambitious).objective, 'treasury');
        assert(wealthy.candidates.some(row => row.objective === 'raid_preparation'));
        const allBusy = { ...clan, members: clan.members.map(member => ({ ...member, partyId: 'busy' })) };
        assert.deepEqual(Policy.snapshot(allBusy, input).candidates.find(row => row.objective === 'recruit').target.roles, [],
            'busy owned support is not a missing roster capability');
        assert.equal(Policy.snapshot(allBusy, input).candidates.find(row => row.objective === 'recruit').target.members, 30,
            'strategic recruitment aims for full clan capacity');
        const trial = { ...clan, members: [...clan.members, { ...clan.members[0], characterId: 4 }].map(member => ({ ...member, level: 60 })),
            state: { ...clan.state, goal: { plan: { kind: 'alliance_trial' }, progress: 15, required: 30 } } };
        const trialStrategy = { objective: 'advance_clan', target: { level: 4 } };
        assert.equal(Policy.progress(trialStrategy, trial, input).percent, 47);
        assert.equal(Policy.progress(trialStrategy, { ...trial, members: trial.members.slice(0, 3) }, input).status, 'blocked');

        assert((await Service.review(clan, { inputs: input, now })).pending);
        await Service.waitFor(clan.id);
        assert((await Service.review(clan, { inputs: input, now: now + 1 })).ok);
        assert.equal(clan.state.strategy.objective, 'treasury');
        assert.equal(clan.state.strategy.source, 'llm');
        assert.equal(clan.state.strategy.inference.promptTokens, 600);
        assert(!Policy.spendingAllowed(clan, 'equipment'));
        assert(!Policy.spendingAllowed(clan, 'hall'));
        for (let i = 0; i < 100; i++) {
            clan.state.updatedAt++; clan.members[0].simulationRevision = i;
            input.warehouse[0].amount++;
            await Service.review(clan, { inputs: input, now: now + 1000 + i });
        }
        Service.reset(); // The durable choice, not an in-memory cache, suppresses calls after restart.
        await Service.review(clan, { inputs: input, now: now + 60000 });
        assert.equal(calls, 1);
        const steady = { ...clan.state.strategy, selectedAt: now, progressAt: now, lastStallReviewAt: now,
            inputKey: Policy.snapshot(clan, input).key };
        const steadySnapshot = Policy.snapshot(clan, input), steadyProgress = Policy.progress(steady, clan, input);
        const stallMs = require('../src/GameServer/Clan/ClanSimulationConfig').strategyStallMs;
        assert(!Policy.shouldReview(steady, steadySnapshot, steadyProgress, now + stallMs - 1));
        assert(Policy.shouldReview(steady, steadySnapshot, steadyProgress, now + stallMs));
        assert(!Policy.shouldReview({ ...steady, lastStallReviewAt: now + stallMs }, steadySnapshot, steadyProgress, now + stallMs + 1));
        const progress = Observer.compactClanStrategy(clan.state.strategy);
        assert.equal(progress.label, 'Build the treasury');
        assert(progress.percent > 0 && progress.percent < 100);
        assert.equal(progress.inference.requests, 1);
        assert(!Object.hasOwn(progress, 'leaderKey'));

        // Completion can select a new objective before the minimum hold expires.
        wanted = 'equip_roster'; input.warehouse[0].amount = clan.state.strategy.target.adena;
        assert((await Service.review(clan, { inputs: input, now: now + 61000 })).pending);
        await Service.waitFor(clan.id);
        await Service.review(clan, { inputs: input, now: now + 61001 });
        assert.equal(clan.state.strategy.objective, 'equip_roster');
        const selected = Policy.selection(clan, input.plans, { member: clan.members[2] });
        assert.equal(selected.member.characterId, clan.state.strategy.target.upgrades[0].memberId);
        assert(Policy.spendingAllowed(clan, 'equipment'));
        assert(!Policy.spendingAllowed(clan, 'level'));
        const first = clan.state.strategy.target.upgrades[0];
        clan.members.find(member => member.characterId === first.memberId).inventory[first.itemId] = { selfId: first.itemId, equipped: true, slot: 7 };
        assert.equal(Policy.progress(clan.state.strategy, clan, input).progress, 1);

        const chosenAt = clan.state.strategy.selectedAt, requestCount = calls;
        const repriced = structuredClone(clan.state.strategy);
        for (const target of repriced.target.upgrades) Object.assign(target, { cost: 999999, effort: 777, sourceId: 'new-route' });
        assert.equal(Policy.targetKey(repriced), Policy.targetKey(clan.state.strategy), 'route economics do not define a new objective');
        await Service.review(clan, { inputs: input, now: now + 31 * 60000 });
        assert.equal(clan.state.strategy.selectedAt, chosenAt);
        assert.equal(calls, requestCount, 'a changed roster after the minimum hold cannot discard useful work');
        assert.equal(clan.state.strategy.achievements.upgrades, 1);
        Service.reset();
        await Service.review(clan, { inputs: input, now: now + 31 * 60000 + 1 });
        assert.equal(clan.state.strategy.achievements.upgrades, 1, 'restart and repeated reviews cannot count the same upgrade twice');
        await Service.block(clan, now + 31 * 60000 + 2);
        assert.equal(clan.state.strategy.status, 'active', 'one missing tactical route does not block or replace the strategy');
        await Service.review(clan, { inputs: input, now: now + 31 * 60000 + 100 });
        assert.equal(calls, requestCount);
        for (const target of clan.state.strategy.target.upgrades)
            clan.members.find(member => member.characterId === target.memberId).inventory[target.itemId] = {
                selfId: target.itemId, amount: 1, equipped: true, slot: target.slot };
        await Service.review(clan, { inputs: input, now: now + 31 * 60000 + 101 });
        await Service.waitFor(clan.id);
        await Service.review(clan, { inputs: input, now: now + 31 * 60000 + 102 });
        assert.notEqual(clan.state.strategy.objective, 'equip_roster');
        assert.equal(Observer.compactClanStrategy(clan.state.strategy).achievements.upgrades, 2,
            'cumulative Observer progress survives completion and selection of another objective');

        // One request at a time; a stale leader response becomes a fresh fallback.
        Service.reset(); Budget.reset(); Gateway.resetCircuit(); calls = 0; clan = fixture(); input = inputs();
        release = {}; release.promise = new Promise(resolve => { release.resolve = resolve; });
        await Service.review(clan, { inputs: input, now });
        clan.leaderId = 2;
        for (let i = 0; i < 5; i++) assert((await Service.review(clan, { inputs: input, now: now + 1 })).pending);
        assert.equal(calls, 1);
        release.resolve(); await Service.waitFor(clan.id); release = null;
        await Service.review(clan, { inputs: input, now: now + 2 });
        assert.equal(clan.state.strategy.source, 'deterministic');
        assert.equal(clan.state.strategy.failure, 'strategy_inputs_changed');
        assert(clan.state.strategy.retryAt > now);
        await Service.review(clan, { inputs: input, now: now + 100 });
        assert.equal(calls, 1);
        clan.state.goal = { controlledBy: 'player', status: 'executing' };
        assert.equal((await Service.review(clan, { inputs: input, now: now + 200 })).managed, false);

        // Provider failures settle their budget and persist a retry backoff.
        Service.reset(); Budget.reset(); Gateway.resetCircuit(); clan = fixture(); input = inputs(); fail = true;
        await Service.review(clan, { inputs: input, now }); await Service.waitFor(clan.id);
        await Service.review(clan, { inputs: input, now: now + 1 });
        assert.equal(clan.state.strategy.source, 'deterministic');
        assert(clan.state.strategy.lastDecisionFailed);
        assert.equal(Budget.globalStatus().inFlight, 0);
        assert.equal(Policy.shouldReview(clan.state.strategy, Policy.snapshot(clan, input), Policy.progress(clan.state.strategy, clan, input), now + 10), false);
        Service.reset(); Budget.reset(); Gateway.resetCircuit(); clan = fixture(); input = inputs(); fail = false; invalid = true; calls = 0;
        await Service.review(clan, { inputs: input, now }); await Service.waitFor(clan.id);
        await Service.review(clan, { inputs: input, now: now + 1 });
        assert.equal(calls, 1, 'invalid JSON/schema never triggers the generic 2048-token rescue');
        assert.equal(clan.state.strategy.source, 'deterministic');
        console.log('Clan strategy personality, progress, authority, compact prompts, restart reuse, single-flight and fallback checks passed');
    } finally {
        Gateway.config = saved.config; Database.updateAutonomousClanStrategy = saved.save;
        Database.fetchClanEquipmentAchievements = saved.achievements;
        Capabilities.contextualCapability = saved.capability; Equipment.activeRaidPartyForClan = saved.raid;
        Equipment.raidAssemblyCommitted = saved.committed;
        Gateway.resetTransport(); Gateway.resetCircuit(); Budget.reset(); Service.reset();
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
