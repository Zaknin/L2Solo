'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const isolated = require('./helpers/isolatedSocialDatabase')('clan-production-goal-promotion');
require('../src/Global');
isolated.assertConfigured(options.default);

// K37: below level 3 a clan's equipment goal lives in its production section.
// From level 3 the main planner adopts it as its previous goal and saves the
// result in the main section. The production copy used to stay active beside
// it, so its key kept member assignments and clan supply demand alive after
// the goal was closed. The save that adopts the goal now clears that copy;
// a production goal the planner did not adopt is left alone.
const Database = invoke('Database');
const Candidates = invoke('GameServer/Clan/ClanGoalCandidateService');
const Goals = invoke('GameServer/Clan/ClanGoalService');
const Membership = require('../src/GameServer/Clan/ClanMembershipPolicy');

const LEADER = 4710001;
const equipmentGoal = (goalKey, memberId, itemId) => ({ type: 'equipment', goalKey, status: 'executing', required: 1, progress: 0,
    target: { memberId, itemId, slot: 128 }, policy: { strategy: 'drop' }, plan: { kind: 'farm' }, assignedMemberIds: [memberId] });

function seed() {
    [isolated.world, `${isolated.world}-wal`, `${isolated.world}-shm`].forEach(file => fs.rmSync(file, { force: true }));
    const db = new DatabaseSync(isolated.world);
    db.exec(fs.readFileSync(path.join(__dirname, '../database/sql/sqlite.sql'), 'utf8'));
    db.prepare("INSERT INTO accounts(username,password) VALUES('bot_pop_promotion','fixture')").run();
    db.prepare(`INSERT INTO characters(id,username,name,classId,race,level,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ)
        VALUES(?,'bot_pop_promotion','Leader',0,0,40,500,300,0,0,0,0,0,0,0)`).run(LEADER);
    const states = {
        1: { mode: 'player_managed', level: 3, leaderId: LEADER, memberIds: [LEADER], updatedAt: 100, goal: null,
            productionGoal: equipmentGoal('old-equipment', LEADER, 80),
            recruitmentScan: { ownerSection: 'productionGoal', goalKey: 'old-equipment' } },
        2: { mode: 'player_managed', level: 3, leaderId: LEADER, memberIds: [LEADER], updatedAt: 100,
            goal: equipmentGoal('main-equipment', LEADER, 81), productionGoal: equipmentGoal('other-equipment', LEADER, 82) },
        // An earlier promotion already left the same goal in both sections.
        3: { mode: 'player_managed', level: 3, leaderId: LEADER, memberIds: [LEADER], updatedAt: 100,
            goal: equipmentGoal('same-equipment', LEADER, 83), productionGoal: equipmentGoal('same-equipment', LEADER, 83),
            recruitmentDemand: { ownerSection: 'productionGoal', goalKey: 'same-equipment' } }
    };
    for (const [id, state] of Object.entries(states)) {
        db.prepare("INSERT INTO clans(id,name,level,leaderId) VALUES(?,?,3,?)").run(Number(id), `Promotion${id}`, LEADER);
        db.prepare(`INSERT INTO clan_simulation_clans(clanId,mode,createdAt,updatedAt,stateJson) VALUES(?,?,1,100,?)`)
            .run(Number(id), state.mode, JSON.stringify(state));
    }
    db.close();
    return states;
}

async function stored(clanId) {
    const [row] = await Database.execute(['SELECT stateJson FROM clan_simulation_clans WHERE clanId = ?', [clanId]]);
    return JSON.parse(row.stateJson);
}

async function main() {
    const states = seed();
    Database.init();
    // The economic choice is not under test: the beneficiary has its item
    // and nobody needs anything next, so the adopted goal is closed.
    Candidates.snapshotFor = async () => ({ planning: { plans: new Map(), previousFulfilled: true, selection: null, spots: [] },
        candidates: [], decisionNeeded: false });
    try {
        const promoted = await Goals.resolveClan({ id: 1, level: 3, leaderId: LEADER, members: [], state: states[1] });
        assert.equal(promoted.ok, true, JSON.stringify(promoted));
        const after = await stored(1);
        assert.equal(after.goal?.goalKey, 'old-equipment', 'the adopted goal is saved in the main section');
        assert.equal(after.goal.status, 'completed');
        assert.equal(after.productionGoal, null, 'the adopted production copy is cleared in the same write');
        assert.equal(after.recruitmentScan, null, 'its recruitment scan goes with it');
        assert.equal(Membership.activeGoalKeys(after).size, 0, 'no closed goal key stays active');

        const independent = await Goals.resolveClan({ id: 2, level: 3, leaderId: LEADER, members: [], state: states[2] });
        assert.equal(independent.ok, true, JSON.stringify(independent));
        const kept = await stored(2);
        assert.equal(kept.goal?.goalKey, 'main-equipment');
        assert.equal(kept.goal.status, 'completed');
        assert.equal(kept.productionGoal?.goalKey, 'other-equipment', 'a production goal the planner did not adopt is kept');
        assert.equal(kept.productionGoal.status, 'executing');

        const leftover = await Goals.resolveClan({ id: 3, level: 3, leaderId: LEADER, members: [], state: states[3] });
        assert.equal(leftover.ok, true, JSON.stringify(leftover));
        const cleaned = await stored(3);
        assert.equal(cleaned.goal?.status, 'completed');
        assert.equal(cleaned.productionGoal, null, 'a leftover copy of the main goal is cleared');
        assert.equal(cleaned.recruitmentDemand, null, 'its recruitment demand goes with it');
        assert.equal(Membership.activeGoalKeys(cleaned).size, 0);
        console.log('Clan production goal promotion checks passed');
    } finally {
        await Database.close();
        fs.rmSync(isolated.directory, { recursive: true, force: true });
    }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
