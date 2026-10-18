const ManufactureShop = invoke('GameServer/Crafting/ManufactureShop');
const ServerResponse = invoke('GameServer/Network/Response');

module.exports = (session) => {
    const actor = session?.actor;
    if (!actor || Number(actor.fetchPrivateStoreType?.()) !== ManufactureShop.MANUFACTURE_MANAGE) return;
    actor.setPrivateStoreType(0);
    session.dataSendToMe?.(ServerResponse.userInfo(actor));
    session.dataSendToOthers?.(ServerResponse.charInfo(actor), actor);
};
