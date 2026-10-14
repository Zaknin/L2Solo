const assert = require('node:assert/strict');
require('../src/Global');
const Session = invoke('GameServer/Session');
const Database = invoke('Database');
const Quests = invoke('GameServer/Quest/QuestService');
const Response = invoke('GameServer/Network/Response');

// E248: the quest queue belongs to the connection; work queued for one
// character must not run for, or save into, the character selected next.
async function queuedWorkStaysWithItsCharacter(session, select) {
    const quest = Quests.quests().find(item => item.id === 275);
    const npc = { fetchSelfId: () => quest.killNpcs[0] };
    const Alliance = invoke('GameServer/Clan/ClanAllianceService');
    const QuestAbort = invoke('GameServer/Network/Request/QuestAbort');
    const original = { read: Database.fetchCharacterQuests, write: Database.setCharacterQuest, kill: quest.onKill,
        abort: quest.onAbort, alliance: Alliance.onKill };
    const kills = [], writes = [], aborts = [];
    Database.fetchCharacterQuests = async () => [{ questId: 275, state: 'started', variables: '{"cond":1}' }];
    Database.setCharacterQuest = async (id, questId) => { writes.push({ id: Number(id), questId }); };
    quest.onKill = async state => { kills.push(state.session.actor.fetchId()); };
    quest.onAbort = async state => { aborts.push(state.session.actor.fetchId()); };
    Alliance.onKill = async () => {};
    session.dataSendToMe = () => {};
    const hold = () => { let release; session.questMutationTail = new Promise(resolve => { release = resolve; }); return release; };
    try {
        select(1);
        await Quests.onKill(session, npc);
        assert.deepEqual(kills, [1], 'control: a kill reaches the character that made it');

        let release = hold();
        const kill = Quests.onKill(session, npc);
        select(2);
        release();
        await kill;
        assert.deepEqual(kills, [1], 'a kill queued for character 1 does not progress character 2');

        select(1);
        await Quests.ensureLoaded(session);
        const previous = session.questStates.get(275);
        select(2);
        await previous.save();
        assert.deepEqual(writes, [], 'an old quest state never saves into the replacement character');

        select(1);
        await Quests.ensureLoaded(session);
        release = hold();
        const packet = Buffer.alloc(5); packet.writeInt32LE(275, 1);
        const abort = QuestAbort(session, packet);
        select(2);
        release();
        await abort;
        assert.deepEqual(aborts, [], 'an abort queued for character 1 does not abort the quest of character 2');
    } finally {
        Database.fetchCharacterQuests = original.read;
        Database.setCharacterQuest = original.write;
        quest.onKill = original.kill;
        if (original.abort) quest.onAbort = original.abort; else delete quest.onAbort;
        Alliance.onKill = original.alliance;
        delete session.dataSendToMe;
    }
}

async function main() {
    const original = Database.fetchCharacterQuests;
    const rows = [{ questId: 167, state: 'started', variables: '{"cond":1}' }];
    const reads = [];
    Database.fetchCharacterQuests = async id => { reads.push(id); return id === 1 ? rows : []; };
    const session = Object.create(Session.prototype);
    const select = id => session.setActor({ id, items: [], paperdoll: {} });
    try {
        select(1);
        await Quests.ensureLoaded(session);
        assert.deepEqual(Quests.active(session), [{ id: 167, condition: 1 }]);
        session.activeNpcTalk = { selfId: 7094 };
        select(2);
        assert.equal(session.activeNpcTalk, null);
        assert.deepEqual(Quests.active(session), [], 'selection discards the previous character cache immediately');
        await Quests.ensureLoaded(session);
        assert.deepEqual(Quests.active(session), []);
        const empty = Response.questList(Quests.active(session));
        assert.equal(empty.readUInt16LE(1), 0, 'new character gets an empty native quest list');
        select(1);
        await Quests.ensureLoaded(session);
        assert.deepEqual(Quests.active(session), [{ id: 167, condition: 1 }], 'main character retains its own progress');
        assert.deepEqual(reads, [1, 2, 1]);

        let finishOldRead;
        select(1);
        Database.fetchCharacterQuests = () => new Promise(resolve => { finishOldRead = resolve; });
        const pending = Quests.ensureLoaded(session);
        select(2);
        Database.fetchCharacterQuests = async () => [];
        await Quests.ensureLoaded(session);
        finishOldRead(rows);
        await pending;
        assert.deepEqual(Quests.active(session), [], 'late old-character load cannot contaminate the new character');
        assert.equal(session.questStatesLoaded, true);
        await queuedWorkStaysWithItsCharacter(session, select);
        console.log('Quest character switching, empty client list and stale load isolation passed');
    } finally {
        Database.fetchCharacterQuests = original;
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
