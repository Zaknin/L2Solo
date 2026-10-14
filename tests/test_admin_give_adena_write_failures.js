const assert = require('assert');

require('../src/Global');

// The admin panel's "Send Adena" (NpcBypasses/AdminGiveAdena) writes the new
// Adena amount for an online or offline character. A failed write must reach
// the NPC dialog dispatcher's log, not reject unhandled (Node 22 ends the
// server on an unhandled rejection). An existing stack whose update fails is
// not paid again through a new stack.
const NpcTalkResponse = invoke('GameServer/World/Generics/NpcTalkResponse');
const Database = invoke('Database');
const ServerResponse = invoke('GameServer/Network/Response');
const World = invoke('GameServer/World/World');

// Counted only in this test: the server itself has no such listener.
const unhandled = [];
process.on('unhandledRejection', (error) => unhandled.push(error?.message || String(error)));

const ticks = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve)); };

function onlineFixture({ withAdena = true } = {}) {
    const cash = { value: 100 };
    const adena = {
        fetchId: () => 5001, fetchSelfId: () => 57, fetchStackable: () => true,
        fetchAmount: () => cash.value, setAmount: (value) => { cash.value = value; }
    };
    const said = [];
    const backpack = {
        items: withAdena ? [adena] : [],
        fetchItems() { return this.items; },
        stackableExists(selfId) {
            const found = this.items.find((item) => item.fetchSelfId() === selfId);
            return found ? Promise.resolve(found) : Promise.reject();
        },
        updateAmount(id, amount) { if (id === 5001) cash.value = amount; },
        insertItem() {}
    };
    const session = {
        actor: { fetchId: () => 4800001, fetchName: () => 'Online', backpack },
        dataSendToMe(packet) { if (packet?.said) said.push(packet.said); }
    };
    World.user = { sessions: [session] };
    return { session, cash, said };
}

async function scenario(link, writes, fixtureOptions) {
    const f = onlineFixture(fixtureOptions);
    const warnings = [];
    const setItemCalls = [];
    const start = unhandled.length;
    Database.updateItemAmount = writes.updateItemAmount || (() => Promise.resolve());
    Database.setItem = (...args) => { setItemCalls.push(args); return writes.setItem ? writes.setItem(...args) : Promise.resolve({ insertId: 5002 }); };
    Database.fetchCharacterName = writes.fetchCharacterName || (() => Promise.resolve([]));
    Database.fetchItems = writes.fetchItems || (() => Promise.resolve([]));
    utils.infoWarn = (...args) => warnings.push(args);
    NpcTalkResponse(f.session, { link });
    await ticks();
    return {
        unhandled: unhandled.slice(start),
        logged: warnings.filter((args) => String(args[1]).startsWith('Unhandled bypass command') && args[2] === 'admin-give-adena').length,
        setItemCalls: setItemCalls.length,
        cash: f.cash.value,
        said: f.said
    };
}

async function main() {
    const original = {
        updateItemAmount: Database.updateItemAmount, setItem: Database.setItem,
        fetchCharacterName: Database.fetchCharacterName, fetchItems: Database.fetchItems,
        infoWarn: utils.infoWarn, user: World.user,
        speak: ServerResponse.speak, itemsList: ServerResponse.itemsList, userInfo: ServerResponse.userInfo
    };
    ServerResponse.speak = (_, payload) => ({ said: payload.text });
    ServerResponse.itemsList = () => ({});
    ServerResponse.userInfo = () => ({});
    const fail = (message) => () => Promise.reject(new Error(message));
    const offlineRow = () => Promise.resolve([{ id: 4800002, name: 'Offline' }]);
    try {
        const online = await scenario('admin-give-adena Online 50', { updateItemAmount: fail('injected online update failure') });
        assert.deepStrictEqual(online.unhandled, [], 'a failed online Adena update must not reject unhandled');
        assert.strictEqual(online.logged, 1, 'a failed online Adena update is logged by the dispatcher');
        assert.strictEqual(online.setItemCalls, 0, 'a failed update of an existing stack must not insert a second stack');
        assert.strictEqual(online.cash, 100, 'memory keeps the old Adena when its write fails, as before');
        assert(!online.said.some((text) => text.startsWith('Received')), 'no grant message for a failed write');

        const newStack = await scenario('admin-give-adena Online 50', { setItem: fail('injected online new stack failure') }, { withAdena: false });
        assert.deepStrictEqual(newStack.unhandled, [], 'a failed new online stack must not reject unhandled');
        assert.strictEqual(newStack.setItemCalls, 1, 'without a stack the grant creates one, as before');
        assert.strictEqual(newStack.logged, 1, 'a failed new online stack is logged by the dispatcher');

        const lookup = await scenario('admin-give-adena Offline 50', { fetchCharacterName: fail('injected name lookup failure') });
        assert.deepStrictEqual(lookup.unhandled, [], 'a failed offline name lookup must not reject unhandled');
        assert.strictEqual(lookup.logged, 1, 'a failed offline name lookup is logged by the dispatcher');

        const offlineUpdate = await scenario('admin-give-adena Offline 50', {
            fetchCharacterName: offlineRow,
            fetchItems: () => Promise.resolve([{ id: 6001, selfId: 57, amount: 300 }]),
            updateItemAmount: fail('injected offline update failure')
        });
        assert.deepStrictEqual(offlineUpdate.unhandled, [], 'a failed offline Adena update must not reject unhandled');
        assert.strictEqual(offlineUpdate.logged, 1, 'a failed offline Adena update is logged by the dispatcher');
        assert.strictEqual(offlineUpdate.setItemCalls, 0);

        const offlineNew = await scenario('admin-give-adena Offline 50', {
            fetchCharacterName: offlineRow,
            setItem: fail('injected offline new stack failure')
        });
        assert.deepStrictEqual(offlineNew.unhandled, [], 'a failed offline new stack must not reject unhandled');
        assert.strictEqual(offlineNew.logged, 1, 'a failed offline new stack is logged by the dispatcher');

        const ok = await scenario('admin-give-adena Online 50', {});
        assert.deepStrictEqual(ok.unhandled, []);
        assert.strictEqual(ok.logged, 0);
        assert.strictEqual(ok.cash, 150, 'a successful grant is unchanged');
        assert(ok.said.includes('Received 50 Adena from Admin.'));

        const offlineOk = await scenario('admin-give-adena Offline 50', {
            fetchCharacterName: offlineRow,
            fetchItems: () => Promise.resolve([{ id: 6001, selfId: 57, amount: 300 }])
        });
        assert.deepStrictEqual(offlineOk.unhandled, []);
        assert.strictEqual(offlineOk.logged, 0);
        assert(offlineOk.said.includes('Successfully gave 50 Adena to offline character Offline.'));
        // E256: the write is held while the connection selects another character.
        // The Adena stays the first character's; no grant message reaches the other one.
        const held = onlineFixture();
        const writes = [];
        let releaseWrite;
        Database.updateItemAmount = (characterId, itemId, total) => new Promise((resolve) => {
            writes.push([characterId, itemId, total]);
            releaseWrite = resolve;
        });
        utils.infoWarn = () => {};
        NpcTalkResponse(held.session, { link: 'admin-give-adena Online 50' });
        await ticks();
        held.session.actor = { fetchId: () => 4800009, fetchName: () => 'Other', backpack: { fetchItems: () => [] } };
        releaseWrite();
        await ticks();
        assert.deepStrictEqual(writes, [[4800001, 5001, 150]], 'the write is for the character that was granted');
        assert.strictEqual(held.cash.value, 150, 'the granted character keeps the Adena in memory');
        assert.deepStrictEqual(held.said, [], 'no grant message reaches the session of another character');
        console.log('admin give-adena write failure checks passed');
    } finally {
        Object.assign(Database, {
            updateItemAmount: original.updateItemAmount, setItem: original.setItem,
            fetchCharacterName: original.fetchCharacterName, fetchItems: original.fetchItems
        });
        utils.infoWarn = original.infoWarn;
        World.user = original.user;
        Object.assign(ServerResponse, { speak: original.speak, itemsList: original.itemsList, userInfo: original.userInfo });
    }
}

main().then(() => process.exit(process.exitCode || 0)).catch((error) => {
    console.error(error);
    process.exit(1);
});
