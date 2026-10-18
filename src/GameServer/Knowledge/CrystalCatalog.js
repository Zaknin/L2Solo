'use strict';

// Raw crystal facts have no acquisition rule. Each owner observes these rows
// at its own original lifetime; cold gear and first-price admission differ.
function* facts(items, observe) {
    for (const gear of items) {
        observe?.(gear);
        const crystals = Number(gear?.etc?.cristals || 0);
        yield { gear, crystals, rank: String(gear?.etc?.rank || '') };
    }
}
function coldGearByRank(items, observe, byRank = new Map()) {
    for (const { gear, crystals, rank } of facts(items, observe)) {
        if (!(crystals > 0) || !/^(Weapon|Armor)\./.test(String(gear.template?.kind || ''))) continue;
        if (!byRank.has(rank)) byRank.set(rank, []);
        byRank.get(rank).push(Object.freeze({ selfId: Number(gear.selfId), crystals, rank }));
    }
    return byRank;
}
module.exports = { facts, coldGearByRank };
