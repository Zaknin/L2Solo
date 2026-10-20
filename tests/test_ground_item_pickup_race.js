const assert = require('assert');

require('../src/Global');

const pickupItem = invoke('GameServer/World/Generics/PickupItem');
const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');
const ConsoleText = invoke('GameServer/ConsoleText');
const World = invoke('GameServer/World/World');
const Session = invoke('GameServer/Session');
const BotSession = invoke('GameServer/Bot/BotSession');
const DataCache = invoke('GameServer/DataCache');
const NpcVisibility = invoke('GameServer/World/NpcVisibility');

const originalAdenaAllocations = PartyCompanionService.adenaAllocations;
const originalTransmit = ConsoleText.transmit;
const originalWorld = { user: World.user, items: World.items, purchaseItem: World.purchaseItem };
const originalItemTemplates = DataCache.items;

try {
    const pickupMessages = [];
    const deletedObjects = [];
    const purchases = [];
    const isDeleteObject = (packet) => Buffer.isBuffer(packet) && packet[0] === 0x12;
    const playerSession = {
        accountId: 'player',
        dataSendToMe(packet) {
            if (isDeleteObject(packet)) deletedObjects.push({ session: this, id: packet.readInt32LE(1) });
            else pickupMessages.push({ session: this, packet });
        }
    };
    const botSession = { accountId: 'bot_pickup', botSession: true, dataSendToMe() {} };
    playerSession.actor = { backpack: {}, fetchIsOnline: () => true };
    botSession.actor = { backpack: {}, fetchIsOnline: () => true };
    const groundAdena = {
        fetchId: () => 700001,
        fetchSelfId: () => 57,
        fetchAmount: () => 40
    };
    const world = {
        items: { spawns: [groundAdena] },
        isBotSession: World.isBotSession,
        purchaseItem(session, selfId, amount) { purchases.push({ session, selfId, amount }); }
    };

    ConsoleText.transmit = (session, textId, params) => pickupMessages.push({ session, textId, params });
    PartyCompanionService.adenaAllocations = () => [
        { session: playerSession, amount: 20 },
        { session: botSession, amount: 20 }
    ];

    const playerActor = playerSession.actor;
    playerSession.actor = null;
    assert.strictEqual(pickupItem.call(world, playerSession, playerActor, groundAdena), false);
    playerSession.actor = { backpack: {}, fetchIsOnline: () => true };
    assert.strictEqual(pickupItem.call(world, playerSession, playerActor, groundAdena), false, 'a replaced actor must not collect an old pickup');
    playerSession.actor = playerActor;
    playerActor.isDead = () => true;
    assert.strictEqual(pickupItem.call(world, playerSession, playerActor, groundAdena), false);
    delete playerActor.isDead;
    const botActor = botSession.actor;
    botSession.actor = null;
    assert.strictEqual(pickupItem.call(world, playerSession, playerActor, groundAdena), false, 'an invalid allocation must leave the whole drop intact');
    botSession.actor = botActor;
    assert.deepStrictEqual(world.items.spawns, [groundAdena]);
    assert.strictEqual(purchases.length, 0);
    assert.strictEqual(deletedObjects.length, 0);
    assert.strictEqual(pickupItem.call(world, playerSession, playerActor, groundAdena), true, 'the first pickup must claim the ground Adena');
    assert.strictEqual(pickupItem.call(world, botSession, botActor, groundAdena), false, 'a stale competing pickup must not claim the same ground object twice');
    assert.strictEqual(world.items.spawns.length, 0, 'the claimed ground object must be removed exactly once');
    assert.deepStrictEqual(
        purchases.map(({ session, selfId, amount }) => ({ accountId: session.accountId, selfId, amount })),
        [
            { accountId: 'player', selfId: 57, amount: 20 },
            { accountId: 'bot_pickup', selfId: 57, amount: 20 }
        ],
        'a 40 Adena party drop must produce one 20/20 allocation, not two duplicate allocations'
    );
    assert.strictEqual(pickupMessages.length, 2, 'each recipient must see one pickup message only');
    assert.deepStrictEqual(deletedObjects, [{ session: playerSession, id: 700001 }],
        'the picking player must get one DeleteObject, sent only by the winning pickup');

    const groundSaber = {
        fetchId: () => 700002,
        fetchSelfId: () => 123,
        fetchAmount: () => 1
    };
    world.items.spawns.push(groundSaber);
    assert.strictEqual(pickupItem.call(world, playerSession, playerActor, groundSaber), true, 'the normalized weapon drop must be picked up');
    const saberMessage = pickupMessages.at(-1);
    assert.strictEqual(saberMessage.textId, ConsoleText.caption.pickup, 'a single weapon must use the pickup message without an xN amount');
    assert.strictEqual(saberMessage.params.length, 1, 'a single weapon pickup message must contain only the item name');

    // Real World: two players see a bot's drop; one walks beyond the 6000
    // visibility range, the other leaves the World. A bot then picks it up.
    World.user = { sessions: [], revision: 0 };
    World.items = { spawns: [], nextId: 5000001 };
    World.purchaseItem = () => {};
    DataCache.items = [{ selfId: 57, name: 'Adena', kind: 'Other', stackable: true, class1: 4, class2: 5, mass: 0 }];
    const realPlayer = (accountId, id, x) => {
        const packets = [];
        const session = new Session({ write(packet) { packets.push(packet.subarray(2)); } });
        session.accountId = accountId;
        session.actor = { x, backpack: {}, fetchId: () => id, fetchLocX() { return this.x; }, fetchLocY: () => 0,
            fetchLocZ: () => 0, fetchIsOnline: () => true };
        World.insertUser(session);
        return { session, packets };
    };
    const deletesOf = (packets, id) => packets.filter(packet => packet[0] === 0x12 && packet.readInt32LE(1) === id).length;
    const walker = realPlayer('player_walker', 2100001, 100);
    const leaver = realPlayer('player_leaver', 2100002, 200);
    const dropper = new BotSession('bot_dropper');
    dropper.actor = { backpack: {}, fetchId: () => 2100003, fetchIsOnline: () => true };
    let dropped = null;
    World.spawnItem(dropper, 57, 10, { locX: 0, locY: 0, locZ: 0 }, (item) => { dropped = item; });
    const droppedId = dropped.fetchId();
    assert.strictEqual(walker.packets.filter(packet => packet[0] === 0x0b).length, 1, 'a player in range must see the drop');
    assert.strictEqual(leaver.packets.filter(packet => packet[0] === 0x0b).length, 1, 'a second player in range must see the drop');
    walker.session.actor.x = 90000;
    World.updateUserLocation(walker.session);
    World.removeUser(leaver.session);
    PartyCompanionService.adenaAllocations = () => [{ session: dropper, amount: 10 }];
    assert.strictEqual(World.pickupItem(dropper, dropper.actor, dropped), true, 'the bot must claim its ground Adena');
    assert.strictEqual(deletesOf(walker.packets, droppedId), 1,
        'a player who saw the drop must get one DeleteObject even out of range when a bot picks it up');
    assert.strictEqual(deletesOf(leaver.packets, droppedId), 0, 'a session removed from the World must get nothing');
    assert.deepStrictEqual(NpcVisibility.recipientsOf(droppedId), [], 'no session may still hold a picked-up item');
} finally {
    PartyCompanionService.adenaAllocations = originalAdenaAllocations;
    ConsoleText.transmit = originalTransmit;
    World.user = originalWorld.user;
    World.items = originalWorld.items;
    World.purchaseItem = originalWorld.purchaseItem;
    DataCache.items = originalItemTemplates;
}

console.log('Ground item pickup race checks passed');
