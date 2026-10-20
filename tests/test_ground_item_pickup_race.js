const assert = require('assert');

require('../src/Global');

const pickupItem = invoke('GameServer/World/Generics/PickupItem');
const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');
const ConsoleText = invoke('GameServer/ConsoleText');
const World = invoke('GameServer/World/World');

const originalAdenaAllocations = PartyCompanionService.adenaAllocations;
const originalTransmit = ConsoleText.transmit;

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

    // The player saw the drop, then walked beyond the 6000 visibility range;
    // a bot picks the item up and the player's client must still drop the object.
    deletedObjects.length = 0;
    const farAdena = {
        fetchId: () => 700003,
        fetchSelfId: () => 57,
        fetchAmount: () => 10,
        viewers: [playerSession]
    };
    playerActor.fetchLocX = () => 90000;
    playerActor.fetchLocY = () => 0;
    world.items.spawns.push(farAdena);
    PartyCompanionService.adenaAllocations = () => [{ session: botSession, amount: 10 }];
    assert.strictEqual(pickupItem.call(world, botSession, botSession.actor, farAdena), true, 'the bot must claim the ground Adena');
    assert.deepStrictEqual(deletedObjects, [{ session: playerSession, id: 700003 }],
        'a player who saw the drop must get one DeleteObject even out of range when a bot picks it up');

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
} finally {
    PartyCompanionService.adenaAllocations = originalAdenaAllocations;
    ConsoleText.transmit = originalTransmit;
}

console.log('Ground item pickup race checks passed');
