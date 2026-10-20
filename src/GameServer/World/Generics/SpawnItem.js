const ServerResponse = invoke('GameServer/Network/Response');
const Item           = invoke('GameServer/Item/Item');
const DataCache      = invoke('GameServer/DataCache');

function spawnItem(session, selfId, amount, coords, onSpawn) {
    DataCache.fetchItemFromSelfId(selfId, (itemDetails) => {
        const item = new Item(this.items.nextId++, { ...utils.crushOb(itemDetails), ...coords });
        item.setAmount(amount);
        this.items.spawns.push(item);
        const packet = ServerResponse.spawnItem(item);
        // Per-recipient dataSendToMe: NpcVisibility records each client that
        // got the item, and PickupItem deletes it from exactly those clients.
        // A bot session's dataSendToMe drops the packet, so the dropper needs no check.
        const recipients = this.fetchVisibleRealPlayers(null, item);
        if (session && !recipients.includes(session)) recipients.push(session);
        recipients.forEach(recipient => recipient.dataSendToMe(packet));
        onSpawn?.(item);
    });
}

module.exports = spawnItem;
