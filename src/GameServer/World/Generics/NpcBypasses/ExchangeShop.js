const Response = invoke('GameServer/Network/Response');

// Keep old main-dialog links usable, but purchases use the C4 request packet.
module.exports = function exchangeShop(session, parts) {
    try {
        if (parts[1] !== 'npc') throw Error('invalid_exchange_shop_action');
        invoke('GameServer/Items/LuxuryShopService').open(session);
    } catch (error) {
        session.dataSendToMe(Response.actionFailed());
    }
};
