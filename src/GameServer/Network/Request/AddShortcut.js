const ServerResponse = invoke('GameServer/Network/Response');
const ReceivePacket  = invoke('Packet/Receive');
const Database       = invoke('Database');

function addShortcut(session, buffer) {
    const packet = new ReceivePacket(buffer);

    packet
        .readD()  // Kind
        .readD()  // Slot
        .readD()  // Id
        .readD(); // ?

    return consume(session, {
           kind: packet.data[0],
           slot: packet.data[1],
             id: packet.data[2],
        unknown: packet.data[3],
    });
}

function consume(session, data) {
    // The slot is the character's that set it; the reply is not sent after
    // Restart to another character on the same connection.
    const actor = session.actor;
    const characterId = actor.fetchId();

    if (data.kind === 2) {
        const skill = actor.skillset.fetchSkill(data.id);
        if (!skill || skill.fetchPassive()) {
            return;
        }
    }

    // setShortcut is an UPSERT on (characterId, slot), the table's primary key: it replaces the slot itself.
    return Database.setShortcut(characterId, data).then(() => {
        if (session.actor !== actor) return;
        session.dataSendToMe(
            ServerResponse.addShortcut({
                ...data,
                level: data.kind === 2 ? actor.skillset.fetchSkill(data.id)?.fetchLevel() ?? 1 : undefined
            })
        );
        if (data.kind === 2) session.dataSendToMe(ServerResponse.skillCoolTime(actor));
    });
}

module.exports = addShortcut;
