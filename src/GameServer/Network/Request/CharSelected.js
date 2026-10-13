const ServerResponse = invoke('GameServer/Network/Response');
const Shared         = invoke('GameServer/Network/Shared');
const ReceivePacket  = invoke('Packet/Receive');

function charSelected(session, buffer) {
    const packet = new ReceivePacket(buffer);

    packet
        .readD(); // Character Slot

    return consume(session, {
        characterSlot: packet.data[0]
    });
}

function consume(session, data) {
    // The reads below finish later. By then a newer selection may have
    // started or the connection may be gone; this one then creates nothing.
    const selection = session.characterSelection = (session.characterSelection || 0) + 1;

    return Shared.fetchCharacters(session.accountId).then((characters) => {
        const character = characters[data.characterSlot];

        return Shared.fetchClassInformation(character.classId).then((classInfo) => {
            if (session.characterSelection !== selection || session.socket?.destroyed) return;

            // Create a new actor instance with info
            session.setActor({
                ...character, ...utils.crushOb(classInfo)
            });

            session.dataSendToMe(
                ServerResponse.charSelected(session.actor)
            );
        });
    });
}

module.exports = charSelected;
