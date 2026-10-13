const assert = require('assert');
require('../src/Global');

// E282: a native bot trade belongs to the characters that opened it. When a
// session's character changes (character select, a bot cooling down), the
// trade must not hand items or packets to the new character.

const Database = invoke('Database');
const BotTradeService = invoke('GameServer/Bot/BotTradeService');
const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
const BotLootEtiquette = invoke('GameServer/Bot/AI/BotLootEtiquette');
const BotEquipmentUpgrade = invoke('GameServer/Bot/AI/BotEquipmentUpgrade');
const BotEventJournal = invoke('GameServer/Bot/AI/BotEventJournal');
const BotManager = invoke('GameServer/Bot/BotManager');
const tradeDone = invoke('GameServer/Network/Request/TradeDone');
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

const held = [];
const writes = [];
const original = {
    transfer: Database.transferInventoryBetweenCharacters,
    recordEvent: BotSocialMemory.recordEvent,
    resolveTrade: BotLootEtiquette.resolveTrade,
    applyBestUpgrades: BotEquipmentUpgrade.applyBestUpgrades,
    recordJournal: BotEventJournal.record,
    botTell: BotManager.botTell
};
const followUps = [];

function fixture(tag) {
    const packets = [];
    const player = { accountId: `player_${tag}`, dataSendToMe: (packet) => packets.push(packet), actor: actor(100, `Leader${tag}`) };
    const bot = {
        accountId: `bot_${tag}`,
        partyCompanion: true,
        followPlayerSession: player,
        actor: actor(200, `Companion${tag}`, [item(201, 2001, 6, 'Bot Herb')])
    };
    assert.strictEqual(BotTradeService.startBotTrade(bot, player).ok, true);
    assert.strictEqual(BotTradeService.offerBotItem(bot, 201, 3).ok, true);
    packets.length = 0;
    return { player, bot, packets, trade: player.activeTrade };
}

(async () => {
    try {
        Database.transferInventoryBetweenCharacters = (entries) => {
            writes.push(entries);
            return new Promise((resolve) => held.push(() => resolve(entries.map((entry, index) => ({
                ...entry,
                targetItemId: 900 + writes.length * 10 + index,
                remaining: 3
            })))));
        };
        BotSocialMemory.recordEvent = () => { followUps.push('social'); return Promise.resolve(); };
        BotLootEtiquette.resolveTrade = () => null;
        BotEquipmentUpgrade.applyBestUpgrades = () => { followUps.push('upgrade'); return []; };
        BotEventJournal.record = () => { followUps.push('journal'); return Promise.resolve(); };
        BotManager.botTell = () => followUps.push('tell');

        // The player picks another character while the transfer waits.
        const a = fixture('A');
        const oldPlayerActor = a.player.actor;
        const pending = BotTradeService.commit(a.player);
        a.player.actor = actor(101, 'OtherCharacter');
        held.shift()();
        const switched = await pending;
        assert.strictEqual(writes[0][0].toCharacterId, 100, 'the database receives the character that confirmed');
        assert.strictEqual(switched.ok, true, 'the database transfer is done');
        assert.strictEqual(a.player.actor.backpack.items.length, 0, 'the new character must not receive the traded items');
        assert.strictEqual(oldPlayerActor.backpack.items.length, 0, 'a retired actor is never saved again, so it is not updated');
        assert.strictEqual(a.bot.actor.backpack.fetchItemFromSelfId(2001).fetchAmount(), 3, 'the unchanged bot side is still applied');
        assert.strictEqual(a.player.activeTrade, null);

        // The bot cools down (its actor is dropped) while the transfer waits.
        const b = fixture('B');
        const pendingCold = BotTradeService.commit(b.player);
        b.bot.actor = null;
        held.shift()();
        const cooled = await pendingCold;
        assert.strictEqual(cooled.ok, true, 'a dropped bot actor must not break the committed trade');
        assert.strictEqual(b.player.actor.backpack.fetchItemFromSelfId(2001).fetchAmount(), 3, 'the unchanged player side is applied');
        assert.strictEqual(b.bot.activeTrade, null);

        // A character change before the confirmation ends the trade.
        const c = fixture('C');
        c.player.actor = actor(101, 'OtherCharacter');
        const writesBefore = writes.length;
        const rejected = BotTradeService.confirmPlayerTrade(c.player);
        assert.strictEqual(rejected.ok, false, 'a trade opened by another character cannot be confirmed');
        assert.strictEqual(c.trade.state, 'cancelled');
        assert.strictEqual(c.trade.cancelReason, 'actor_changed');
        assert.strictEqual(c.packets.length, 0, 'the new character gets no packet about the old trade');
        assert.strictEqual((await BotTradeService.commit(c.player)).ok, false);
        assert.strictEqual(writes.length, writesBefore, 'no transfer for a trade whose character changed');

        // Through the packet handler: the new character gets no trade packets
        // and no follow-ups addressed to the old character.
        const d = fixture('D');
        const handled = tradeDone(d.player, Buffer.from([0x17, 1, 0, 0, 0]));
        d.player.actor = actor(101, 'OtherCharacter');
        held.shift()();
        await handled;
        assert.strictEqual(d.packets.length, 0, 'no packets to a session whose character changed');
        assert.deepStrictEqual(followUps, [], 'no social or upgrade follow-ups for the replaced character');
        console.log('Bot trade actor identity checks passed');
    } finally {
        Database.transferInventoryBetweenCharacters = original.transfer;
        BotSocialMemory.recordEvent = original.recordEvent;
        BotLootEtiquette.resolveTrade = original.resolveTrade;
        BotEquipmentUpgrade.applyBestUpgrades = original.applyBestUpgrades;
        BotEventJournal.record = original.recordJournal;
        BotManager.botTell = original.botTell;
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
