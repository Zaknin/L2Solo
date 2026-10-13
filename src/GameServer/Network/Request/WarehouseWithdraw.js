const ServerResponse = invoke('GameServer/Network/Response');
const Warehouse = invoke('GameServer/Warehouse/PersonalWarehouse');
const ClanWarehouse = invoke('GameServer/Warehouse/ClanWarehouse');
// Same packet lines as a deposit: count, then objectId and amount per line.
const { lines } = invoke('GameServer/Network/Request/WarehouseDeposit');

module.exports = async function warehouseWithdraw(session, buffer) {
    try {
        const requested = lines(buffer);
        if (!requested) throw new Error('malformed warehouse withdrawal packet');
        const active = session.activeWarehouse;
        if (!active || active.mode !== 'withdraw') throw new Error('warehouse withdrawal window is not active');
        const clan = active.type === 'clan';
        const items = await (clan ? ClanWarehouse : Warehouse).withdraw(session, requested);
        session.dataSendToMe(ServerResponse.itemsList(session.actor.backpack.fetchItems()));
        session.dataSendToMe(ServerResponse.wareHouseWithdrawalList(
            items, session.actor.backpack.fetchTotalAdena(), clan ? 2 : 1
        ));
    } catch (error) {
        utils.infoWarn('Warehouse', 'withdraw rejected: %s', error.message);
        session.dataSendToMe(ServerResponse.actionFailed());
    }
};
