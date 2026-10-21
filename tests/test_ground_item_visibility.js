const assert = require('assert');
require('../src/Global');

const World = invoke('GameServer/World/World');
const Session = invoke('GameServer/Session');
const BotSession = invoke('GameServer/Bot/BotSession');
const ActorModel = invoke('GameServer/Model/Actor');
const Data = invoke('GameServer/DataCache');
const Response = invoke('GameServer/Network/Response');
const Bots = invoke('GameServer/Bot/BotManager');
const Loot = invoke('GameServer/Bot/AI/PartyCompanionService');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const select = invoke('GameServer/Actor/Generics/Select');
const pickupExec = invoke('GameServer/Actor/Generics/PickupExec');

const saved = [];
function replace(object, key, value) {
    const original = object[key];
    saved.push(() => { object[key] = original; });
    object[key] = value;
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
let sequence = 8100000;
function session(bot = false, x = 0) {
    const result = Object.create((bot ? BotSession : Session).prototype);
    result.accountId = `${bot ? 'bot_' : 'player_'}ground_${++sequence}`;
    result.botSession = bot;
    result.packets = [];
    result.socket = { write(packet) { result.packets.push(packet.subarray(2)); } };
    result.actor = new ActorModel({ id: ++sequence, locX: x, locY: 0, locZ: 0, isOnline: true });
    result.actor.backpack = {};
    result.actor.session = result;
    World.insertUser(result);
    return result;
}
function spawn(source) {
    let item;
    World.spawnItem(source, 57, 40, { locX: 0, locY: 0, locZ: 0 }, value => { item = value; });
    assert(item);
    return item;
}

async function main() {
    const failures = [];
    async function check(name, run) {
        try { await run(); console.log(`PASS ${name}`); }
        catch (error) { failures.push(error); console.error(`FAIL ${name}: ${error.message}`); }
    }
    try {
        replace(World, 'user', { sessions: [] });
        replace(World, 'items', { spawns: [], nextId: 5000000 });
        replace(World, 'purchaseItem', () => true);
        replace(World, 'fetchNpc', () => Promise.reject(new Error('npc_not_found')));
        replace(Data, 'fetchItemFromSelfId', (id, callback) => callback({ selfId: id, etc: { stackable: true } }));
        replace(Bots, 'sessions', []);
        replace(AfkTrade, 'findProjection', () => null);
        replace(Loot, 'canPickupLoot', () => true);
        replace(Loot, 'adenaAllocations', source => [{ session: source, amount: 40 }]);

        for (const bot of [true, false]) {
            await check(`${bot ? 'bot' : 'player'} pickup deletes the pile for earlier observers outside the broadcast radius`, () => {
                const source = session(bot);
                const observer = session();
                const distant = session(false, 9000);
                const item = spawn(source);
                assert.equal(observer.packets.filter(packet => packet[0] === 0x0b).length, 1);
                observer.actor.setLocX(7000);
                World.updateUserLocation(observer, observer.actor);
                observer.packets.length = distant.packets.length = source.packets.length = 0;
                assert(!World.fetchVisibleRealPlayers(source, item).includes(observer));
                assert.equal(World.pickupItem(source, source.actor, item), true);
                assert.deepEqual(observer.packets.map(packet => packet[0]), [0x12], 'a previous observer must receive DeleteObject');
                assert.equal(observer.packets[0].readInt32LE(1), item.fetchId());
                assert.equal(distant.packets.length, 0, 'clients that never saw the item need no removal');
                if (!bot) assert.equal(source.packets.filter(packet => packet[0] === 0x12).length, 1);
                World.removeUser(source); World.removeUser(observer); World.removeUser(distant);
            });
        }

        await check('nearby observers receive only one removal and a replaced character receives none', () => {
            const source = session(true), near = session(), replaced = session(false, 1);
            const item = spawn(source);
            replaced.actor = new ActorModel({ id: ++sequence, locX: 9000, locY: 0, locZ: 0, isOnline: true });
            World.updateUserLocation(replaced, replaced.actor);
            near.packets.length = replaced.packets.length = 0;
            World.pickupItem(source, source.actor, item);
            assert.deepEqual(near.packets.map(packet => packet[0]), [0x12]);
            assert.equal(replaced.packets.length, 0);
            World.removeUser(source); World.removeUser(near); World.removeUser(replaced);
        });

        await check('a spawn without a source session also removes the pile for a distant earlier observer', () => {
            const source = session(true), observer = session();
            const item = spawn(null);
            observer.actor.setLocX(7000);
            World.updateUserLocation(observer, observer.actor);
            observer.packets.length = 0;
            World.pickupItem(source, source.actor, item);
            assert.deepEqual(observer.packets.map(packet => packet[0]), [0x12]);
            World.removeUser(source); World.removeUser(observer);
        });

        await check('clicking an absent object cancels the client action and removes its ghost', async () => {
            const player = session();
            select(player, player.actor, { id: 5999999 });
            await flush();
            assert.deepEqual(player.packets.map(packet => packet[0]), [0x25, 0x12]);
            assert.equal(player.packets[1].readInt32LE(1), 5999999);
            World.removeUser(player);
        });

        await check('an item removed between selection and pickup lookup also clears its ghost', async () => {
            const player = session();
            let scheduled = false, completed = 0;
            player.actor.automation = { schedulePickup() { scheduled = true; } };
            pickupExec(player, player.actor, { id: 5999998 }, () => { completed++; });
            await flush();
            assert.equal(scheduled, false);
            assert.equal(completed, 1);
            assert.deepEqual(player.packets.map(packet => packet[0]), [0x25, 0x12]);
            World.removeUser(player);
        });

        await check('a competing pickup during the approach clears the stale pile without another award', async () => {
            const player = session();
            const item = spawn(null);
            let arrive, completed = 0;
            player.actor.automation = { schedulePickup(_session, _actor, _item, callback) { arrive = callback; return true; } };
            player.actor.fetchHead = () => 0;
            pickupExec(player, player.actor, { id: item.fetchId() }, () => { completed++; });
            await flush();
            assert.equal(typeof arrive, 'function');
            World.items.spawns.splice(World.items.spawns.indexOf(item), 1);
            const purchase = World.purchaseItem;
            World.purchaseItem = () => { throw new Error('a stale approach must not award the drop'); };
            try {
                player.packets.length = 0;
                arrive();
                assert.deepEqual(player.packets.map(packet => packet[0]), [0x25, 0x47, 0x0d, 0x12]);
                assert.equal(completed, 1);
            } finally { World.purchaseItem = purchase; }
            World.removeUser(player);
        });

        await check('an old missing-object lookup does not send to a replaced character', async () => {
            const player = session();
            select(player, player.actor, { id: 5999997 });
            player.actor = new ActorModel({ id: ++sequence, isOnline: true });
            await flush();
            assert.equal(player.packets.length, 0);
            World.removeUser(player);
        });
        if (failures.length) throw new AggregateError(failures, `${failures.length} ground item checks failed`);
    } finally {
        for (const player of [...World.user.sessions]) World.removeUser(player);
        saved.reverse().forEach(restore => restore());
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
