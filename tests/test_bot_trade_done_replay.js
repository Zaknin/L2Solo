const assert = require('assert');
require('../src/Global');

// E285: a repeated TradeDone confirmation for a native bot trade gets the
// completed result (TradeDone true), not ActionFailed. Also checks through
// the handler that two confirmations in flight make one transfer (E281).

const Database = invoke('Database');
const BotTradeService = invoke('GameServer/Bot/BotTradeService');
const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
const BotLootEtiquette = invoke('GameServer/Bot/AI/BotLootEtiquette');
const BotEquipmentUpgrade = invoke('GameServer/Bot/AI/BotEquipmentUpgrade');
const BotEventJournal = invoke('GameServer/Bot/AI/BotEventJournal');
const BotManager = invoke('GameServer/Bot/BotManager');
const tradeDone = invoke('GameServer/Network/Request/TradeDone');
const Item = invoke('GameServer/Item/Item');

const ACTION_FAILED = 0x25;
const TRADE_DONE = 0x22;
const CONFIRM = Buffer.from([0x17, 1, 0, 0, 0]);

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
const tells = [];
const original = {
    transfer: Database.transferInventoryBetweenCharacters,
    recordEvent: BotSocialMemory.recordEvent,
    resolveTrade: BotLootEtiquette.resolveTrade,
    applyBestUpgrades: BotEquipmentUpgrade.applyBestUpgrades,
    recordJournal: BotEventJournal.record,
    botTell: BotManager.botTell
};

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
    return { player, bot, packets };
}
const opcodes = (packets) => packets.map((packet) => `${packet[0]}:${packet[0] === TRADE_DONE ? packet[1] : ''}`);

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
        BotSocialMemory.recordEvent = () => Promise.resolve();
        BotLootEtiquette.resolveTrade = () => null;
        BotEquipmentUpgrade.applyBestUpgrades = () => [];
        BotEventJournal.record = () => Promise.resolve();
        BotManager.botTell = (source, target, text) => tells.push(text);

        // A repeated confirmation shortly after the trade completed.
        const a = fixture('A');
        const done = tradeDone(a.player, CONFIRM);
        held.shift()();
        await done;
        assert.deepStrictEqual(opcodes(a.packets).slice(-1), [`${TRADE_DONE}:1`], 'the first confirmation completes the trade');
        a.packets.length = 0;
        await tradeDone(a.player, CONFIRM);
        assert.strictEqual(writes.length, 1, 'the repeated confirmation must not transfer again');
        assert.deepStrictEqual(opcodes(a.packets), [`${TRADE_DONE}:1`], 'the repeated confirmation gets the completed result, not ActionFailed');
        assert.strictEqual(tells.length, 1, 'the bot thanks the player once');

        // The completed result belongs to the character that traded.
        a.player.actor = actor(101, 'OtherCharacter');
        a.packets.length = 0;
        await tradeDone(a.player, CONFIRM);
        assert.strictEqual(a.packets[0][0], ACTION_FAILED, 'another character on the session gets no replay of the old trade');

        // Two confirmations while the transfer waits: one transfer, both
        // packets end with the completed result, follow-ups once.
        const b = fixture('B');
        const tellsBefore = tells.length;
        const first = tradeDone(b.player, CONFIRM);
        const second = tradeDone(b.player, CONFIRM);
        await Promise.resolve();
        held.shift()();
        await Promise.all([first, second]);
        assert.strictEqual(writes.length, 2, 'concurrent confirmations make one transfer');
        assert(!b.packets.some((packet) => packet[0] === ACTION_FAILED), 'no ActionFailed for a confirmation that joined the commit');
        assert.strictEqual(opcodes(b.packets).filter((code) => code === `${TRADE_DONE}:1`).length, 2);
        assert.strictEqual(tells.length, tellsBefore + 1, 'completion follow-ups run once');
        assert.strictEqual(b.player.actor.backpack.fetchItemFromSelfId(2001).fetchAmount(), 3);
        console.log('Bot trade done replay checks passed');
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
