'use strict';
const assert = require('node:assert/strict');

require('../src/Global');

// K36: a raid can belong to the clan's production goal (the item goal a young
// clan runs beside its level goal). A failed raid must be recorded on the goal
// that owns it and wake that goal's planner; before, only the main goal was
// searched, the production failure was dropped as "goal changed" and no retry
// decision was written.
const Database = invoke('Database');
const Goals = invoke('GameServer/Clan/ClanGoalService');
const Equipment = invoke('GameServer/Clan/ClanEquipmentService');

const restore = [];
function replace(object, key, value) {
    const original = object[key];
    restore.push(() => { object[key] = original; });
    object[key] = value;
}

const KEY = 'clan-equipment:1:11:80:128';
const levelGoal = () => ({ type: 'item', goalKey: 'level:2', status: 'executing' });
const raidGoal = (extra = {}) => ({ type: 'equipment', goalKey: KEY, status: 'executing', catastrophicFailures: 0, ...extra });
const party = (section, failedAt = 100) => ({ partyId: 'raid:1', stats: {
    objective: { clanId: 1, clanGoalKey: KEY, fullRoster: { ownerSection: section } },
    raidEncounter: { status: 'failed', bossTemplateId: 29001, remainingHpRatio: 0.2, failedAt, failureReason: 'party_death' } } });

async function record(clan, failedParty) {
    const saves = [], actions = [];
    replace(Goals, 'clanProjectionById', async () => clan);
    replace(Database, 'updateAutonomousClanGoal', async value => { saves.push(value); return { ok: true, goal: value.goal }; });
    replace(Database, 'enqueueClanAction', async value => { actions.push(value); return { ok: true }; });
    try { return { result: await Equipment.recordRaidFailure(failedParty, 100), saves, actions }; }
    finally { while (restore.length) restore.pop()(); }
}

async function run() {
    const main = await record({ id: 1, level: 4, state: { updatedAt: 1, goal: raidGoal() } }, party('goal'));
    assert.equal(main.saves.length, 1, 'a main-goal raid failure is recorded');
    assert.equal(main.saves[0].ownerSection || 'goal', 'goal');
    assert.equal(main.actions.length, 1);
    assert.equal(main.actions[0].actionType, 'goal_plan', 'the main goal planner reviews the failure');

    const production = await record({ id: 1, level: 2, state: { updatedAt: 1, goal: levelGoal(), productionGoal: raidGoal() } },
        party('productionGoal'));
    assert.notEqual(production.result.code, 'raid_goal_changed', 'the production goal still owns the raid');
    assert.equal(production.saves.length, 1, 'a production-goal raid failure is recorded');
    assert.equal(production.saves[0].ownerSection, 'productionGoal', 'the failure is written to the goal that owns the raid');
    assert.equal(production.saves[0].goal.goalKey, KEY);
    assert.equal(production.saves[0].goal.raidFailure.consecutiveFailures, 1);
    assert.equal(production.saves[0].expectedUpdatedAt, 1);
    // The author's retry rule (K24: HP share and failure count) is the same for both owners.
    assert.deepEqual(production.saves[0].goal.raidFailure, main.saves[0].goal.raidFailure);
    assert.equal(production.actions.length, 1, 'the production planner is woken');
    assert.equal(production.actions[0].actionType, 'production', 'below level 3 the production action owns this goal');
    assert.equal(production.actions[0].actionKey, main.actions[0].actionKey);
    assert.equal(production.actions[0].priority, main.actions[0].priority);
    assert.deepEqual(production.actions[0].payload, main.actions[0].payload);

    // From level 3 the production action skips; the main planner adopts the
    // production goal as its previous goal, so it is the one to wake.
    const promoted = await record({ id: 1, level: 3, state: { updatedAt: 1, goal: { type: 'level', status: 'executing' },
        productionGoal: raidGoal() } }, party('productionGoal'));
    assert.equal(promoted.saves[0].ownerSection, 'productionGoal');
    assert.equal(promoted.actions[0].actionType, 'goal_plan');

    const failure = production.saves[0].goal.raidFailure;
    const duplicate = await record({ id: 1, level: 2, state: { updatedAt: 2, goal: levelGoal(),
        productionGoal: raidGoal({ raidFailure: failure }) } }, party('productionGoal'));
    assert.equal(duplicate.result.code, 'raid_failure_already_recorded', 'the same failure is not counted twice');
    assert.equal(duplicate.saves.length, 0);

    const gone = await record({ id: 1, level: 2, state: { updatedAt: 1, goal: levelGoal(), productionGoal: null } },
        party('productionGoal'));
    assert.equal(gone.result.code, 'raid_goal_changed', 'a replaced goal is left alone');
    assert.equal(gone.saves.length, 1, 'a replaced goal cannot discard the clan raid memory');
    assert.deepEqual(gone.saves[0].goal, levelGoal(), 'the new goal is not replanned by an old raid');
    assert.equal(gone.saves[0].raidFailure.partyId, 'raid:1');
    assert.equal(gone.actions.length, 0);
    const remembered = { ...failure, consecutiveFailures: 1, failedAt: 100 };
    const rotated = await record({ id: 1, level: 4, state: { updatedAt: 2,
        goal: raidGoal(), raidFailures: { 29001: remembered } } }, party('goal', 200));
    assert.equal(rotated.saves[0].raidFailure.consecutiveFailures, 2,
        'a second attempt uses clan memory even after the equipment goal was rebuilt');
    assert.equal(rotated.saves[0].raidFailure.retryAllowed, false);
    const stale = await record({ id: 1, level: 4, state: { updatedAt: 2,
        goal: raidGoal(), raidFailures: { 29001: { ...remembered, failedAt: 300 } } } }, party('goal', 200));
    assert.equal(stale.saves.length, 0, 'late delivery of an older terminal attempt cannot replace newer memory');
    const playerGoal = raidGoal({ controlledBy: 'player', orderId: 88 });
    const player = await record({ id: 1, level: 4, state: { updatedAt: 1, goal: playerGoal } }, party('goal'));
    assert.equal(player.result.code, 'player_order_controls_replan');
    assert.deepEqual(player.saves[0].goal, playerGoal, 'observing a failure cannot rewrite a player order');
    assert.equal(player.saves[0].raidFailure.partyId, 'raid:1');
    assert.equal(player.actions.length, 0);
    console.log('Clan raid failure owner checks passed');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
