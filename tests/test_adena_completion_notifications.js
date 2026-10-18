'use strict';
// Pins the packets/messages (and their order) that SellJunk and AdminGiveAdena send on completion,
// for an existing Adena stack and for a new one.
const assert = require('assert');
require('../src/Global');

const SellJunk = invoke('GameServer/World/Generics/NpcBypasses/SellJunk');
const AdminGiveAdena = invoke('GameServer/World/Generics/NpcBypasses/AdminGiveAdena');
const Database = invoke('Database');
const ServerResponse = invoke('GameServer/Network/Response');
const World = invoke('GameServer/World/World');

const ticks = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve)); };

function item(id, selfId, cash, price, name) {
    return {
        fetchId: () => id, fetchSelfId: () => selfId, fetchAmount: () => cash.value, setAmount: (value) => { cash.value = value; },
        fetchPrice: () => price, fetchName: () => name, fetchEquipped: () => false, fetchStackable: () => true,
        fetchClass1: () => 4, fetchClass2: () => 5, fetchSlot: () => 0
    };
}

function makeSession(name, id, withAdena, withJunk) {
    const cash = { value: 100 };
    const log = [];
    const junk = item(1001, 1539, { value: 1 }, 100, 'Junk');
    const adena = item(1002, 57, cash, 1, 'Adena');
    const backpack = {
        items: [...(withJunk ? [junk] : []), ...(withAdena ? [adena] : [])],
        stackableExists(selfId) {
            const found = this.items.find((entry) => entry.fetchSelfId() === selfId);
            return found ? Promise.resolve(found) : Promise.reject();
        },
        updateAmount(itemId, amount) { if (itemId === 1002) cash.value = amount; },
        insertItem(insertId, selfId, options) { log.push(`insert:${insertId}:${selfId}:${options.amount}`); cash.value = options.amount; },
        fetchItems() { return this.items; }
    };
    const session = {
        accountId: 'human', actor: { fetchId: () => id, fetchName: () => name, backpack },
        dataSendToMe(packet) { log.push(packet); }
    };
    return { session, log, cash };
}

async function main() {
    const original = {
        speak: ServerResponse.speak, itemsList: ServerResponse.itemsList, userInfo: ServerResponse.userInfo,
        deleteItem: Database.deleteItem, updateItemAmount: Database.updateItemAmount, setItem: Database.setItem,
        fetchCharacterName: Database.fetchCharacterName, fetchItems: Database.fetchItems, user: World.user
    };
    ServerResponse.speak = (actor, payload) => `speak:${actor.fetchName()}:${payload.kind}:${payload.text}`;
    ServerResponse.itemsList = () => 'items';
    ServerResponse.userInfo = (actor) => `user:${actor.fetchName()}`;
    Database.deleteItem = () => Promise.resolve();
    Database.updateItemAmount = (...args) => { calls.push(['update', ...args]); return Promise.resolve({ affectedRows: 1 }); };
    Database.setItem = (...args) => { calls.push(['set', args[0], args[1].amount]); return Promise.resolve({ insertId: 7777 }); };
    const calls = [];
    try {
        // SellJunk: junk (price 100) sold, Adena stack present or created.
        for (const withAdena of [true, false]) {
            calls.length = 0;
            const f = makeSession('Seller', 42, withAdena, true);
            await SellJunk(f.session, ['sell-junk']);
            await ticks();
            const payout = f.cash.value - (withAdena ? 100 : 0);
            const expected = [
                ...(withAdena ? [] : ['insert:7777:57:' + payout]),
                'items', 'user:Seller',
                `speak:Seller:0:Sold: 1x Junk (+${payout} Adena)`,
                `speak:Seller:0:Successfully sold 1 items. Gained +${payout} Adena!`
            ];
            assert(payout > 0);
            assert.deepStrictEqual(f.log, expected, `SellJunk withAdena=${withAdena}`);
            assert.strictEqual(calls.at(-1)[0], withAdena ? 'update' : 'set');
        }

        // AdminGiveAdena online: target and admin on different connections, and the same connection.
        for (const withAdena of [true, false]) {
            const admin = makeSession('Admin', 1, true, false);
            const target = makeSession('Target', 2, withAdena, false);
            World.user = { sessions: [admin.session, target.session] };
            await AdminGiveAdena(admin.session, ['admin-give-adena', 'target', '50']);
            await ticks();
            assert.deepStrictEqual(target.log, [
                ...(withAdena ? [] : ['insert:7777:57:50']),
                'user:Target', 'items', 'speak:Target:0:Received 50 Adena from Admin.'
            ], `online target withAdena=${withAdena}`);
            assert.deepStrictEqual(admin.log, ['speak:Admin:0:Successfully gave 50 Adena to Target.']);
            const self = makeSession('Admin', 1, withAdena, false);
            World.user = { sessions: [self.session] };
            await AdminGiveAdena(self.session, ['admin-give-adena', 'admin', '50']);
            await ticks();
            assert.deepStrictEqual(self.log, [
                ...(withAdena ? [] : ['insert:7777:57:50']),
                'user:Admin', 'items', 'speak:Admin:0:Received 50 Adena from Admin.'
            ], `self grant withAdena=${withAdena}`);
        }

        // AdminGiveAdena offline: existing stack and new stack.
        for (const withAdena of [true, false]) {
            const admin = makeSession('Admin', 1, true, false);
            World.user = { sessions: [admin.session] };
            Database.fetchCharacterName = () => Promise.resolve([{ id: 9, name: 'Offline' }]);
            Database.fetchItems = () => Promise.resolve(withAdena ? [{ id: 6001, selfId: 57, amount: 300 }] : []);
            calls.length = 0;
            await AdminGiveAdena(admin.session, ['admin-give-adena', 'offline', '50']);
            await ticks();
            assert.deepStrictEqual(admin.log, ['speak:Admin:0:Successfully gave 50 Adena to offline character Offline.'], `offline withAdena=${withAdena}`);
            assert.deepStrictEqual(calls, withAdena ? [['update', 9, 6001, 350]] : [['set', 9, 50]]);

            // A character change between the write and the message: nothing is sent.
            const changed = makeSession('Admin', 1, true, false);
            World.user = { sessions: [changed.session] };
            Database.updateItemAmount = Database.setItem = () => new Promise((resolve) => { setImmediate(() => { changed.session.actor = { fetchName: () => 'Other' }; resolve({ insertId: 1 }); }); });
            await AdminGiveAdena(changed.session, ['admin-give-adena', 'offline', '50']);
            await ticks();
            assert.deepStrictEqual(changed.log, [], 'no message to another character');
            Database.updateItemAmount = (...args) => { calls.push(['update', ...args]); return Promise.resolve({ affectedRows: 1 }); };
            Database.setItem = (...args) => { calls.push(['set', args[0], args[1].amount]); return Promise.resolve({ insertId: 7777 }); };
        }
        console.log('test_adena_completion_notifications: ok');
    } finally {
        Object.assign(ServerResponse, { speak: original.speak, itemsList: original.itemsList, userInfo: original.userInfo });
        Object.assign(Database, {
            deleteItem: original.deleteItem, updateItemAmount: original.updateItemAmount, setItem: original.setItem,
            fetchCharacterName: original.fetchCharacterName, fetchItems: original.fetchItems
        });
        World.user = original.user;
    }
}
main().then(() => process.exit(process.exitCode || 0)).catch((error) => { console.error(error); process.exit(1); });
