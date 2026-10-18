'use strict';

const assert = require('node:assert/strict');

// Pin the native shop caller without a world, database or live bot sessions.
const zone = (x, ids) => ({ bounds: [{ locX: x, locY: 0 }], spawns: ids.map(selfId => ({ selfId })) });
const reward = (selfId, items, spoils = []) => ({ selfId,
    rewards: [{ items: items.map(selfId => ({ selfId })) }], spoils: [{ items: spoils.map(selfId => ({ selfId })) }] });
const data = {
    npcSpawns: [zone(1, [10, '10', 10]), zone(25001, [11]), zone(-25000, [12]),
        { bounds: [], spawns: [{ selfId: 13 }] }],
    npcRewards: [reward(10, [57, 100]), reward(10, [999]), reward('10', [101], [102]),
        reward(11, [103]), reward(12, [104]), reward(13, [106]), reward(20, [105])],
    fetchItemFromSelfId(selfId, callback) { callback({ selfId }); }
};
const actor = (x) => ({ x, fetchLocX() { return this.x; }, fetchLocY: () => 0, fetchLocZ: () => 0 });
const close = actor(1), other = actor(400), player = actor(0);
player.backpack = { fetchTotalAdena: () => 500 };
const manager = { sessions: [{ plan: 'merchant', actor: close }, { plan: 'merchant', actor: other }] };
const talk = { items: { nextId: 1 } };
const dependencies = {
    'GameServer/DataCache': data,
    'GameServer/Bot/BotManager': manager,
    'GameServer/World/Generics/NpcTalkResponse': talk,
    'GameServer/Item/Item': class Item { constructor(id, model) { this.id = id; this.model = model; } },
    'GameServer/Network/Response': {
        speak: (source, content) => ({ text: content.text }),
        purchaseList: (items, adena) => ({ ids: items.map(item => item.model.selfId), adena })
    }
};
global.invoke = name => {
    assert(Object.hasOwn(dependencies, name), 'unexpected dependency ' + name);
    return dependencies[name];
};
global.utils = { crushOb: structuredClone };

const buyBotShop = require('../src/GameServer/World/Generics/NpcBypasses/BuyBotShop');
const packets = [], session = { actor: player, dataSendToMe: packet => packets.push(packet) };
const open = () => { buyBotShop(session, []); return packets.at(-1); };
assert.deepEqual(open(), { ids: [100, 101, 102, 103], adena: 500 },
    'native zone/spawn order, strict NPC IDs, FIRST reward rows and inclusive 25000 boundary determine the shop');
close.x = -1;
assert.deepEqual(open().ids, [100, 101, 102, 104],
    'moving the same merchant rechecks current distances against prepared centres');
close.x = 3000;
assert.deepEqual(open().ids, [100, 101, 102, 103], 'the current nearest merchant is chosen on every opening');
data.npcSpawns.push(zone(400, [20]));
assert.deepEqual(open().ids, [100, 101, 102, 103, 105], 'a grown spawn source contributes its new nearby zone');
data.npcSpawns = [zone(400, ['10'])];
assert.deepEqual(open().ids, [101, 102], 'replacement sources retain strict NPC and spoil relations');
other.x = 600;
assert.equal(open().text, 'Merchant is too far.', 'the live merchant-distance guard remains authoritative');
assert.equal(session.activeAdminShop, null);
console.log('Bot shop native source relation checks passed');
