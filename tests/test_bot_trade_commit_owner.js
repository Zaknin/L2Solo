const assert = require('assert');
require('../src/Global');

// E281: one native bot trade has one commit owner. A second confirmation or a
// cancellation that arrives while the inventory transfer is in the database
// must neither start a second transfer nor report a cancelled trade that
// actually completed.

const Database = invoke('Database');
const BotTradeService = invoke('GameServer/Bot/BotTradeService');
const Item = invoke('GameServer/Item/Item');

function item(id, selfId, amount, name) {
    return new Item(id, { selfId, name, kind: 'Other.Material', amount, stackable: true, equipped: false, slot: 0 });
}
function bag(items) {
    return {
        items,
        fetchItems() { return this.items; },
        fetchItemRaw(id) { return this.items.find((entry) => Number(entry.fetchId()) === Number(id)); },
        fetchItemFromSelfId(selfId) { return this.items.find((entry) => Number(entry.fetchSelfId()) === Number(selfId)); },
        insertItem(id, selfId, data) { this.items.push(item(id, selfId, data.amount, data.name)); }
    };
}
function actor(id, name, items = []) {
    return {
        fetchId: () => id,
        fetchName: () => name,
        fetchLocX: () => 0,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchIsOnline: () => true,
        isDead: () => false,
        backpack: bag(items)
    };
}

// A held database: every transfer waits until the test releases it.
const held = [];
const writes = [];
const originalTransfer = Database.transferInventoryBetweenCharacters;
Database.transferInventoryBetweenCharacters = (entries) => {
    writes.push(entries);
    return new Promise((resolve) => held.push(() => resolve(entries.map((entry, index) => ({
        ...entry,
        targetItemId: 900 + writes.length * 10 + index,
        remaining: 3
    })))));
};

function fixture(tag) {
    const player = { accountId: `player_${tag}`, dataSendToMe() {}, actor: actor(100, `Leader${tag}`) };
    const bot = {
        accountId: `bot_${tag}`,
        partyCompanion: true,
        followPlayerSession: player,
        actor: actor(200, `Companion${tag}`, [item(201, 2001, 6, 'Bot Herb')])
    };
    assert.strictEqual(BotTradeService.startBotTrade(bot, player).ok, true);
    assert.strictEqual(BotTradeService.offerBotItem(bot, 201, 3).ok, true);
    return { player, bot, trade: player.activeTrade };
}

(async () => {
    try {
        // Two confirmations while the first transfer waits on the database.
        const a = fixture('A');
        const first = BotTradeService.commit(a.player);
        const confirmation = BotTradeService.confirmPlayerTrade(a.player);
        assert.strictEqual(confirmation.ok, true, 'a repeated confirmation during the commit must reach the in-flight result');
        const second = BotTradeService.commit(a.player);
        assert.strictEqual(writes.length, 1, 'a second confirmation must not start a second database transfer');
        const intruder = { accountId: 'player_intruder', dataSendToMe() {}, actor: actor(300, 'Intruder') };
        const replaced = BotTradeService.startBotTrade(a.bot, a.player);
        assert.strictEqual(replaced.ok, false, 'a committing trade must not be replaced by a new one');
        assert.strictEqual(a.player.activeTrade, a.trade);
        assert.strictEqual(BotTradeService.startPlayerTrade(intruder, a.bot).ok, false, 'a committing bot must not open another trade');
        held.shift()();
        const firstResult = await first;
        const secondResult = await second;
        assert.strictEqual(firstResult.ok, true);
        assert.notStrictEqual(firstResult.idempotent, true, 'the commit owner reports the real completion');
        assert.strictEqual(secondResult.ok, true, 'the joined confirmation gets the same completion');
        assert.strictEqual(secondResult.idempotent, true, 'the joined confirmation must not repeat completion side effects');
        assert.strictEqual(secondResult.tradeId, firstResult.tradeId);
        assert.strictEqual(a.player.actor.backpack.fetchItemFromSelfId(2001).fetchAmount(), 3, 'one offer of 3 delivers 3, not 6');
        assert.strictEqual(a.bot.actor.backpack.fetchItemFromSelfId(2001).fetchAmount(), 3);
        assert.strictEqual(a.player.activeTrade, null);
        assert.strictEqual(a.bot.activeTrade, null);

        // A cancellation while the transfer waits is refused: the DB write wins.
        const b = fixture('B');
        const pending = BotTradeService.commit(b.player);
        assert.strictEqual(BotTradeService.cancel(b.player, 'probe', false), false, 'cancel during the commit must be refused');
        assert.strictEqual(BotTradeService.cleanup(b.bot, 'cold_transition'), false, 'lifecycle cleanup during the commit must not cancel it');
        assert.notStrictEqual(b.trade.state, 'cancelled');
        held.shift()();
        const committed = await pending;
        assert.strictEqual(committed.ok, true);
        assert.strictEqual(b.trade.state, 'committed');
        assert.strictEqual(b.trade.cancelReason, undefined, 'a committed trade carries no cancel reason');
        assert.strictEqual(writes.length, 2);
        // A throw after the database write (here: the memory update) still
        // detaches the committed trade and releases the bot's reservation.
        const c = fixture('C');
        c.player.actor.backpack.insertItem = () => { throw new Error('forced memory failure'); };
        assert.strictEqual(c.bot.botTradeReservations.size, 1);
        const failing = BotTradeService.commit(c.player);
        held.shift()();
        await assert.rejects(failing, /forced memory failure/, 'the throw still reaches the caller');
        assert.strictEqual(c.trade.state, 'committed');
        assert.strictEqual(c.player.activeTrade, null, 'the player is not left holding a dead trade');
        assert.strictEqual(c.bot.activeTrade, null, 'the bot is not left busy with a dead trade');
        assert.strictEqual(c.bot.botTradeReservations.size, 0, 'the reservation is released');
        console.log('Bot trade commit owner checks passed');
    } finally {
        Database.transferInventoryBetweenCharacters = originalTransfer;
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
