// A clan goal change clears a far member's superseded goal plan in a write
// that moves the row's revision, so the member's older worker proposal is
// refused (stale_revision) and the cache keeps the cleared plan. The write holds
// only on the revision main read: a write on a stale revision writes nothing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
require('../src/Global');
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const Data = invoke('GameServer/DataCache');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Policy = require('../src/GameServer/Clan/ClanMembershipPolicy');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'l2solo-clan-goal-member-write-'));
const ACCOUNT = 'bot_clan_goal_member_write';
const CLAN = 821100;
const OLD_GOAL = 'clan-goal-member-write:old';

async function row(id) {
    return (await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [id]]))[0];
}

(async () => {
    try {
        options.default.Database.path = path.join(directory, 'world.sqlite');
        options.default.Database.historyPath = path.join(directory, 'history.sqlite');
        Config.knowledgeErrorsEnabled = false;
        await new Promise(resolve => Database.init(resolve));
        Data.init();
        await Database.createAccount(ACCOUNT, 'fixture');
        await Life.init();
        const far = Number((await Database.createCharacter(ACCOUNT, { name: 'GoalMember',
            race: 0, classId: 0, maxHp: 100, maxMp: 100, sex: 0, face: 0, hair: 0, hairColor: 0,
            locX: 1, locY: 1, locZ: 0 })).insertId);
        await Database.execute(['INSERT INTO clans(id,name,leaderId) VALUES(?,?,?)', [CLAN, 'GoalWriteClan', far]]);
        await Database.execute(['UPDATE characters SET clanId = ? WHERE id = ?', [CLAN, far]]);
        const clanGoal = { clanId: CLAN, goalKey: OLD_GOAL };
        await Life.upsertState({ characterId: far, accountName: ACCOUNT, name: 'GoalMember',
            phase: 'cold', activity: 'resting', level: 1, inventory: {},
            stats: { classId: 0, clanId: CLAN, generatedCold: true, equipmentPlan: { status: 'active', strategy: 'drop', clanGoal },
                clanPartyObjective: { clanId: CLAN, clanGoalKey: OLD_GOAL } },
            loc: { locX: 1, locY: 1, locZ: 0 }, vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
            timing: { nextResolveAt: Date.now() + 86400000 } }, 'clan_goal_member_write_fixture');

        // The worker steps the far member and builds a proposal on the old goal.
        const stepRevision = Life.cachedState(far).simulation.revision;
        const proposed = { ...Life.cachedState(far), stats: { ...Life.cachedState(far).stats, proposalProbe: true } };
        assert.equal(proposed.stats.equipmentPlan?.clanGoal?.goalKey, OLD_GOAL, 'fixture: the proposal carries the old goal');

        // The goal changes: main reads the member and clears the superseded goal
        // on the revision it read, as ClanEquipmentService does.
        const [current] = await Life.statesByIds([far]);
        const read = current.simulation.revision;
        assert.equal(read, Number((await row(far)).simulationRevision), 'fixture: main reads the stepped row');
        const repaired = Policy.reconcileGoals(current, new Set());
        assert.notEqual(repaired, current, 'fixture: the old goal is superseded');
        const written = await Database.writeClanGoalMember(far, repaired.activity, JSON.stringify(repaired.stats), read);
        assert.equal(written.repairedMembers, 1, 'the goal write lands on the revision main read');
        const moved = await row(far);
        assert.equal(Number(moved.simulationRevision), read + 1, 'the goal write moves the row once');
        assert.equal(JSON.parse(moved.statsJson).equipmentPlan, undefined, 'the row holds the cleared plan');
        const cached = Life.cachedState(far);
        assert.equal(cached.simulation.revision, read + 1, 'the cache takes the written revision');
        assert.equal(cached.stats.equipmentPlan, undefined, 'the cache holds the cleared plan');
        assert.equal(cached.stats.clanPartyObjective, undefined, 'the cache holds the cleared objective');

        // The older proposal is refused and does not restore the old goal.
        const [refused] = await Owner.commitBatch([{ revision: stepRevision, nextState: proposed, proposal: {} }]);
        assert.equal(refused.ok, false);
        assert.equal(refused.reason, 'stale_revision', 'the proposal built before the goal write is refused');
        assert.equal(JSON.parse((await row(far)).statsJson).equipmentPlan, undefined, 'the row keeps the cleared plan');
        assert.equal(Life.cachedState(far).stats.equipmentPlan, undefined, 'the cache keeps the cleared plan');

        // A goal write on a revision a commit has since moved writes nothing.
        const before = await row(far);
        const cacheBefore = Life.cachedState(far);
        const stale = await Database.writeClanGoalMember(far, 'crafting',
            JSON.stringify({ ...repaired.stats, staleProbe: true }), read);
        assert.equal(stale.repairedMembers, 0, 'a stale goal write is skipped');
        const after = await row(far);
        assert.equal(after.simulationRevision, before.simulationRevision, 'the skipped write leaves the revision');
        assert.equal(after.statsJson, before.statsJson, 'the skipped write leaves the stats');
        assert.equal(after.activity, before.activity, 'the skipped write leaves the activity');
        assert.equal(Life.cachedState(far), cacheBefore, 'nothing is published on a skip');
        console.log('PASS a clan goal write moves the member revision and holds on the revision read');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
    process.exit(0);
})().catch(error => {
    console.error(error);
    process.exit(1);
});
