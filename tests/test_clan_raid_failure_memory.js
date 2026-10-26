'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const isolated = require('./helpers/isolatedSocialDatabase')('clan-raid-failure-memory');
require('./helpers/databaseIsolation');
const { DatabaseSync } = require('node:sqlite');
require('../src/Global');
const Database = invoke('Database');
const Policy = require('../src/GameServer/Clan/ClanRaidFailurePolicy');
const id = 730001, boss = 10050;
const failure = { ...Policy.decision(null, { bossTemplateId: boss, hp: 43273, maxHp: 94593 }),
    failedAt: 100, partyId: 'failed-verfa', failureReason: 'party_death' };
const equipment = memberId => ({ type: 'equipment', goalKey: `equipment:${memberId}`, required: 1,
    target: { memberId, itemId: 2390 }, status: 'executing' });
const query = (sql, args = []) => Database.execute([sql, args]);
async function state() { return JSON.parse((await query('SELECT stateJson FROM clan_simulation_clans WHERE clanId=?', [id]))[0].stateJson); }
async function run() {
    const seed = new DatabaseSync(isolated.world);
    seed.exec(fs.readFileSync(path.join(__dirname, '../database/sql/sqlite.sql'), 'utf8'));
    seed.exec(`INSERT INTO accounts(username,password) VALUES('bot_pop_memory','fixture');
        INSERT INTO characters(id,username,name,classId,race,level,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ)
        VALUES(730001,'bot_pop_memory','MemoryLeader',4,0,55,500,300,0,0,0,0,0,0,0);
        INSERT INTO clans(id,name,leaderId,level) VALUES(730001,'MemoryClan',730001,3)`);
    seed.close();
    Database.init();
    await query(`INSERT INTO clan_simulation_clans(clanId,version,mode,createdAt,updatedAt,stateJson)
        VALUES(?,1,'autonomous',1,1,?)`, [id, JSON.stringify({ clanId: id, mode: 'autonomous', updatedAt: 1,
        goal: equipment(1), productionGoal: equipment(2), memberIds: [] })]);
    const saved = await Database.updateAutonomousClanGoal({ clanId: id, ownerSection: 'productionGoal',
        goal: { ...equipment(2), raidFailure: failure }, expectedUpdatedAt: 1 });
    assert(saved.ok);
    assert.deepEqual((await state()).raidFailures[boss], failure, 'the failure and its owner goal commit together');
    await Database.updateAutonomousClanGoal({ clanId: id, ownerSection: 'productionGoal', goal: null });
    await Database.updateAutonomousClanGoal({ clanId: id, goal: equipment(3) });
    await Database.updateAutonomousClanGoal({ clanId: id, goal: equipment(1) });
    assert.deepEqual([...Policy.blockedSpotIds(null, await state())], ['raid:10050'],
        'rotation, production completion and returning to the beneficiary retain the failed boss');
    await Database.close(); Database.init();
    assert.deepEqual((await state()).raidFailures[boss], failure, 'clan memory survives a database restart');
    const before = await state();
    const conflict = await Database.updateAutonomousClanGoal({ clanId: id, goal: equipment(4), expectedUpdatedAt: -1,
        raidFailure: { ...failure, failedAt: 999, consecutiveFailures: 2 } });
    assert.equal(conflict.code, 'ownership_conflict');
    assert.deepEqual(await state(), before, 'a rejected CAS cannot publish a failure or replace the goal');

    // Recreate the deployed state: the goal has rotated, its old failure was
    // lost, but the committed terminal party still describes the real attempt.
    delete before.raidFailures;
    await query('UPDATE clan_simulation_clans SET stateJson=? WHERE clanId=?', [JSON.stringify(before), id]);
    await query(`INSERT INTO bot_background_parties(partyId,status,statsJson) VALUES(?,'dissolved',?)`,
        [failure.partyId, JSON.stringify({ objective: { clanId: id, clanGoalKey: 'old-equipment' },
            raidEncounter: { status: 'failed', bossTemplateId: boss, hp: 43273, maxHp: 94593,
                failedAt: failure.failedAt, failureReason: failure.failureReason } })]);
    await query('DELETE FROM schema_migrations WHERE version=74');
    await Database.close(); Database.init();
    assert.deepEqual((await state()).raidFailures[boss], failure, 'upgrade recovers a forgotten terminal raid');
    assert.deepEqual((await state()).goal, before.goal, 'recovery preserves the current equipment goal');
    await query('DELETE FROM schema_migrations WHERE version=74');
    await Database.close(); Database.init();
    assert.equal((await state()).raidFailures[boss].consecutiveFailures, 1, 'recovery is idempotent');
    const purgedFailure = { ...Policy.decision(null, { bossTemplateId: 29002, remainingHpRatio: 0.2 }),
        failedAt: 100, partyId: 'purged-first', failureReason: 'party_death' };
    await Database.updateAutonomousClanGoal({ clanId: id, goal: equipment(5), raidFailure: purgedFailure });
    await query(`INSERT INTO bot_background_parties(partyId,status,statsJson) VALUES(?,'dissolved',?)`,
        ['retained-second', JSON.stringify({ objective: { clanId: id, clanGoalKey: 'partial-retention' },
            raidEncounter: { status: 'failed', bossTemplateId: 29002, remainingHpRatio: 0.2, failedAt: 200 } })]);
    await query('DELETE FROM schema_migrations WHERE version IN (74,75)');
    await Database.close(); Database.init();
    assert.equal((await state()).raidFailures[29002].consecutiveFailures, 2,
        'a retained second attempt extends saved memory even after the first party was purged');
    assert.equal((await state()).raidFailures[29002].retryAllowed, false, 'partial retention cannot grant a third attempt');
    await query('DELETE FROM schema_migrations WHERE version=75');
    await Database.close(); Database.init();
    assert.equal((await state()).raidFailures[29002].consecutiveFailures, 2,
        'repair on an already upgraded world does not count the retained attempt twice');
    await Database.updateAutonomousClanGoal({ clanId: id, goal: equipment(6),
        raidFailure: { ...purgedFailure, bossTemplateId: 29003, consecutiveFailures: 4, retryAllowed: false } });
    await query(`INSERT INTO bot_background_parties(partyId,status,statsJson) VALUES(?,'dissolved',?)`,
        ['retained-after-checkpoint', JSON.stringify({ objective: { clanId: id, clanGoalKey: 'v74-world' },
            raidEncounter: { status: 'failed', bossTemplateId: 29003, remainingHpRatio: 0.2, failedAt: 200 } })]);
    await query('DELETE FROM schema_migrations WHERE version=75');
    await Database.close(); Database.init();
    assert.equal((await state()).raidFailures[29003].consecutiveFailures, 5,
        'migration 75 repairs a v74 world from its saved count when the older parties are gone');
    assert.equal((await state()).raidFailures[29003].retryAllowed, false);
    const close = (failedAt, partyId) => ({ ...Policy.decision(null, { bossTemplateId: 29001, remainingHpRatio: 0.2 }),
        failedAt, partyId, failureReason: 'party_death' });
    await Database.updateAutonomousClanGoal({ clanId: id, goal: { ...equipment(4), raidFailure: close(300, 'close-two') } });
    for (const [failedAt, partyId] of [[200, 'close-one'], [300, 'close-two']]) {
        await query(`INSERT INTO bot_background_parties(partyId,status,statsJson) VALUES(?,'dissolved',?)`,
            [partyId, JSON.stringify({ objective: { clanId: id, clanGoalKey: 'old-close-goal' },
                raidEncounter: { status: 'failed', bossTemplateId: 29001, remainingHpRatio: 0.2, failedAt } })]);
    }
    await query('DELETE FROM schema_migrations WHERE version=74');
    await Database.close(); Database.init();
    assert.equal((await state()).raidFailures[29001].consecutiveFailures, 2,
        'recovery combines retained attempts even if a rotated goal remembered only its last failure');
    assert.equal((await state()).raidFailures[29001].retryAllowed, false);
    assert.equal((await state()).raidFailures[boss].consecutiveFailures, 1, 'retry counts remain per boss');
    console.log('Clan raid memory survives goal rotation, CAS conflicts, restart and legacy recovery');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await Database.close(); fs.rmSync(isolated.directory, { recursive: true, force: true });
});
