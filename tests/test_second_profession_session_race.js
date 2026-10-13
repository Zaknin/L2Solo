const assert = require('node:assert/strict');
const { createWorld, Service, Database, DataCache } = require('./helpers/c4QuestHarness');
const Actor = invoke('GameServer/Actor/Actor');
const Profession = invoke('GameServer/SecondProfession');
const Transfer = invoke('GameServer/World/Generics/NpcBypasses/SecondProfession');
const World = invoke('GameServer/World/World');
const WriteQueue = invoke('GameServer/Persistence/CharacterWriteQueue');

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

async function run() {
    const world = await createWorld([710101,710102,710103,710104].map(id => ({ id, classId: 1, level: 40 })),
        'second-profession-session-race');
    const route = Profession.routes.find(row => row.classId === 2);
    const npc = { fetchId: () => 171010, fetchSelfId: () => route.npcs[0], isDead: () => false,
        fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0 };
    World.npc = { spawns: [npc] };
    const originalFetchShortcuts = Database.fetchShortcuts;
    async function sessionFor(id, marks = true) {
        const session = await world.session(id);
        if (marks) for (const mark of route.marks) await Service.giveItem(session,mark,1);
        const row = await world.character(id);
        const template = DataCache.classTemplates.find(item => item.classId === row.classId);
        session.actor = new Actor(session,{ ...row, ...utils.crushOb(template), id, name: row.name,
            username: row.username, level: row.level, classId: row.classId, locX: 0, locY: 0, locZ: 0,
            head: 0, title: '', isActive: 1, items: await Database.fetchItems(id), paperdoll: utils.tupleAlloc(16,{}) });
        session.dataSendToOthers = packet => session.packets.push(packet);
        session.activeNpcTalk = { selfId: npc.fetchSelfId(), objectId: npc.fetchId() };
        return session;
    }
    try {
        const session = await sessionFor(710101), replacement = await sessionFor(710102,false);
        const originalActor = session.actor;
        const entered = deferred(), release = deferred();
        Database.registerCharacterWriteFlush(async id => {
            if (id === 710101) { entered.resolve(); await release.promise; }
            await WriteQueue.flushCharacter(id);
        });
        const pending = Transfer(session,['second-profession','2']);
        await entered.promise;
        const packetsBeforeSwitch = session.packets.length;
        session.actor = replacement.actor;
        session.activeNpcTalk = null;
        release.resolve();
        const result = await pending;
        Database.registerCharacterWriteFlush(WriteQueue.flushCharacter);
        assert.equal(replacement.actor.fetchClassId(),1,'a late transfer cannot change the selected replacement actor');
        assert.equal((await world.character(710102)).classId,1);
        assert.deepEqual(await Database.fetchSkills(710102),[],'replacement character receives no foreign profession skills');
        assert.equal(session.packets.length,packetsBeforeSwitch,'no inventory or congratulations packets reach the replacement character');
        assert.equal(originalActor.fetchClassId(),1,'a detached actor is not refreshed');
        assert.equal((await world.character(710101)).classId,2,'the original character keeps its committed transfer');
        for (const mark of route.marks) assert.equal(await world.amount(710101,mark),0);
        assert.equal(result.ok,true); assert.equal(result.refreshPending,true);

        const queued = await sessionFor(710103), queueGate = deferred();
        queued.questMutationTail = queueGate.promise;
        const queuedTransfer = Transfer(queued,['second-profession','2']);
        queued.actor = replacement.actor;
        queued.activeNpcTalk = null;
        const queuedPackets = queued.packets.length;
        queueGate.resolve();
        const queuedResult = await queuedTransfer;
        assert.equal(queuedResult.ok,false);
        assert.equal((await world.character(710103)).classId,1,'queued requests do not transfer after character selection');
        for (const mark of route.marks) assert.equal(await world.amount(710103,mark),1);
        assert.equal(queued.packets.length,queuedPackets);

        const refreshing = await sessionFor(710104), skillsEntered = deferred(), skillsRelease = deferred();
        const awardSkills = refreshing.actor.skillset.awardSkills;
        refreshing.actor.skillset.awardSkills = async function (...args) {
            skillsEntered.resolve(); await skillsRelease.promise;
            return awardSkills.apply(this,args);
        };
        const skillsTransfer = Transfer(refreshing,['second-profession','2']);
        await skillsEntered.promise;
        const skillsPackets = refreshing.packets.length;
        refreshing.actor = replacement.actor;
        refreshing.activeNpcTalk = null;
        skillsRelease.resolve();
        assert.equal((await skillsTransfer).ok,true);
        assert.equal(refreshing.packets.length,skillsPackets,'late skill awards send no old-character stats to the replacement');
        assert.deepEqual(await Database.fetchSkills(710102),[]);

        const shortcuts = await sessionFor(710104,false), shortcutsEntered = deferred(), shortcutsRelease = deferred();
        Database.fetchShortcuts = async () => { shortcutsEntered.resolve(); return shortcutsRelease.promise; };
        const shortcutRefresh = Transfer(shortcuts,['second-profession','2']);
        await shortcutsEntered.promise;
        const shortcutPackets = shortcuts.packets.length;
        const skill = shortcuts.actor.skillset.fetchSkills().find(row => !row.fetchPassive());
        assert(skill,'the transferred profession has an active skill to refresh');
        shortcuts.actor = replacement.actor;
        shortcuts.activeNpcTalk = null;
        shortcutsRelease.resolve([{ kind: 2, slot: 0, id: skill.fetchSelfId(), unknown: 1 }]);
        assert.equal((await shortcutRefresh).ok,true);
        assert.equal(shortcuts.packets.length,shortcutPackets,'late shortcut reads send neither shortcuts nor old-character status packets');
        assert.equal(replacement.actor.fetchClassId(),1);
        assert.deepEqual(await Database.fetchSkills(710102),[]);
        console.log('PASS second profession session race: database wait, queued bypass, skill award and shortcut refresh');
    } finally {
        Database.registerCharacterWriteFlush(WriteQueue.flushCharacter);
        Database.fetchShortcuts = originalFetchShortcuts;
        await world.close();
    }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
