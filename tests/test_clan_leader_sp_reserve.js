'use strict';

// K46: a bot clan leader keeps the SP of a funded clan level for the native
// level-up; with free bot skills (upstream 5433d733) training never spends it.
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
    const funded = { type: 'level', target: { level: 1 }, required: 650000, progress: 650000 };
    seed.prepare("INSERT INTO clan_simulation_clans(clanId,mode,createdAt,updatedAt,stateJson) VALUES(?,'autonomous',1,1,?)")
        .run(clanId, JSON.stringify({ mode: 'autonomous', goal: funded }));
    seed.close();

    // K46 after upstream 5433d733: bot skills are free, so training never takes
    // the SP the autonomous level-up needs; the native level-up pays it.
    const skill = Catalog.entries(16).map(entry => Catalog.nextTraining(16, 45, entry.selfId)).find(Boolean);
    assert(skill, 'a level-45 Bishop has a rank to learn');
    const track = (progress, level = 0) => Events.track({ id: clanId, level, leaderId: leader, members: [],
        state: { mode: 'autonomous', goal: { ...funded, target: { level: level + 1 }, progress } } });
    try {
        await Events.start(null, { subscribeBoardChanges: () => () => {} }, () => {});
        track(650000);
        assert.equal((await Database.learnBotSkill(leader, skill.skillId, skill.level)).learned, true);
        assert.equal(await sp('bot_reserve_leader'), 31000, 'the funded leader keeps its SP after training');
        assert.equal((await Database.learnBotSkill(member, skill.skillId, skill.level)).learned, true);
        assert.equal(await sp('bot_reserve_member'), 31000, 'a member trains for free too');

        const advanced = await Database.advanceAutonomousClanLevel({ clanId, fromLevel: 0, toLevel: 1, requiredAmount: 0 });
        assert.equal(advanced.ok, true, advanced.code);
        assert.equal(await sp('bot_reserve_leader'), 1000, 'the native level-up pays the 30,000 SP');
        console.log('Clan leader SP: free training keeps the leader SP, the native level-up pays it: PASS');
    } finally {
        Events.stop();
    }
}

main().then(async () => { await Database.close?.(); fs.rmSync(directory, { recursive: true, force: true }); })
    .catch(error => { console.error(error); process.exitCode = 1; });
