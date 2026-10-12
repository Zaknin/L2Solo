'use strict';
const assert = require('node:assert/strict');

// Authored equipment and hunting locations only. Money/demand snapshots are
// produced by workerEconomyDecision in each caller, never supplied here.
function kitFor(classId, level) {
    const entries = invoke('GameServer/Bot/AI/BotGear').planFor({ classId, level }).items;
    const inventory = {};
    for (const entry of entries) {
        const old = inventory[entry.selfId], equippedSlots = [...(old?.equippedSlots || []), entry.slot];
        inventory[entry.selfId] = { ...entry, amount: Number(old?.amount || 0) + 1,
            equipped: true, equippedCount: equippedSlots.length, equippedSlots };
    }
    return { entries, inventory };
}

function spotFor(id) {
    // Standalone tests use the authored economy table, without a live World
    // whose spawn actors populate SpotProfiles.
    const avgLevel = invoke('GameServer/Bot/AI/SpotValueTable').spotLevel(id);
    assert(avgLevel > 0, `native stock hunting spot ${id}`);
    return { id, avgLevel };
}

module.exports = { kitFor, spotFor };
