const ServerResponse = invoke('GameServer/Network/Response');
const Item           = invoke('GameServer/Item/Item');
const DataCache      = invoke('GameServer/DataCache');

function spawnItem(session, selfId, amount, coords, onSpawn) {
    DataCache.fetchItemFromSelfId(selfId, (itemDetails) => {
        const item = new Item(this.items.nextId++, { ...utils.crushOb(itemDetails), ...coords });
        item.setAmount(amount);
        this.items.spawns.push(item);
        const packet = ServerResponse.spawnItem(item);
        // The players who got SpawnItem are the ones whose client keeps the
        // object until a DeleteObject; PickupItem sends it to them by name.
        const recipients = this.fetchVisibleRealPlayers(null, item);
        if (session && !this.isBotSession(session) && !recipients.includes(session)) recipients.push(session);
        recipients.forEach(recipient => recipient.dataSendToMe(packet));
        item.viewers = recipients.length ? recipients : null;
        onSpawn?.(item);
    });
}

module.exports = spawnItem;
