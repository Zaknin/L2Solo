'use strict';

// K46: while the clan's cash for its next level is funded, the bot leader keeps
// that level's SP and trains only above it; the reserve drops on level-up.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const directory = path.join(require('node:os').tmpdir(), `l2solo-leader-sp-${require('node:crypto').randomUUID()}`);
fs.mkdirSync(directory);
const databasePath = path.join(directory, 'world.sqlite');
const config = path.join(directory, 'fixture.ini'), source = fs.readFileSync(path.resolve('config/default.ini'), 'utf8');
const sections = source.indexOf('[AuthServer]'); assert(sections > 0);
fs.writeFileSync(config, `[Database]\npath = ${databasePath}\nhistoryPath = ${path.join(directory, 'history.sqlite')}\n\n${source.slice(sections)}`);
process.env.L2NODE_CONFIG_FILE = config; delete process.env.L2NODE_SHARED_CONFIG_FILE;
require('../src/Global');
const Database = invoke('Database');
const Data = invoke('GameServer/DataCache');
const Catalog = invoke('GameServer/Skills/SkillBookCatalog');
const Training = invoke('GameServer/Bot/BotSkillTraining');
const Events = invoke('GameServer/Clan/ClanReviewEvents');

async function main() {
    Data.init(); Database.init(); assert(Database.isReady());
    const bishop = async account => {
        await Database.createAccount(account, 'fixture');
        const result = await Database.createCharacter(account, { name: account.slice(4), race: 0, classId: 16,
            maxHp: 100, maxMp: 100, sex: 0, face: 0, hair: 0, hairColor: 0, locX: 0, locY: 0, locZ: 0 });
        const id = Number(result.insertId);
        await Database.updateCharacterExperience(id, 45, Number(Data.experience[44]) + 1, 31000);
        return id;
    };
    const sp = async account => Number((await Database.fetchCharacters(account))[0].sp);
    const leader = await bishop('bot_reserve_leader'), member = await bishop('bot_reserve_member');
    const clanId = Number((await Database.createClan({ name: 'ReserveFixture', leaderId: leader })).insertId);
    for (const id of [leader, member]) await Database.updateCharacterClan(id, clanId, 0, 0, 0);
    const seed = new DatabaseSync(databasePath);
    seed.prepare("INSERT INTO clan_simulation_clans(clanId,mode,createdAt,updatedAt,stateJson) VALUES(?,'autonomous',1,1,'{}')").run(clanId);
    seed.close();

    // A bookless Bishop rank above the 1,000 SP left over the 30,000 reserve.
    const skill = Catalog.entries(16).map(entry => Catalog.nextTraining(16, 45, entry.selfId))
        .find(next => next && next.bookId === null && next.sp > 1000 && next.sp <= 31000);
    assert(skill, 'a bookless rank costs 1,001-31,000 SP');

    const worldPath = require.resolve('../src/GameServer/World/World');
    const session = { actor: { fetchId: () => leader } };
    const world = require.cache[worldPath]?.exports;
    if (world) world.user.sessions.push(session);
    else require.cache[worldPath] = { id: worldPath, filename: worldPath, loaded: true, exports: { user: { sessions: [session] } } };
    const gate = () => { session.skillTrainingGate = { level: 45, classId: 16, nextSp: 99999 }; };
    const track = progress => Events.track({ id: clanId, level: 0, leaderId: leader, members: [],
        state: { mode: 'autonomous', goal: { type: 'level', target: { level: 1 }, required: 650000, progress } } });
    try {
        gate(); track(650000); track(650000);
        assert.equal(Events.spReserve(leader), 30000, 'funded level 0 -> 1 reserves 30,000 SP');
        assert.equal(Events.spReserve(member), 0, 'members keep no reserve');
        assert(session.skillTrainingGate, 'a repeated projection keeps the hot gate');

        // (e) the gates see only the spendable SP.
        const state = { characterId: leader, level: 45, sp: 31000, inventory: {},
            stats: { classId: 16, clanId, coldCombat: { skills: [] } } };
        const cheapest = Catalog.nextTrainingSp({ ...state, characterId: 0 });
        assert.equal(Catalog.nextTrainingSp(state), cheapest + 30000);
        assert.equal(Catalog.needsTraining({ ...state, sp: 30000 + cheapest - 1 }), false);
        assert.equal(Catalog.needsTraining({ ...state, sp: 30000 + cheapest }), true);
        assert.equal(Catalog.needsTraining({ ...state, characterId: member, sp: cheapest }), true);
        assert.equal(Training.stateFor({ fetchId: () => leader, fetchLevel: () => 45, fetchSp: () => 1, fetchClassId: () => 16,
            fetchClanId: () => clanId }).characterId, leader, 'the hot gate state names its bot');

        // (a) funded: the leader keeps the reserve.
        assert.equal((await Database.learnBotSkill(leader, skill.skillId, skill.level)).reason, 'clan_sp_reserve');
        assert.equal(await sp('bot_reserve_leader'), 31000);
        // (c) a member trains as before.
        assert.equal((await Database.learnBotSkill(member, skill.skillId, skill.level)).learned, true);
        assert.equal(await sp('bot_reserve_member'), 31000 - skill.sp);

        // (b) money not ready: no reserve, the hot gate is released.
        track(649999);
        assert.equal(Events.spReserve(leader), 0);
        assert.equal(session.skillTrainingGate, undefined, 'a dropped reserve clears the hot gate');
        assert.equal((await Database.learnBotSkill(leader, skill.skillId, skill.level)).learned, true);
        assert.equal(await sp('bot_reserve_leader'), 31000 - skill.sp);

        // (d) the native level-up pays the SP and releases the reserve at once.
        await Database.updateCharacterExperience(leader, 45, Number(Data.experience[44]) + 1, 31000);
        track(650000); gate();
        assert.equal(Events.spReserve(leader), 30000);
        const advanced = await Database.advanceAutonomousClanLevel({ clanId, fromLevel: 0, toLevel: 1, requiredAmount: 0 });
        assert.equal(advanced.ok, true, advanced.code);
        assert.equal(await sp('bot_reserve_leader'), 1000);
        assert.equal(Events.spReserve(leader), 0, 'level-up releases the reserve');
        assert.equal(session.skillTrainingGate, undefined, 'level-up clears the hot gate');
        gate(); Events.untrack(clanId);
        assert(session.skillTrainingGate, 'untrack without a reserve leaves the gate');
        console.log('Clan leader SP reserve: funded leader keeps 30,000, member/unfunded learn, gates see reserve, level-up releases: PASS');
    } finally {
        if (world) world.user.sessions.splice(world.user.sessions.indexOf(session), 1);
        else delete require.cache[worldPath];
        Events.stop();
    }
}

main().then(async () => { await Database.close?.(); fs.rmSync(directory, { recursive: true, force: true }); })
    .catch(error => { console.error(error); process.exitCode = 1; });
