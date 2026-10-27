const assert = require('node:assert/strict');
require('../src/Global');
const NpcRewards = require('../src/GameServer/World/Generics/NpcRewards');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');

const originalHeight = GeodataEngine.getHeight;
const originalLeader = PartyCompanionService.groundLootLeader;
const originalQueue = PartyCompanionService.queueRandomGroundPickup;
try {
    GeodataEngine.getHeight = () => -25;
    PartyCompanionService.groundLootLeader = () => null;
    const queued = [];
    PartyCompanionService.queueRandomGroundPickup = (session, item) => queued.push({ session, item });
    const session = { accountId: 'human', actor: { backpack: {} } };
    const npc = { fetchLocX: () => 100, fetchLocY: () => 200, fetchLocZ: () => -30 };
    const item = {};
    const run = (pickupItem, accountId = 'human') => {
        const s = { ...session, accountId };
        const world = {
            spawnItem(_session, _selfId, _amount, _coords, onSpawn) { onSpawn(item); },
            pickupItem
        };
        NpcRewards.spawnGroundDrop(world, s, npc, 57, 1);
        return s;
    };

    let picked = 0;
    run((_session, actor, dropped) => { assert.equal(actor, session.actor); assert.equal(dropped, item); picked++; return true; });
    assert.equal(picked, 1);
    assert.equal(queued.length, 0, 'successful human auto-pickup does not queue AI recovery');

    run(() => false);
    assert.equal(queued.length, 1, 'ineligible human drop falls back to the party recovery queue');

    run(() => { throw new Error('pickup unavailable'); });
    assert.equal(queued.length, 2, 'pickup errors also preserve the fallback queue');

    let botPickupCalls = 0;
    run(() => { botPickupCalls++; return true; }, 'bot_test');
    assert.equal(botPickupCalls, 0, 'AI sessions keep their existing loot path');
    assert.equal(queued.length, 3);
} finally {
    GeodataEngine.getHeight = originalHeight;
    PartyCompanionService.groundLootLeader = originalLeader;
    PartyCompanionService.queueRandomGroundPickup = originalQueue;
}
