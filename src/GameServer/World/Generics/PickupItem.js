const ServerResponse = invoke('GameServer/Network/Response');
const ConsoleText    = invoke('GameServer/ConsoleText');
const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');
const PickupCapacity = require('../../Inventory/PickupCapacity');
const NpcVisibility  = invoke('GameServer/World/NpcVisibility');

function pickupItem(session, actor, item) {
    if (!actor || session?.actor !== actor || !actor.backpack ||
        actor.isDead?.() || actor.fetchIsOnline?.() === false) return false;
    if (!PartyCompanionService.canPickupLoot(session)) return false;
    const id     = item.fetchId();
    const spawnIndex = this.items.spawns.findIndex((spawn) => spawn.fetchId() === id);
    if (spawnIndex < 0) return false;

    const canonicalItem = this.items.spawns[spawnIndex];
    const selfId = canonicalItem.fetchSelfId();
    const amount = canonicalItem.fetchAmount();
    const allocations = selfId === 57
        ? PartyCompanionService.adenaAllocations(session, amount, canonicalItem)
        : [{ session: PartyCompanionService.resolveLootSession(session, selfId, canonicalItem), amount }];
    // Validate every recipient before claiming the drop, so a stale session
    // cannot crash the award or consume loot without receiving it.
    if (!allocations.length || allocations.some((entry) => !entry.session?.actor?.backpack ||
        entry.session.actor.isDead?.() || entry.session.actor.fetchIsOnline?.() === false)) return false;

    const releases = [];
    for (const entry of allocations) {
        const reservation = PickupCapacity.reserve(entry.session.actor, selfId, entry.amount, canonicalItem);
        if (!reservation.release) {
            releases.forEach(done => done());
            session.dataSendToMe(ServerResponse.actionFailed());
            if (reservation.reason === 'slots' || reservation.reason === 'weight') {
                ConsoleText.transmit(session, reservation.reason === 'slots'
                    ? ConsoleText.caption.inventoryFull : ConsoleText.caption.loadLimitExceeded);
            }
            return false;
        }
        releases.push(reservation.release);
    }

    // PickupExec resolves the ground object before the actor finishes moving.
    // A player and a bot can therefore both hold the same stale reference and
    // reach this method on adjacent timers. Removing the canonical spawn first
    // makes the claim atomic in the world event loop: only one caller may award
    // the item, distribute Adena, delete the object, or emit pickup text.
    const [claimedItem] = this.items.spawns.splice(spawnIndex, 1);

    let scheduled = 0;
    try {
        // Every client that got SpawnItem keeps the object until told, wherever
        // its player stands now; a range broadcast left ghosts to those who walked away.
        const deletePacket = ServerResponse.deleteOb(id);
        const recipients = NpcVisibility.recipientsOf(id);
        if (!this.isBotSession(session) && !recipients.includes(session)) recipients.push(session);
        recipients.forEach((recipient) => {
            try {
                recipient.dataSendToMe(deletePacket);
            }
            catch (error) {
                utils.infoWarn('PickupItem', 'failed to send DeleteObject for item %d: %s', id, error.message);
            }
        });
        allocations.forEach((entry, index) => {
            const award = this.purchaseItem(entry.session, selfId, entry.amount, selfId === 57 ? {} : {
                enchant: claimedItem.fetchEnchantLevel?.() ?? 0,
                ...(claimedItem.fetchPetData?.() ? { petData: claimedItem.fetchPetData() } : {})
            });
            scheduled++;
            if (award && typeof award.then === 'function') award.then(releases[index], releases[index]);
            else releases[index]();
            ConsoleText.transmitPickup(entry.session, selfId, entry.amount);
        });
    } finally {
        releases.slice(scheduled).forEach(release => release());
    }
    return true;
}

module.exports = pickupItem;
