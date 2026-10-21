const ServerResponse = invoke('GameServer/Network/Response');

// A client can retain a ground object after leaving the broadcast radius.
// Bind its known items to the actor, since a connection can change characters.
const knownItems = new WeakMap();

function trackPacket(session, packet) {
    if (!Buffer.isBuffer(packet) || packet.length < 5) return;
    const spawn = packet[0] === 0x0b && packet.length >= 33;
    if (!spawn && packet[0] !== 0x12) return;
    if (!session?.actor || session.botSession === true || String(session.accountId || '').startsWith('bot_')) return;

    let known = knownItems.get(session);
    if (known?.actor !== session.actor) {
        known = { actor: session.actor, ids: new Set() };
        knownItems.set(session, known);
    }
    const id = packet.readInt32LE(1);
    if (spawn) known.ids.add(id);
    else known.ids.delete(id);
}

function deleteKnownItem(world, id) {
    const packet = ServerResponse.deleteOb(id);
    for (const session of world.user?.sessions || []) {
        const known = knownItems.get(session);
        if (!known?.ids.has(id) || known.actor !== session.actor || session.actor.fetchIsOnline?.() !== true) continue;
        try {
            session.dataSendToMe(packet);
            known.ids.delete(id);
        } catch (error) {
            utils.infoWarn('GroundItem', 'failed to send DeleteObject for item %d: %s', id, error.message);
        }
    }
}

module.exports = { trackPacket, deleteKnownItem };
