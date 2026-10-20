const Limits = require('./InventoryLimits');
const ItemIndex = require('../Item/ItemTemplateIndex');
const DataCache = invoke('GameServer/DataCache');
const pending = new WeakMap();

// Several ground claims can arrive before the first award reaches the live
// backpack. Count their reserved slots and weight until each award settles.
function reserve(actor, selfId, amount, groundItem) {
    const backpack = actor.backpack;
    if (!Number.isSafeInteger(amount) || amount < 1) return { reason: 'invalid_amount' };
    const template = ItemIndex.find(DataCache.items, selfId);
    const stackable = template?.etc?.stackable ?? groundItem.fetchStackable?.() ?? (selfId === 57);
    const mass = Math.max(0, Number(template?.template?.mass ?? groundItem.fetchMass?.() ?? 0));
    const items = backpack.fetchItems?.() || [];
    const reservations = pending.get(backpack) || new Set();
    const stacks = new Set();
    let slots = 0, load = 0;
    for (const item of items) {
        const count = Number(item.fetchAmount());
        if (!(count > 0)) continue;
        slots += item.fetchStackable() ? 1 : count;
        if (item.fetchStackable()) stacks.add(Number(item.fetchSelfId()));
        load += Number(item.fetchMass()) * count;
    }
    for (const reservation of reservations) {
        slots += reservation.stackable ? Number(!stacks.has(reservation.selfId)) : reservation.amount;
        if (reservation.stackable) stacks.add(reservation.selfId);
        load += reservation.mass * reservation.amount;
    }
    const addedSlots = stackable ? Number(!stacks.has(selfId)) : amount;
    const maxLoad = actor.fetchMaxLoad?.();
    if (slots + addedSlots > Limits.forActor(actor)) return { reason: 'slots' };
    if (Number.isFinite(maxLoad) && load + mass * amount > maxLoad) return { reason: 'weight' };
    const reservation = { selfId, amount, stackable, mass };
    reservations.add(reservation);
    pending.set(backpack, reservations);
    return { release() {
        reservations.delete(reservation);
        if (!reservations.size && pending.get(backpack) === reservations) pending.delete(backpack);
    } };
}

module.exports = { reserve };
