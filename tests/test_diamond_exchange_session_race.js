const assert = require('node:assert/strict');
const { createWorld, Service, Database, DataCache } = require('./helpers/c4QuestHarness');
const Actor = invoke('GameServer/Actor/Actor');
const Exchange = invoke('GameServer/World/Generics/NpcBypasses/DiamondExchange');
const World = invoke('GameServer/World/World');
const WriteQueue = invoke('GameServer/Persistence/CharacterWriteQueue');

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

const inventory = actor => actor.backpack.fetchItems().map(item => ({
    id: item.fetchId(), selfId: item.fetchSelfId(), amount: item.fetchAmount()
})).sort((a, b) => a.id - b.id);

async function run() {
    const world = await createWorld([710201, 710202, 710203, 710204, 710205, 710206, 710207]
        .map(id => ({ id, classId: 1, level: 40 })), 'diamond-exchange-session-race');
    const npc = { fetchId: () => 170080, fetchSelfId: () => 7080, isDead: () => false,
        fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0 };
    World.npc = { spawns: [npc] };
    const talk = () => ({ selfId: npc.fetchSelfId(), objectId: npc.fetchId() });
    async function sessionFor(id, diamonds = 16) {
        const session = await world.session(id);
        if (diamonds) await Service.giveItem(session, 7562, diamonds);
        const row = await world.character(id);
        const template = DataCache.classTemplates.find(item => item.classId === row.classId);
        session.actor = new Actor(session, { ...row, ...utils.crushOb(template), id,
            name: row.name, username: row.username, level: row.level, classId: row.classId,
            locX: 0, locY: 0, locZ: 0, head: 0, title: '', isActive: 1,
            items: await Database.fetchItems(id), paperdoll: utils.tupleAlloc(16, {}) });
        session.activeNpcTalk = talk();
        session.packets.length = 0;
        return session;
    }
    async function whileDatabaseWaits(session, change) {
        const id = session.actor.fetchId(), entered = deferred(), release = deferred();
        Database.registerCharacterWriteFlush(async characterId => {
            if (characterId === id) { entered.resolve(); await release.promise; }
            await WriteQueue.flushCharacter(characterId);
        });
        const pending = Exchange(session, ['diamond-exchange', '7126']);
        try {
            await entered.promise;
            change();
            release.resolve();
            await pending;
        } finally {
            release.resolve();
            Database.registerCharacterWriteFlush(WriteQueue.flushCharacter);
        }
    }
    try {
        const replacement = await sessionFor(710202, 11);
        await Service.giveItem(replacement, 7126, 2);
        const replacementBag = inventory(replacement.actor);
        const replacementRows = await Database.fetchItems(710202);

        const pending = await sessionFor(710201), originalActor = pending.actor;
        const originalBag = inventory(originalActor);
        await whileDatabaseWaits(pending, () => {
            pending.actor = replacement.actor;
            pending.activeNpcTalk = null;
        });
        assert.deepEqual(inventory(replacement.actor), replacementBag,
            'late exchange rows cannot insert another character\'s physical item IDs');
        assert.deepEqual(await Database.fetchItems(710202), replacementRows);
        assert.equal(pending.packets.length, 0, 'the replacement character receives no old inventory, receipt, HTML or failure packets');
        assert.deepEqual(inventory(originalActor), originalBag, 'the detached actor is not refreshed');
        assert.equal(await world.amount(710201, 7562), 8);
        assert.equal(await world.amount(710201, 7126), 1, 'the accepted transaction remains committed for its original character');
        const reconnected = await world.session(710201);
        assert.equal(reconnected.actor.backpack.fetchItemFromSelfId(7126).fetchAmount(), 1,
            'reconnecting loads the original character\'s committed scroll');

        const queued = await sessionFor(710203), queueGate = deferred();
        queued.questMutationTail = queueGate.promise;
        const queuedExchange = Exchange(queued, ['diamond-exchange', '7126']);
        // Keep the valid NPC context so this scenario requires an actor guard.
        queued.actor = replacement.actor;
        queueGate.resolve();
        await queuedExchange;
        assert.equal(await world.amount(710203, 7562), 16, 'a retired queued request never starts an exchange');
        assert.equal(await world.amount(710203, 7126), 0);
        assert.deepEqual(await Database.fetchItems(710202), replacementRows);
        assert.deepEqual(inventory(replacement.actor), replacementBag);
        assert.equal(queued.packets.length, 0);

        const changedTalk = await sessionFor(710204), talkGate = deferred();
        changedTalk.questMutationTail = talkGate.promise;
        const queuedTalk = Exchange(changedTalk, ['diamond-exchange', '7126']);
        changedTalk.activeNpcTalk = talk();
        talkGate.resolve();
        await queuedTalk;
        assert.equal(await world.amount(710204, 7562), 16, 'a queued request cannot use a newer NPC dialogue');
        assert.equal(changedTalk.packets.length, 0);

        const failed = await sessionFor(710205, 0);
        await whileDatabaseWaits(failed, () => {
            failed.actor = replacement.actor;
            failed.activeNpcTalk = null;
        });
        assert.equal(failed.packets.length, 0, 'a late SQL refusal sends no failure or stale NPC page to the replacement');
        assert.equal(await world.amount(710205, 7126), 0);
        assert.deepEqual(inventory(replacement.actor), replacementBag);

        const closedTalk = await sessionFor(710206);
        await whileDatabaseWaits(closedTalk, () => { closedTalk.activeNpcTalk = null; });
        assert.equal(closedTalk.actor.backpack.fetchItemFromSelfId(7562).fetchAmount(), 8);
        assert.equal(closedTalk.actor.backpack.fetchItemFromSelfId(7126).fetchAmount(), 1,
            'a committed exchange still refreshes the current actor when its NPC dialogue closes');
        assert(!closedTalk.packets.some(packet => packet[0] === 0x0f), 'a closed NPC page is not reopened');

        const control = await sessionFor(710207);
        await Exchange(control, ['diamond-exchange', '7126']);
        assert.equal(await world.amount(710207, 7562), 8);
        assert.equal(control.actor.backpack.fetchItemFromSelfId(7126).fetchAmount(), 1);
        assert.match(world.page(control), /Received/);
        assert.deepEqual(await Database.fetchItems(710202), replacementRows);
        console.log('PASS diamond exchange session race: queued and pending character changes, failure, closed dialogue and normal receipt');
    } finally {
        Database.registerCharacterWriteFlush(WriteQueue.flushCharacter);
        await world.close();
    }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
