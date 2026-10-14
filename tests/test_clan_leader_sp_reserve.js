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
    const funded = { type: 'level', target: { level: 1 }, required: 650000, progress: 650000 };
    seed.prepare("INSERT INTO clan_simulation_clans(clanId,mode,createdAt,updatedAt,stateJson) VALUES(?,'autonomous',1,1,?)")
        .run(clanId, JSON.stringify({ mode: 'autonomous', goal: funded }));
    seed.close();

    // A bookless Bishop rank above the 1,000 SP left over the 30,000 reserve.
    const skill = Catalog.entries(16).map(entry => Catalog.nextTraining(16, 45, entry.selfId))
        .find(next => next && next.bookId === null && next.sp > 1000 && next.sp <= 31000);
    assert(skill, 'a bookless rank costs 1,001-31,000 SP');
    const track = (progress, level = 0) => Events.track({ id: clanId, level, leaderId: leader, members: [],
        state: { mode: 'autonomous', goal: { ...funded, target: { level: level + 1 }, progress } } });
    try {
        // Restart: start() rebuilds the reserve from the stored goal.
        await Events.start(null, { subscribeBoardChanges: () => () => {} }, () => {});
        assert.equal(Events.spReserve(leader), 30000, 'funded level 0 -> 1 reserves 30,000 SP after start');
        assert.equal(Events.spReserve(member), 0, 'members keep no reserve');

        // The gates see only the spendable SP; the hot gate caches the plain cost.
        const state = { characterId: leader, level: 45, sp: 31000, inventory: {},
            stats: { classId: 16, clanId, coldCombat: { skills: [] } } };
        const cheapest = Catalog.nextTrainingSp({ ...state, characterId: 0 });
        assert.equal(Catalog.nextTrainingSp(state), cheapest);
        assert.equal(Catalog.needsTraining({ ...state, sp: 30000 + cheapest - 1 }), false);
        assert.equal(Catalog.needsTraining({ ...state, sp: 30000 + cheapest }), true);
        assert.equal(Catalog.needsTraining({ ...state, characterId: member, sp: cheapest }), true);
        const actor = { fetchId: () => leader, fetchLevel: () => 45, fetchSp: () => 31000, fetchClassId: () => 16,
            fetchClanId: () => clanId, backpack: { fetchItems: () => [] }, skillset: { fetchSkills: () => [] } };
        assert.equal(Training.stateFor(actor).characterId, leader, 'the hot gate state names its bot');
        const Progression = invoke('GameServer/Bot/BotClassProgression');
        const old = { next: Catalog.nextTrainingSp, needs: Catalog.needsTraining, plan: Progression.plan };
        let needs = 0;
        const session = { actor, accountId: 'bot_reserve_leader', skillTrainingGate: { level: 45, classId: 16, nextSp: 5000 } };
        try {
            Catalog.nextTrainingSp = () => 5000; Catalog.needsTraining = () => { needs++; return false; };
            Progression.plan = () => ({ transitions: [] });
            await Training.review(session, { onSpAward: true });
            assert.equal(needs, 0, '31,000 SP - 30,000 reserve stays under a 5,000 gate');
            track(649999);
            await Training.review(session, { onSpAward: true });
            assert.equal(needs, 1, 'without the reserve the same gate opens');
        } finally { Catalog.nextTrainingSp = old.next; Catalog.needsTraining = old.needs; Progression.plan = old.plan; }

        // Funded: the leader keeps the reserve; a member trains as before.
        track(650000);
        assert.equal((await Database.learnBotSkill(leader, skill.skillId, skill.level)).reason, 'clan_sp_reserve');
        assert.equal(await sp('bot_reserve_leader'), 31000);
        assert.equal((await Database.learnBotSkill(member, skill.skillId, skill.level)).learned, true);
        assert.equal(await sp('bot_reserve_member'), 31000 - skill.sp);

        // Money not ready: no reserve.
        track(649999);
        assert.equal(Events.spReserve(leader), 0);
        assert.equal((await Database.learnBotSkill(leader, skill.skillId, skill.level)).learned, true);
        assert.equal(await sp('bot_reserve_leader'), 31000 - skill.sp);

        // The native level-up pays the SP and the reserve reads 0 at once.
        await Database.updateCharacterExperience(leader, 45, Number(Data.experience[44]) + 1, 31000);
        track(650000);
        assert.equal(Events.spReserve(leader), 30000);
        const advanced = await Database.advanceAutonomousClanLevel({ clanId, fromLevel: 0, toLevel: 1, requiredAmount: 0 });
        assert.equal(advanced.ok, true, advanced.code);
        assert.equal(await sp('bot_reserve_leader'), 1000);
        assert.equal(Events.spReserve(leader), 0, 'level-up releases the reserve');

        // Level 1 -> 2 reserves 150,000; untrack (dissolution) drops it.
        track(650000, 1);
        assert.equal(Events.spReserve(leader), 150000, 'funded level 1 -> 2 reserves 150,000 SP');
        Events.untrack(clanId);
        assert.equal(Events.spReserve(leader), 0, 'untrack releases the reserve');
        console.log('Clan leader SP reserve: start rebuild, 30,000/150,000 reserve, member/unfunded learn, gates and hot gate see reserve, level-up/untrack release: PASS');
    } finally {
        Events.stop();
    }
}

main().then(async () => { await Database.close?.(); fs.rmSync(directory, { recursive: true, force: true }); })
    .catch(error => { console.error(error); process.exitCode = 1; });
