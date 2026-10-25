const ServerResponse = invoke('GameServer/Network/Response');
const ReceivePacket  = invoke('Packet/Receive');

function unequipItem(session, buffer) {
    const packet = new ReceivePacket(buffer);

    packet
        .readD(); // Gear Slot

    consume(session, {
        slot: packet.data[0]
    });
}

function consume(session, data) {
    session.actor.backpack.unequipGear(session, Math.log2(data.slot));
    session.dataSendToMe(ServerResponse.userInfo(session.actor));
    session.dataSendToOthers(ServerResponse.charInfo(session.actor), session.actor);
    session.dataSendToMe(ServerResponse.itemsList(session.actor.backpack.fetchItems()));
}

module.exports = unequipItem;
