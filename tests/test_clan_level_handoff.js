'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(root, 'tmp', 'clan-level-handoff-'));
const databasePath = path.join(directory, 'world.sqlite');
process.env.L2NODE_CONFIG_FILE = path.join(directory, 'config.ini');
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.env.CLAN_SIMULATION_LLM_GOALS_ENABLED = 'false';
fs.writeFileSync(process.env.L2NODE_CONFIG_FILE, `[Database]\npath=${databasePath}\nhistoryPath=${directory}/history.sqlite\n`);
const seed = new DatabaseSync(databasePath);
seed.exec(fs.readFileSync(path.join(root, 'database/sql/sqlite.sql'), 'utf8'));
seed.exec("INSERT INTO accounts(username,password) VALUES('bot_clan_handoff','test-only')");
seed.close();
require('../src/Global');
invoke('GameServer/DataCache').init();
const Database = invoke('Database');
const Actions = invoke('GameServer/Clan/ClanActionService');
const InventorySummary = invoke('GameServer/Bot/Population/InventorySummary');
const Goals = invoke('GameServer/Clan/ClanGoalService');
const Events = invoke('GameServer/Clan/ClanReviewEvents');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Rules = invoke('GameServer/Clan/ClanRules');
const Contribution = invoke('GameServer/Clan/ClanContributionPolicy');
const sql = (query, params = []) => Database.execute([query, params]);
const one = async (query, params = []) => (await sql(query, params))[0];
let planSequence = 0;

async function fixture(clanId, level, sp, funded = true) {
    Events.stop();
    await sql('DELETE FROM clan_actions');
    const leaderId = clanId + 1000;
    await sql(`INSERT INTO characters(id,username,name,classId,race,level,maxHp,maxMp,
        sex,face,hair,hairColor,locX,locY,locZ,clanId,sp)
        VALUES(?,'bot_clan_handoff',?,4,0,25,500,300,0,0,0,0,83400,148600,-3400,?,?)`,
        [leaderId, `Handoff${clanId}`, clanId, sp]);
    await sql(`INSERT INTO bot_life_state(characterId,accountName,characterName,level,sp,adena,
        activity,phase,inventorySummary,statsJson,updatedAt)
        VALUES(?,'bot_clan_handoff',?,25,?,100000000,'hunting','cold',?, ?,1)`,
        [leaderId, `Handoff${clanId}`, sp, JSON.stringify({ 57: { selfId: 57, amount: 100000000 } }),
            JSON.stringify({ generatedCold: true, classId: 4, clanId, classProgressionLevel: 25, classProgressionClassId: 4 })]);
    await sql(`INSERT INTO items(selfId,name,amount,equipped,slot,characterId)
        VALUES(57,'Adena',100000000,0,0,?)`, [leaderId]);
    await sql('INSERT INTO clans(id,name,level,leaderId) VALUES(?,?,?,?)', [clanId, `Handoff${clanId}`, level, leaderId]);
    await sql(`INSERT INTO clan_simulation_clans(clanId,mode,stateJson,createdAt,updatedAt)
        VALUES(?,'autonomous',?,1,1)`, [clanId, JSON.stringify({ mode: 'autonomous', level, leaderId, memberIds: [leaderId], warehouseRevision: 0 })]);
    if (funded) {
        const paid = await Database.settleClanDues({ clanId, characterId: leaderId, investFraction: 1, timestamp: Date.now() });
        assert.equal(paid.amount, Contribution.scaledAdenaRequirement(level), 'native dues fund the exact current level');
    }
    await Life.init();
    await Life.findByCharacterId(leaderId);
    await Goals.resolveClan(await Goals.clanProjectionById(clanId));
    await Events.drain();
    return { clanId, leaderId, required: Contribution.scaledAdenaRequirement(level) };
}

async function snapshot(clanId) {
    const row = await one(`SELECT c.level,c.leaderId,s.stateJson FROM clans c
        JOIN clan_simulation_clans s ON s.clanId=c.id WHERE c.id=?`, [clanId]);
    return { ...row, state: JSON.parse(row.stateJson) };
}
async function plan(clanId) {
    await Database.enqueueClanAction({ clanId, actionType: 'goal_plan',
        actionKey: `handoff:${clanId}:${++planSequence}`, priority: 100 });
    const result = await Actions.resolveBatch({ limit: 1, budgetMs: 5000 });
    assert.equal(result.failed, 0, JSON.stringify(result));
}
async function runContribution(clanId) {
    const pending = (await Database.fetchClanActions({ clanId, limit: 100 }))
        .filter(action => action.actionType === 'contribution' && action.status === 'pending');
    assert.equal(pending.length, 1, 'completed cash goal must hand off to one native contribution action');
    const result = await Actions.resolveBatch({ limit: 1, budgetMs: 5000 });
    assert.equal(result.failed, 0, JSON.stringify(result));
}
async function noContribution(clanId) {
    assert(!(await Database.fetchClanActions({ clanId, limit: 100 }))
        .some(action => action.actionType === 'contribution' && ['pending', 'running'].includes(action.status)),
    'a blocked payment sleeps until its input changes');
}

async function coldSp(leaderId, sp, replay = false) {
    const { ColdSimulationCoordinator } = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
    const old = Life.cachedState(leaderId);
    const proposal = { characterId: leaderId, revision: old.simulation.revision,
        ...InventorySummary.bagChange(old.inventory, old.inventory),
        nextState: { ...Life.cachedState(leaderId), sp }, options: { allowLifecycle: true }, result: {}, priority: 'P1' };
    const coordinator = new ColdSimulationCoordinator();
    let emitted = 0, results = [];
    // Keep the real prepare, physical commit, cache acceptance and callback
    // boundary. Other gameplay callbacks are exercised by their own tests.
    coordinator.step = async (name, _id, work) => {
        if (name !== 'clanEvents') return;
        emitted++; return work();
    };
    coordinator.queue.onResults = values => { results = values; };
    assert(coordinator.queue.enqueue(proposal).ok);
    await coordinator.queue.flushDue(true);
    assert(results[0]?.ok, JSON.stringify(results));
    assert.equal(emitted, 1);
    if (replay) {
        results = [];
        assert(coordinator.queue.enqueue(proposal).ok);
        await coordinator.queue.flushDue(true);
        assert.equal(results[0]?.ok, false, 'stale native ownership rejects a repeated cold commit');
        assert.equal(emitted, 1, 'rejected commit publishes no SP input');
    }
}

async function main() {
    Database.init();
    try {
        await Database.initClanHalls();
        // Real Hall dues -> native goal completion -> PLAN -> CONTRIBUTION ->
        // atomic level payment -> PLAN for the next level.
        const first = await fixture(720001, 0, Rules.LEVEL_REQUIREMENTS[0].sp + 5);
        assert.equal((await snapshot(first.clanId)).state.goal.status, 'completed');
        await Events.start(null, { subscribeBoardChanges: () => () => {} }, () => {});
        await Actions.resolveBatch({ limit: 1, budgetMs: 5000 });
        await runContribution(first.clanId);
        assert.equal((await snapshot(first.clanId)).level, 1);
        assert.equal((await one('SELECT sp FROM characters WHERE id=?', [first.leaderId])).sp, 5);
        await Actions.resolveBatch({ limit: 1, budgetMs: 5000 });
        const next = await snapshot(first.clanId);
        assert.equal(next.state.goal.target.level, 2, 'successful payment installs the next native cash goal');
        const spent = await one("SELECT COUNT(*) AS n FROM clan_warehouse_ledger WHERE clanId=? AND operation='level_up_consume'", [first.clanId]);
        assert.equal(spent.n, 1, 'one contribution makes one physical payment');

        const waiting = await fixture(720002, 0, 29999);
        await plan(waiting.clanId); await runContribution(waiting.clanId);
        assert.equal((await snapshot(waiting.clanId)).level, 0);
        await noContribution(waiting.clanId);
        assert.equal(Events.pending(), 0, 'insufficient SP schedules no polling input');
        await coldSp(waiting.leaderId, 30000, true);
        assert.deepEqual(await Events.drain(), [{ clanId: waiting.clanId, causes: ['leader_sp'] }]);
        Events.changed(waiting.clanId, 'leader_sp');
        await Actions.resolveBatch({ limit: 1, budgetMs: 5000 });
        await runContribution(waiting.clanId);
        assert.equal((await snapshot(waiting.clanId)).level, 1);
        assert.equal((await one('SELECT sp FROM characters WHERE id=?', [waiting.leaderId])).sp, 0);

        // A level-1 warehouse deposit is real progress, but the same action
        // cannot repeatedly pay while its leader lacks SP.
        const second = await fixture(720003, 1, 149999);
        await plan(second.clanId);
        const Warehouse = invoke('GameServer/Clan/ClanWarehouseService');
        const originalWarehouse = Warehouse.resolveClan;
        let depositCalls = 0;
        Warehouse.resolveClan = async () => {
            depositCalls++;
            const item = await one('SELECT id,selfId,name,amount FROM items WHERE characterId=? AND selfId=57', [second.leaderId]);
            const result = await Life.applyClanMaterialTransfer({ clanId: second.clanId,
                characterId: second.leaderId, item: { ...item, stackable: true }, amount: 1, resolveKey: 'handoff:level1:deposit' });
            assert(result.ok, JSON.stringify(result));
            return { ok: true, deposited: 1 };
        };
        try { await runContribution(second.clanId); }
        finally { Warehouse.resolveClan = originalWarehouse; }
        assert.equal(depositCalls, 1);
        await noContribution(second.clanId);
        assert.equal((await snapshot(second.clanId)).level, 1);
        await Events.drain();
        await coldSp(second.leaderId, 150000);
        await Actions.resolveBatch({ limit: 1, budgetMs: 5000 });
        await runContribution(second.clanId);
        assert.equal((await snapshot(second.clanId)).level, 2);
        assert.equal((await one('SELECT sp FROM characters WHERE id=?', [second.leaderId])).sp, 0);
        assert.equal((await one("SELECT amount FROM clan_warehouse_items WHERE clanId=? AND selfId=57", [second.clanId])).amount, 1);
        await Actions.resolveBatch({ limit: 1, budgetMs: 5000 });
        const itemGoal = (await snapshot(second.clanId)).state.goal;
        assert(itemGoal && itemGoal.target.level !== 2, 'level 2 installs its native next goal');
        const duplicate = await Database.advanceAutonomousClanLevel({ clanId: second.clanId, fromLevel: 1, toLevel: 2, requiredAmount: second.required });
        assert.equal(duplicate.code, 'level_already_advanced');
        assert.equal((await one("SELECT COUNT(*) AS n FROM clan_warehouse_ledger WHERE clanId=? AND operation='level_up_consume'", [second.clanId])).n, 1);

        const hot = await fixture(720004, 0, 29999);
        await plan(hot.clanId); await runContribution(hot.clanId);
        const Actor = invoke('GameServer/Model/Actor');
        const World = invoke('GameServer/World/World');
        const previousUsers = World.user;
        World.user = { sessions: [] };
        const actor = new Actor({ id: hot.leaderId, clanId: hot.clanId, sp: 29999, level: 25, exp: 0 });
        const session = { actor }; actor.session = session; World.user.sessions.push(session);
        try {
            actor.setSp(30000);
            actor.setSp(30001);
            assert.equal(Events.pending(), 1, 'duplicate awards coalesce into one clan review');
            actor.setSp(29998); // Native payment must see later training spending.
            await Actions.resolveBatch({ limit: 1, budgetMs: 5000 });
            await runContribution(hot.clanId);
            assert.equal((await snapshot(hot.clanId)).level, 0);
            await noContribution(hot.clanId);
            actor.setSp(30000);
            await Actions.resolveBatch({ limit: 1, budgetMs: 5000 });
            await runContribution(hot.clanId);
            assert.equal((await snapshot(hot.clanId)).level, 1);
            assert.equal(actor.fetchSp(), 0, 'hot native payment charges the authoritative actor once');
        } finally { World.user = previousUsers; }

        const reserved = await fixture(720005, 0, 30000);
        const reservation = { clanId: reserved.clanId, selfId: 57, goalKey: 'handoff:reserved', amount: reserved.required };
        assert((await Database.reserveClanWarehouseItem(reservation)).ok);
        await Events.drain();
        await plan(reserved.clanId); await runContribution(reserved.clanId);
        await noContribution(reserved.clanId);
        assert.equal((await snapshot(reserved.clanId)).level, 0, 'reserved cash remains protected');
        assert((await Database.releaseClanWarehouseReservation(reservation)).ok);
        assert.equal(Events.pending(), 1, 'committed release wakes the waiting cash goal');
        await Actions.resolveBatch({ limit: 1, budgetMs: 5000 });
        await runContribution(reserved.clanId);
        assert.equal((await snapshot(reserved.clanId)).level, 1);
        await Events.drain();
        assert((await Database.releaseClanWarehouseReservation(reservation)).ok);
        assert.equal(Events.pending(), 0, 'replayed release does not wake');
        assert.equal((await Database.reserveClanWarehouseItem({ ...reservation, goalKey: 'handoff:missing' })).ok, false);
        assert.equal(Events.pending(), 0, 'failed reserve does not wake');

        const source = await one('SELECT id,selfId,name,amount FROM items WHERE characterId=? AND selfId=57', [reserved.leaderId]);
        const deposit = { clanId: reserved.clanId, characterId: reserved.leaderId,
            item: { ...source, stackable: true }, amount: 10, resolveKey: 'handoff:player:deposit' };
        await Database.transferPlayerInventoryToClanWarehouse(deposit);
        assert.deepEqual(await Events.drain(), [{ clanId: reserved.clanId, causes: ['warehouse'] }]);
        await assert.rejects(Database.transferPlayerInventoryToClanWarehouse(deposit));
        assert.equal(Events.pending(), 0, 'rolled-back player replay emits no event');
        const stock = await one('SELECT id,selfId,name,amount FROM clan_warehouse_items WHERE clanId=? AND selfId=57', [reserved.clanId]);
        await Database.transferClanWarehouseToPlayerInventory({ ...deposit, item: { ...stock, stackable: true }, amount: 1, resolveKey: 'handoff:player:withdraw' });
        assert.deepEqual(await Events.drain(), [{ clanId: reserved.clanId, causes: ['warehouse'] }]);
        const withdrawal = { clanId: reserved.clanId, characterId: reserved.leaderId, selfId: 57, amount: 1, goalKey: 'handoff:bot:withdraw' };
        assert((await Database.transferClanWarehouseToMember(withdrawal)).ok);
        assert.deepEqual(await Events.drain(), [{ clanId: reserved.clanId, causes: ['warehouse'] }]);
        assert((await Database.transferClanWarehouseToMember(withdrawal)).ok);
        assert.equal(Events.pending(), 0, 'replayed native withdrawal emits no event');
        const freshSource = await one('SELECT id,selfId,name,amount FROM items WHERE characterId=? AND selfId=57', [reserved.leaderId]);
        const botDeposit = { ...deposit, item: { ...freshSource, stackable: true }, amount: 1, resolveKey: 'handoff:bot:deposit' };
        const appliedDeposit = await Database.transferInventoryToClanWarehouse(botDeposit);
        assert(appliedDeposit.ok, JSON.stringify(appliedDeposit));
        await Events.drain();
        assert.equal((await Database.transferInventoryToClanWarehouse(botDeposit)).code, 'warehouse_transfer_already_applied');
        assert.equal(Events.pending(), 0, 'replayed native deposit emits no event');
        const treasuryReplay = await Database.settleClanDues({ clanId: reserved.clanId, characterId: reserved.leaderId, investFraction: 0, rate: 0, timestamp: Date.now() });
        assert.equal(treasuryReplay.amount, 0);
        assert.equal(Events.pending(), 0, 'unchanged treasury emits no event');
        await sql("INSERT INTO items(selfId,name,amount,equipped,slot,characterId) VALUES(1864,'Stem',2,0,0,?)", [reserved.leaderId]);
        const material = await one('SELECT id,selfId,name,amount FROM items WHERE characterId=? AND selfId=1864', [reserved.leaderId]);
        await Database.transferPlayerInventoryToClanWarehouse({ ...deposit, item: { ...material, stackable: true }, amount: 1, resolveKey: 'handoff:player:material' });
        assert.equal(Events.pending(), 0, 'non-currency player changes do not wake the cash goal');
        const beforeRollback = await one('SELECT amount FROM clan_warehouse_items WHERE clanId=? AND selfId=57', [reserved.clanId]);
        await assert.rejects(Database.transferPlayerInventoryBatchToClanWarehouse({ clanId: reserved.clanId, characterId: reserved.leaderId,
            transfers: [{ ...botDeposit, resolveKey: 'handoff:batch:cash' },
                { item: { id: -1, selfId: 1864 }, amount: 1, resolveKey: 'handoff:batch:missing' }] }));
        assert.equal(Events.pending(), 0, 'failed mixed batch emits no cash event');
        assert.equal((await one('SELECT amount FROM clan_warehouse_items WHERE clanId=? AND selfId=57', [reserved.clanId])).amount, beforeRollback.amount);
        console.log('Clan cash handoff: startup, 0→1, 1→2, cold/hot SP, duplicate payment, reserved cash and committed warehouse inputs passed');
    } finally {
        Events.stop();
        await Database.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
