'use strict';
const assert = require('node:assert/strict');
const Summary = require('../src/GameServer/Bot/Population/InventorySummary');

const stackableIds = [57, 1835, 1869, 2155, 999999];
function stack(selfId, amount, instances = [{ id: selfId + 10000, amount, enchant: 0, equipped: false, slot: 0 }]) {
    return { selfId, amount, stackable: true, enchant: 0, instances };
}

// Start small so a missing guard fails before the crash-sized balances run.
for (const amount of [3, 26078108, 1000000000]) {
    for (const selfId of stackableIds) {
        const original = stack(selfId, amount), before = structuredClone(original);
        const complete = Summary.completeInstances(original);
        assert.equal(complete.instances.length, 1, `stackable ${selfId} must retain one physical stack at amount=${amount}`);
        assert.equal(complete.instances[0].amount, amount, 'the physical stack must keep its whole quantity');
        assert.deepEqual(complete, before, 'completing a stack must preserve its metadata and identity');
        const canonical = Summary.canonicalize({ [selfId]: complete });
        assert.deepEqual(Summary.canonicalize(canonical), canonical, 'repeated normalization must not create per-unit copies');
        assert.deepEqual(original, before, 'normalization must not mutate the input stack');
    }
}
assert.deepEqual(Summary.completeInstances(stack(57, 26078108, [])).instances, [],
    'a stack without physical identities must not fabricate one identity per coin');
const splitStack = stack(1835, 1000000000, [
    { id: 101, amount: 400000000, enchant: 0, equipped: false, slot: 0 },
    { id: 102, amount: 600000000, enchant: 0, equipped: false, slot: 0 }
]);
assert.deepEqual(Summary.completeInstances(splitStack), splitStack, 'existing stack rows must retain quantities and identities');

const ring = { selfId: 881, amount: 2, stackable: false, enchant: 6, equippedSlots: [4, 5],
    instances: [{ id: 201, amount: 1, enchant: 6, equipped: true, slot: 4 }] };
const completedRing = Summary.completeInstances(ring);
assert.deepEqual(completedRing.instances.map(item => [item.id, item.amount, item.enchant, item.equipped, item.slot]),
    [[201, 1, 6, true, 4], [null, 1, 0, true, 5]], 'non-stackable purchases still complete individual copies without inheriting enchant');
assert.equal(ring.instances.length, 1, 'gear completion must not mutate the source');

require('./helpers/databaseIsolation');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const knownStackableIds = stackableIds.filter(selfId => selfId !== 999999);

// Older summaries can carry a false/missing flag and per-copy identities.
// Repair template metadata before attempting any count-based completion.
for (const amount of [3, 26078108]) {
    for (const stackable of [false, undefined]) {
        const legacy = Object.fromEntries(knownStackableIds.map(selfId => [selfId, { ...stack(selfId, amount), stackable }]));
        const before = structuredClone(legacy);
        const normalized = Life.normalizeInventoryStackability(legacy);
        for (const selfId of knownStackableIds) {
            assert.equal(normalized[selfId].stackable, true, `template repairs legacy stackability for ${selfId}`);
            assert.equal(normalized[selfId].amount, amount);
            assert.equal(normalized[selfId].instances, undefined, 'canonical stack summaries retain counts instead of per-copy identities');
        }
        assert.deepEqual(legacy, before, 'repairing metadata must not mutate the saved inventory');
    }
}
const repairedGear = Life.normalizeInventoryStackability({
    881: { ...ring, stackable: true }, 57: null, 1869: { selfId: 1869, amount: 0, stackable: true }
});
assert.equal(repairedGear[881].stackable, false, 'a stale stackable flag must not disable gear instance completion');
assert.deepEqual(repairedGear[881].instances, completedRing.instances, 'template repair still completes the missing ring');
assert.equal(repairedGear[57], undefined, 'invalid saved entries must still be discarded');
assert.equal(repairedGear[1869], undefined, 'empty stacks must still be discarded');

// Exercise the hot actor -> economic state -> gear reconciliation crash path.
const physical = [
    ...knownStackableIds.map(selfId => stack(selfId, 26078108)),
    { selfId: 881, amount: 1, stackable: false, enchant: 6, equipped: true, slot: 4 },
    { selfId: 881, amount: 1, stackable: false, enchant: 3, equipped: true, slot: 5 }
].map((item, index) => ({
    fetchId: () => index + 301, fetchSelfId: () => item.selfId, fetchAmount: () => item.amount,
    fetchStackable: () => item.stackable, fetchEnchantLevel: () => item.enchant,
    fetchEquipped: () => item.equipped, fetchSlot: () => item.slot
}));
const actor = { fetchId: () => 991001, fetchLevel: () => 31, fetchClassId: () => 50,
    backpack: { fetchItems: () => physical, fetchItemFromSelfId: selfId => physical.find(item => item.fetchSelfId() === selfId) } };
const capture = Profile.capture;
try {
    Profile.capture = () => ({});
    const state = Economy.stateForActor(actor, { coldLifeState: { stats: { classId: 50 } } });
    const before = structuredClone(state.inventory);
    for (const selfId of knownStackableIds) {
        assert.equal(state.inventory[selfId].amount, 26078108);
        assert.equal(state.inventory[selfId].instances, undefined, 'hot economy must not attach per-copy instances to stacks');
    }
    const equipped = Planner.equipInventoryUpgrades(state, state.inventory);
    for (const selfId of knownStackableIds) assert.deepEqual(equipped[selfId], state.inventory[selfId]);
    assert.deepEqual(equipped[881].instances.map(item => [item.id, item.enchant, item.slot]),
        [[305, 6, 4], [306, 3, 5]], 'hot gear keeps the identity, enchant and slots of both rings');
    assert.deepEqual(state.inventory, before, 'hypothetical gear reconciliation must not change the live bag');
    const withPhysicalStacks = { ...state.inventory, ...Object.fromEntries(knownStackableIds.map(selfId => [selfId, stack(selfId, 26078108)])) };
    const reconciled = Planner.equipInventoryUpgrades(state, withPhysicalStacks);
    for (const selfId of knownStackableIds) assert.deepEqual(reconciled[selfId], withPhysicalStacks[selfId],
        'gear reconciliation must also accept an existing physical stack summary');
    assert.equal(invoke('Database').isReady(), false, 'the regression must not open a live database');
} finally { Profile.capture = capture; }
console.log('Inventory stackability checks passed: billion-unit stacks, legacy normalization and hot gear reconciliation');
