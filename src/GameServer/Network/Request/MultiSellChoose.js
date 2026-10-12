const ReceivePacket = invoke('Packet/Receive');
const Response = invoke('GameServer/Network/Response');

module.exports = async function multiSellChoose(session, buffer) {
    try {
        if (buffer.length < 13) throw Error('invalid_multisell_packet');
        const packet = new ReceivePacket(buffer).readD().readD().readD();
        await invoke('GameServer/Items/LuxuryShopService').exchange(session, ...packet.data);
    } catch (error) {
        const message = { multisell_missing_materials: 351, multisell_inventory_full: 129, multisell_weight_limit: 422 }[error.message];
        if (message) session.dataSendToMe(Response.systemMessage(message));
        else if (!['invalid_multisell_packet', 'invalid_multisell_selection', 'luxury_shop_unavailable', 'multisell_interrupted'].includes(error.message))
            utils.infoWarn('MultiSell', 'exchange failed: %s', error.message);
    }
    session.dataSendToMe(Response.actionFailed());
};
