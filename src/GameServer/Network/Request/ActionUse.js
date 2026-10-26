const ReceivePacket = invoke('Packet/Receive');

function actionUse(session, buffer) {
    const packet = new ReceivePacket(buffer);

    packet
        .readD()  // Action Id
        .readD()  // Ctrl
        .readC(); // Shift

    return consume(session, {
        actionId: packet.data[0],
            ctrl: packet.data[1],
           shift: packet.data[2],
    });
}

function consume(session, data) {
    return session.actor.basicAction(data);
}

module.exports = actionUse;
