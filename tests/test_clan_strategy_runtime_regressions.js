'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('clan-strategy-runtime');
require('../src/Global');
const Database = invoke('Database');
const Data = invoke('GameServer/DataCache');
const Combat = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Capabilities = require('../src/GameServer/Clan/ClanCandidateCapabilities');
const Simulation = require('../src/GameServer/Clan/ClanSimulationService');
const Demand = require('../src/GameServer/Clan/ClanRosterDemand');
const Policy = require('../src/GameServer/Clan/ClanStrategyPolicy');
const Strategy = require('../src/GameServer/Clan/ClanStrategyService');
const Goals = require('../src/GameServer/Clan/ClanGoalService');
const Config = require('../src/GameServer/Clan/ClanSimulationConfig');
const Events = require('../src/GameServer/Clan/ClanReviewEvents');
const Hall = require('../src/GameServer/ClanHall/Runtime');
const Gateway = invoke('GameServer/Bot/AI/OpenRouterGateway');
const Budget = invoke('GameServer/Bot/AI/BotInferenceBudget');
const query = (sql, values = []) => Database.execute([sql, values]);
const read = async clanId => JSON.parse((await query('SELECT stateJson FROM clan_simulation_clans WHERE clanId=?', [clanId]))[0].stateJson);
const traits = { commitment: 1, sociability: 0.5, assertiveness: 0.5, caution: 0.5, empathy: 0.5, ambition: 0.5, resilience: 0.5 };

async function member(id, classId, clanId, records = [], level = 50, equipment = false) {
    const inventory = equipment ? { 192: { selfId: 192, amount: 1, equipped: true, slot: 7 } } : {};
    const stats = { generatedCold: true, classId, partyHistory: { 1: { runs: 4 } },
        coldCombat: { version: Combat.PROFILE_VERSION, classId, skillSource: 'database', skills: Combat.skillSnapshotsFromRecords(records) } };
    if (equipment) stats.equipmentPlan = { status: 'active', strategy: 'direct_drop', target: { selfId: 192, slot: 7 }, expectedKills: 10 };
    await query(`INSERT INTO characters(id,username,name,classId,race,level,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ,clanId)
        VALUES(?,'bot_pop_strategy_runtime',?,?,0,?,500,300,0,0,0,0,83000,148000,-3400,?)`, [id, `Runtime${id}`, classId, level, clanId]);
    await query(`INSERT INTO bot_life_state(characterId,accountName,characterName,level,hp,maxHp,mp,maxMp,activity,phase,inventorySummary,statsJson,updatedAt)
        VALUES(?,'bot_pop_strategy_runtime',?,?,500,500,300,300,'hunting','cold',?,?,1)`, [id, `Runtime${id}`, level, JSON.stringify(inventory), JSON.stringify(stats)]);
    await query(`INSERT INTO bot_personas(characterId,seed,primaryDrive,archetype,traitsJson)
        VALUES(?,'runtime','progression','steady_achiever',?)`, [id, JSON.stringify(traits)]);
    for (const skill of records) await query('INSERT INTO skills(characterId,selfId,name,level,passive) VALUES(?,?,?,?,0)',
        [id, skill.selfId, 'Fixture learned skill', skill.level]);
}

async function clan(id, leaderId, objective, target) {
    await query('INSERT INTO clans(id,name,level,leaderId) VALUES(?,?,3,?)', [id, `RuntimeClan${id}`, leaderId]);
    const strategy = { version: 1, objective, target, label: Policy.LABELS[objective], status: 'active',
        selectedAt: Date.now(), progressAt: Date.now(), lastDecisionAt: Date.now(), reason: 'leader_preference', source: 'deterministic' };
    await query(`INSERT INTO clan_simulation_clans(clanId,mode,stateJson,createdAt,updatedAt) VALUES(?,'autonomous',?,100,100)`,
        [id, JSON.stringify({ mode: 'autonomous', leaderId, updatedAt: 100, strategy })]);
}

async function recruitment() {
    await member(101, 4, 701);
    await member(102, 2, 701);
    await member(103, 16, 701, [{ selfId: 1015, level: 1 }]);
    await member(104, 17, 701, [{ selfId: 1068, level: 1 }]);
    await member(105, 2, 0);
    await member(106, 16, 0, [{ selfId: 1015, level: 1 }]);
    await clan(701, 101, 'recruit', { roles: ['healer', 'buffer'], members: 5 });
    const projected = (await Simulation.autonomousClanProjection()).find(row => row.id === 701);
    assert(Capabilities.contextualCapability(projected.members.find(row => row.id === 103), 'healer'),
        'runtime recruitment must retain the existing healer learned kit');
    assert(Capabilities.contextualCapability(projected.members.find(row => row.id === 104), 'mainBuffer', { beneficiaries: projected.members }),
        'runtime recruitment must retain learned useful buffs');
    const candidates = await Simulation.candidateProjection(20);
    assert(Demand.intakeContext(candidates.find(row => row.characterId === 105), projected).contextualAllowed);
    const joined = await Simulation.resolveCandidate(candidates.find(row => row.characterId === 105));
    assert(joined.ok && joined.clanId === 701, 'closed support needs allow the next DPS to join through the native service');
    const full = (await Simulation.autonomousClanProjection()).find(row => row.id === 701);
    assert(Demand.intakeContext(candidates.find(row => row.characterId === 106), full).contextualAllowed,
        'a completed smaller strategic target does not stop growth to the native clan limit');

    // The next candidate in the same scan must see a just-joined support kit.
    await member(201, 4, 702, [], 60);
    await member(202, 17, 702, [{ selfId: 1068, level: 1 }], 60);
    await member(203, 2, 702, [], 60);
    await member(204, 16, 0, [{ selfId: 1015, level: 1 }], 60);
    await member(205, 2, 0, [], 60);
    await clan(702, 201, 'recruit', { roles: ['healer'], members: 5 });
    const batch = await Simulation.resolveBatch(2, { budgetMs: 5000 });
    assert.equal(batch.joined, 2, 'one batch recruits the missing healer and then the DPS');
    assert.deepEqual((await query('SELECT id FROM characters WHERE clanId=702 ORDER BY id')).map(row => row.id), [201, 202, 203, 204, 205]);
    await query("UPDATE bot_life_state SET statsJson=json_set(statsJson,'$.coldCombat.skills',json('[]')) WHERE characterId=204");
    const untrained = (await Simulation.autonomousClanProjection()).find(row => row.id === 702);
    assert(!Capabilities.contextualCapability(untrained.members.find(row => row.id === 204), 'healer'),
        'class membership alone must not grant an unlearned heal');
}

async function equipment() {
    for (const id of [301, 302, 303]) await member(id, 2, 703, [], 50, true);
    const upgrades = [301, 302, 303].map(memberId => ({ memberId, itemId: 192, slot: 7 }));
    await clan(703, 301, 'equip_roster', { upgrades });
    const owner = await Goals.clanProjectionById(703);
    const inputs = { warehouse: [{ selfId: 57, amount: 1000000000 }], halls: [], income: 0 };
    const snapshot = Policy.snapshot(owner, inputs);
    assert(!snapshot.candidates.some(candidate => candidate.objective === 'equip_roster'),
        'already equipped real Crystal Staff upgrades are absent from the next shortlist');
    const result = await Strategy.review(owner, { inputs });
    assert(result.ok);
    assert.notEqual(result.strategy.objective, 'equip_roster', 'provider outage cannot reselect the completed strategy');
    assert.equal(result.strategy.status, 'active');
    assert.equal(result.strategy.history.at(-1).status, 'completed');

    // A model answer is checked again after its generation, including fulfillment.
    for (const id of [501, 502, 503]) {
        await member(id, 2, 705);
        await query("UPDATE bot_life_state SET statsJson=json_set(statsJson,'$.equipmentPlan',json(?)) WHERE characterId=?",
            [JSON.stringify({ status: 'active', strategy: 'direct_drop', target: { selfId: 192, slot: 7 } }), id]);
    }
    await clan(705, 501, 'maintain', {});
    await query("UPDATE clan_simulation_clans SET stateJson=json_remove(stateJson,'$.strategy') WHERE clanId=705");
    const late = await Goals.clanProjectionById(705);
    const originalConfig = Gateway.config;
    Gateway.config = overrides => ({ enabled: true, provider: 'openai-compatible', model: 'runtime-test',
        apiUrl: 'http://test.invalid/v1/chat/completions', ...overrides });
    Gateway.setTransport(async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content:
        JSON.stringify({ choice: 'equip_roster', reason: 'readiness' }) } }] }) }));
    try {
        assert((await Strategy.review(late, { inputs })).pending);
        await Strategy.waitFor(705);
        const before = Policy.snapshot(late, inputs).key;
        const better = Data.items.find(item => item.etc?.rank === 's' && Number(item.etc.slot) === 7);
        assert(better, 'the fixture uses a real higher-grade weapon');
        for (const member of late.members) member.stats.equipment = [{ selfId: better.selfId, slot: 7, rank: 's' }];
        assert.equal(Policy.snapshot(late, inputs).key, before, 'fulfillment must be revalidated even if the coarse fingerprint is unchanged');
        const settled = await Strategy.review(late, { inputs });
        assert.equal(settled.strategy.status, 'active');
        assert.notEqual(settled.strategy.objective, 'equip_roster', 'completed model choices and completed fallback candidates are rejected');
    } finally { Gateway.config = originalConfig; Gateway.resetTransport(); Gateway.resetCircuit(); Budget.reset(); Strategy.reset(); }
}

async function hall() {
    await member(401, 2, 704);
    await clan(704, 401, 'treasury', { adena: 2000000000 });
    await query("INSERT INTO clan_warehouse_items(clanId,selfId,name,kind,amount,reservedAmount) VALUES(704,57,'Adena','Other.Currency',1000000000,0)");
    const originalBatch = Database.planClanHallFinanceBatch;
    const planned = [];
    Database.planClanHallFinanceBatch = (ids, options = {}) => originalBatch.call(Database, ids, { ...options,
        before: id => { planned.push(id); options.before?.(id); } });
    const published = [];
    let unsubscribe = null;
    try {
        const world = invoke('GameServer/World/World');
        world.npc ||= { nextId: 1000000, spawns: [], grid: {} };
        world.user ||= { sessions: [] };
        await Hall.start();
        for (let pass = 0; pass < 8; pass++) await Hall.tick();
        assert(planned.includes(704), 'the treasury strategy already consumed its startup finance event');
        assert.equal((await Database.fetchClanHallFinance(704)).bid, null);
        await Events.drain(); planned.length = 0;
        unsubscribe = Events.subscribe((clanId, cause) => published.push({ clanId, cause }));
        const owner = await Goals.clanProjectionById(704);
        const chosen = { ...owner.state.strategy, objective: 'clan_hall', label: Policy.LABELS.clan_hall,
            target: { hallId: 31, adena: 20000000 }, leaderKey: Policy.hash(Policy.leader(owner)), selectedAt: Date.now(),
            progress: 0, required: 1, percent: 0, unit: 'milestone' };
        let saved = await Database.updateAutonomousClanStrategy({ clanId: 704, leaderId: 401,
            expectedUpdatedAt: owner.state.updatedAt, strategy: chosen, eventType: 'strategy_selected' });
        assert(saved.ok);
        const waiting = await Goals.resolveClan(await Goals.clanProjectionById(704), { inputs: {
            warehouse: await Database.fetchClanWarehouseItems(704), halls: await Database.fetchClanHallAuctions(), income: 0 } });
        assert(waiting.ok);
        assert.equal(published.filter(event => event.clanId === 704 && event.cause === 'strategy').length, 1,
            'a committed strategic change wakes finance exactly once; progress and waiting-goal writes do not repeat it');
        await Hall.tick();
        assert(planned.includes(704), 'the next native finance tick executes the new hall objective');
        assert.equal((await Database.fetchClanHallFinance(704)).bid.hallId, 31, 'sufficient funds place the selected hall bid without another treasury event');
        published.length = 0;
        const current = await read(704);
        saved = await Database.updateAutonomousClanStrategy({ clanId: 704, leaderId: 401, expectedUpdatedAt: current.updatedAt,
            strategy: { ...current.strategy, progress: 0.5, percent: 50 } });
        assert(saved.ok);
        assert.deepEqual(published, [], 'ordinary progress does not create an event loop');
        const rejected = await Database.updateAutonomousClanStrategy({ clanId: 704, leaderId: 401, expectedUpdatedAt: 100,
            strategy: { ...current.strategy, objective: 'treasury', selectedAt: chosen.selectedAt + 1 } });
        assert.equal(rejected.code, 'ownership_conflict');
        assert.deepEqual(published, [], 'failed CAS cannot publish a strategy event');
    } finally { unsubscribe?.(); Hall.stop(); Database.planClanHallFinanceBatch = originalBatch; }
}

async function main() {
    Data.init(); Database.init();
    const oldShare = Config.maxBotMemberShare;
    Config.maxBotMemberShare = 1;
    try {
        await Database.initClanHalls();
        await query("INSERT INTO accounts(username,password) VALUES('bot_pop_strategy_runtime','fixture')");
        const groups = { recruitment, equipment, hall };
        const selected = process.argv[2];
        for (const [name, run] of Object.entries(groups)) if (!selected || name === selected) {
            await run(); console.log(`PASS clan strategy runtime regression: ${name}`);
        }
    } finally {
        Config.maxBotMemberShare = oldShare; Hall.stop(); Strategy.reset();
        await Database.close(); fs.rmSync(isolated.directory, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
