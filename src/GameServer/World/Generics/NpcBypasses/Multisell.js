module.exports = function multisell(session, parts) {
    try {
        if (parts.length !== 2) throw Error('invalid_multisell_list');
        invoke('GameServer/Items/LuxuryShopService').open(session, Number(parts[1]));
    } catch (error) {
        session.dataSendToMe(invoke('GameServer/Network/Response').actionFailed());
    }
};
