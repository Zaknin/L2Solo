'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const isolated = require('./helpers/isolatedSocialDatabase')('clan-strategy-native');
require('../src/Global');
const Data = invoke('GameServer/DataCache');
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Gear = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Spots = invoke('GameServer/Bot/Population/SpotProfiles');
const Goals = invoke('GameServer/Clan/ClanGoalService');
const Strategy = require('../src/GameServer/Clan/ClanStrategyService');
const Actions = require('../src/GameServer/Clan/ClanActionService');
const Brain = require('../src/GameServer/Clan/ClanBrain');
const Gateway = invoke('GameServer/Bot/AI/OpenRouterGateway');
const Budget = invoke('GameServer/Bot/AI/BotInferenceBudget');
const Coordinator = require('../src/GameServer/Clan/ClanPlanningCoordinator');
const original = { plan: Gear.planFor, spots: Spots.ensure, configured: Gateway.config, choose: Brain.choose, worker: Coordinator.enabled };
const q = (sql, values = []) => Database.execute([sql, values]);
let calls = 0;
async function main() {
    Data.init(); Database.init(); await Database.initClanHalls();
    try {
        await q("INSERT INTO accounts(username,password) VALUES('bot_pop_strategy_native','fixture')");
        for (let index = 0; index < 5; index++) {
            const id = 4800001 + index, classId = [4, 15, 21, 43, 11][index];
            await q(`INSERT INTO characters(id,username,name,classId,race,level,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ)
                VALUES(?,'bot_pop_strategy_native',?,?,0,35,500,250,0,0,0,0,83400,148600,-3400)`, [id, `Strategy${index}`, classId]);
            await q(`INSERT INTO bot_life_state(characterId,accountName,characterName,level,adena,activity,phase,inventorySummary,statsJson,updatedAt)
                VALUES(?,'bot_pop_strategy_native',?,35,100000,'hunting','cold',?,?,1)`, [id, `Strategy${index}`,
                JSON.stringify({ 57: { selfId: 57, amount: 100000 } }), JSON.stringify({ generatedCold: true, classId })]);
        }
        await Life.init();
        Coordinator.enabled = () => false;
        Gear.planFor = state => state.inventory?.[state.characterId + 9100]?.equipped ? { status: 'complete' }
            : { status: 'active', grade: 'd', strategy: 'direct_drop', partyNeed: 'solo_ok', requiresParty: false,
                expectedKills: 10, target: { selfId: state.characterId + 9100, name: 'Fixture blade', slot: 7 },
                next: { spotId: 'fixture', npcId: 1234, itemId: state.characterId + 9100 } };
        Spots.ensure = () => [];
        Gateway.config = overrides => ({ enabled: true, provider: 'openai-compatible', apiUrl: 'http://test.invalid/v1/chat/completions',
            model: 'strategy-test', ...overrides });
        Gateway.setTransport(async (_url, init) => {
            calls++;
            const body = JSON.parse(init.body);
            assert.equal(body.response_format.json_schema.name, 'clan_strategy');
            assert(JSON.parse(body.messages[1].content).options.some(row => row.id === 'equip_roster'));
            return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content:
                JSON.stringify({ choice: 'equip_roster', reason: 'member_welfare' }) } }], usage: { prompt_tokens: 850, completion_tokens: 20 } }) };
        });
        Brain.choose = () => { throw Error('Strategic equipment must not make a second per-item model choice'); };
        const created = await Database.createAutonomousClan({ name: 'StrategyNative', leaderId: 4800001,
            memberIds: [4800001,4800002,4800003,4800004,4800005], founderQuorum: 5, maxBotClans: 40,
            maxBotMemberShare: 1, stateJson: { goal: null } });
        assert(created.ok); await q('UPDATE clans SET level=3 WHERE id=?', [created.clanId]);
        const fresh = () => Goals.clanProjectionById(created.clanId);
        assert((await Goals.resolveClan(await fresh())).pending);
        await Strategy.waitFor(created.clanId);
        const first = await Goals.resolveClan(await fresh());
        assert(first.ok); assert.equal(first.goal.type, 'equipment');
        let clan = await fresh();
        assert.equal(clan.state.strategy.source, 'llm');
        const targets = clan.state.strategy.target.upgrades;
        assert(targets.some(target => target.memberId === first.goal.target.memberId));
        assert.equal(calls, 1);
        await Database.setItem(first.goal.target.memberId, { selfId: first.goal.target.itemId, name: 'Fixture blade', amount: 1,
            equipped: true, slot: 7 });
        const member = await Life.findByCharacterId(first.goal.target.memberId);
        const equipped = await Life.refreshInventory(member, { equip: true });
        await Life.upsertState(equipped, 'strategy_native_test');
        const second = await Goals.resolveClan(await fresh());
        assert(second.ok); assert.notEqual(second.goal.target.memberId, first.goal.target.memberId);
        clan = await fresh();
        assert.equal(clan.state.strategy.progress, 1);
        assert.equal(calls, 1, 'native tactical progress does not call either model again');
        await q("DELETE FROM clan_actions WHERE clanId=?", [created.clanId]);
        await Database.enqueueClanAction({ clanId: created.clanId, actionKey: 'strategic-review-fixture', actionType: 'goal_plan' });
        const claim = await Database.claimClanAction({});
        assert(claim.action);
        const settled = await Actions.resolveAction(claim.action);
        assert(!settled.followUpError);
        const [next] = await q("SELECT availableAt FROM clan_actions WHERE clanId=? AND actionType='goal_plan' AND status='pending'", [created.clanId]);
        assert(next.availableAt > Date.now() + 60000, 'the next cheap review is delayed, not a busy polling loop');
        assert.equal(calls, 1);
        console.log('Clan strategy native planning, durable assignments, upgrade progress, LLM suppression and delayed queue checks passed');
    } finally {
        Gear.planFor = original.plan; Spots.ensure = original.spots; Gateway.config = original.configured;
        Brain.choose = original.choose; Coordinator.enabled = original.worker;
        Gateway.resetTransport(); Gateway.resetCircuit(); Budget.reset(); Strategy.reset();
        await Database.close(); fs.rmSync(isolated.directory, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
