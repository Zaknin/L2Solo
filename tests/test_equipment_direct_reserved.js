const assert = require('assert');
require('../src/Global');

const BotManager = invoke('GameServer/Bot/BotManager');
const BotAgentTools = invoke('GameServer/Bot/AI/BotAgentTools');
const BotEquipmentUpgrade = invoke('GameServer/Bot/AI/BotEquipmentUpgrade');
const Item = invoke('GameServer/Item/Item');

// A weapon reserved as a luxury-exchange material is hidden from automatic
// selection; the direct equip command (LLM tool) must refuse it the same way.

function wearable(id, data) {
    return new Item(id, {
        selfId: data.selfId || id,
        name: data.name || `item_${id}`,
        kind: data.kind,
        price: data.price ?? 100,
        rank: data.rank || 'none',
        pAtk: data.pAtk || 0,
        equipped: data.equipped || false,
        slot: data.slot
    });
}

const oldSword = wearable(901, { kind: 'Weapon.Sword', slot: 7, pAtk: 8, equipped: true });
const material = wearable(902, { kind: 'Weapon.Sword', slot: 7, pAtk: 20 });
const items = [oldSword, material];
let equipCalls = 0;
const backpack = {
    fetchItems: () => items,
    fetchEquippedWeapon: () => oldSword,
    fetchPaperdollId: (slot) => Number(slot) === 7 ? 901 : 0,
    fetchItemRaw: (id) => items.find((item) => item.fetchId() === id),
    equipGear: () => { equipCalls++; }
};
const leader = { accountId: 'player_reserved_leader', actor: { fetchId: () => 730, fetchName: () => 'Leader', fetchIsOnline: () => true } };
const bot = {
    accountId: 'bot_reserved_gear',
    plan: 'following',
    partyCompanion: true,
    followPlayerSession: leader,
    actor: {
        fetchId: () => 731,
        fetchName: () => 'ReservedCompanion',
        fetchLevel: () => 10,
        fetchClassId: () => 0,
        isDead: () => false,
        state: { fetchHits: () => false, fetchCasts: () => false, fetchTowards: () => false },
        backpack
    }
};
BotManager.sessions = [bot];
const plan = (strategy) => ({ stats: { equipmentPlan: { strategy, materials: [{ selfId: 902, amount: 1 }] } } });

function decision(turnId, itemId) {
    return { action: 'equip_candidate', confidence: 0.99, reply: '', targetPlayerName: '', spotId: '',
        buffType: '', reason: 'reserved test', turnId, itemId };
}
const ctx = (turnId) => ({ playerSession: leader, conversationTurn: { turnId } });

try {
    // control: no plan, the stronger sword is a normal upgrade and applies
    bot.coldLifeState = null;
    assert.strictEqual(BotEquipmentUpgrade.findBestUpgrades(bot).length, 1, 'control: sword is an upgrade without a plan');
    const control = BotEquipmentUpgrade.applyCandidate(bot, 902, { force: true });
    assert.strictEqual(control.applied, true, 'control: direct equip applies without a plan');
    assert.strictEqual(equipCalls, 1);
    equipCalls = 0;

    // reserved for a luxury exchange: auto-selection skips it, direct must refuse
    bot.coldLifeState = plan('luxury_exchange');
    assert.strictEqual(BotEquipmentUpgrade.findBestUpgrades(bot).length, 0, 'auto-selection skips the reserved material');
    assert.strictEqual(BotEquipmentUpgrade.listSafeLoadouts(bot).length, 0);
    const direct = BotEquipmentUpgrade.applyCandidate(bot, 902, { force: true });
    assert.deepStrictEqual(direct, { applied: false, reason: 'reserved_exchange_material' });
    assert.strictEqual(equipCalls, 0, 'reserved material must not be equipped');

    // through the LLM tool: the same refusal shape (clear the check cooldown the forced calls set)
    bot.lastEquipmentUpgradeCheckAt = 0;
    const tool = BotAgentTools.execute(bot, decision('res-1', 902), [], ctx('res-1'));
    assert.strictEqual(tool.applied, false);
    assert.strictEqual(tool.reason, 'reserved_exchange_material');
    assert.strictEqual(equipCalls, 0);

    // another strategy does not reserve it: same as auto-selection
    bot.coldLifeState = plan('craft');
    assert.strictEqual(BotEquipmentUpgrade.findBestUpgrades(bot).length, 1);
    assert.strictEqual(BotEquipmentUpgrade.applyCandidate(bot, 902, { force: true }).applied, true);
    console.log('Direct equip reserved material checks passed');
} finally {
    BotManager.sessions = [];
}
