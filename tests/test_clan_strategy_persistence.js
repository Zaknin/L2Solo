'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
require('./helpers/databaseIsolation');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clan-strategy-'));
process.env.L2NODE_CONFIG_FILE = path.join(directory, 'config.ini');
delete process.env.L2NODE_SHARED_CONFIG_FILE;
fs.writeFileSync(process.env.L2NODE_CONFIG_FILE, `[Database]\npath=${directory}/world.sqlite\nhistoryPath=${directory}/history.sqlite\n`);
require('../src/Global');
const Database = invoke('Database');
const Policy = require('../src/GameServer/Clan/ClanStrategyPolicy');
const Economy = require('../src/GameServer/Clan/ClanEconomyContext');
const Goals = require('../src/GameServer/Clan/ClanGoalService');
const Observer = invoke('WorldObserver/WorldObserverServer');
const query = (sql, values = []) => Database.execute([sql, values]);
const read = async () => JSON.parse((await query('SELECT stateJson FROM clan_simulation_clans WHERE clanId=77'))[0].stateJson);
const strategy = { version: 1, objective: 'treasury', label: Policy.LABELS.treasury, target: { adena: 1000000 },
    source: 'llm', reason: 'leader_preference', status: 'active', progress: 10000, required: 1000000, percent: 1,
    selectedAt: Date.now(), progressAt: Date.now(), lastDecisionAt: Date.now(), inputKey: 'fixture',
    history: [], inference: { requests: 1, promptTokens: 700, completionTokens: 25 } };

async function main() {
    Database.init();
    try {
        await Database.initClanHalls();
        await query("INSERT INTO accounts(username,password) VALUES('bot_pop_strategy','fixture')");
        for (const id of [1, 2]) await query(`INSERT INTO characters(id,username,name,classId,race,level,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ,clanId)
            VALUES (?,'bot_pop_strategy',?,1,0,40,500,300,0,0,0,0,0,0,0,77)`, [id, `Strategy${id}`]);
        await query("INSERT INTO clans(id,name,level,leaderId) VALUES(77,'StrategyClan',2,1)");
        const state = { mode: 'autonomous', updatedAt: 100, memberIds: [1, 2], goal: { type: 'item', status: 'executing' },
            productionGoal: { type: 'equipment', status: 'executing' }, recruitmentDemand: { ownerSection: 'productionGoal' } };
        await query(`INSERT INTO clan_simulation_clans(clanId,mode,stateJson,createdAt,updatedAt) VALUES(77,'autonomous',?,100,100)`, [JSON.stringify(state)]);
        let saved = await Database.updateAutonomousClanStrategy({ clanId: 77, leaderId: 1, expectedUpdatedAt: 100, strategy, eventType: 'strategy_selected' });
        assert(saved.ok);
        let current = await read();
        assert.deepEqual(current.strategy, strategy);
        assert.equal(current.goal, null); assert.equal(current.productionGoal, null);
        assert.equal(current.recruitmentDemand, null);
        assert.equal((await Database.updateAutonomousClanStrategy({ clanId: 77, leaderId: 1, expectedUpdatedAt: 100, strategy })).code, 'ownership_conflict');
        assert.equal((await Database.updateAutonomousClanStrategy({ clanId: 77, leaderId: 2, expectedUpdatedAt: current.updatedAt, strategy })).code, 'strategy_owner_changed');
        const clan = { id: 77, level: 2, leaderId: 1, state: current, members: [] };
        const treasury = Economy.build(clan, { warehouse: [{ selfId: 57, amount: 5000000 }],
            halls: [{ ...require('../src/GameServer/ClanHall/Policy').catalog.halls[0], ownerId: 0 }], memberContexts: [] });
        assert.equal(treasury.budgetFor('equipment', 347), 0);
        assert.equal(treasury.hall, null);
        assert.equal(treasury.network.queue.length, 0);
        assert.equal((await Database.payClanMember({ clanId: 77, characterId: 1, amount: 1, kind: 'clan_equipment' })).code, 'clan_strategy_reserve');
        assert.equal((await require('../src/GameServer/Clan/ClanEconomyService').resolveClan(clan)).reason, 'strategy_focus');

        const finished = { type: 'equipment', status: 'completed', goalKey: 'clan-equipment:77:1:383:11',
            target: { memberId: 1, itemId: 383, slot: 11 } };
        for (let i = 0; i < 2; i++) await Database.recordClanGoalEvent({ clanId: 77,
            eventType: 'equipment_goal_completed', goalType: 'equipment', payload: finished });
        assert.deepEqual(await Database.fetchClanEquipmentAchievements(77), { upgrades: 1, recent: ['1:383:11'] },
            'history restores completed upgrades exactly once before the persistent counter exists');

        // The normal goal pipeline publishes the strategic waiting goal and its progress.
        const Service = require('../src/GameServer/Clan/ClanStrategyService');
        const originalInputs = Service.inputsFor;
        const Gateway = invoke('GameServer/Bot/AI/OpenRouterGateway');
        const oldConfig = Gateway.config;
        Gateway.config = () => ({ enabled: false });
        const input = { warehouse: [{ selfId: 57, amount: 10000 }], halls: [], income: 0 };
        const snap = Policy.snapshot(clan, input);
        const stable = { ...strategy, inputKey: snap.key, leaderKey: snap.leaderKey, retryAt: Date.now() + 60000 };
        saved = await Database.updateAutonomousClanStrategy({ clanId: 77, leaderId: 1, expectedUpdatedAt: current.updatedAt, strategy: stable });
        clan.state = saved.state;
        try {
            const goal = await Goals.resolveClan(clan, { inputs: input });
            assert(goal.ok); assert.equal(goal.goal.type, 'strategy');
            current = await read();
            const overview = Observer.compactClanOverview({ id: 77, level: 2, stateJson: JSON.stringify(current), simulationVersion: 1 });
            assert.equal(overview.strategy.percent, 1);
            assert.equal(overview.strategy.inference.promptTokens, 700);
            assert.equal(overview.strategy.achievements.upgrades, 1, 'Observer uses the durable restored counter');
            assert.equal(overview.goal.plan.label, 'Build the treasury');
        } finally { Service.inputsFor = originalInputs; Gateway.config = oldConfig; }
        current = await read();
        current.goal = { controlledBy: 'player', status: 'executing' };
        await query('UPDATE clan_simulation_clans SET stateJson=? WHERE clanId=77', [JSON.stringify(current)]);
        assert.equal((await Database.updateAutonomousClanStrategy({ clanId: 77, leaderId: 1, expectedUpdatedAt: current.updatedAt,
            strategy: { ...strategy, objective: 'maintain' } })).code, 'player_order_active');
        console.log('Clan strategy durable state, CAS, player authority, treasury funding and Observer integration checks passed');
    } finally { await Database.close(); fs.rmSync(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
