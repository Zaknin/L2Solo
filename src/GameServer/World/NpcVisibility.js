const ServerResponse = invoke('GameServer/Network/Response');

const NPC_INFO_OPCODE = 0x16;
const SPAWN_ITEM_OPCODE = 0x0b;
const DELETE_OBJECT_OPCODE = 0x12;

// Ground items: which client holds which object since its SpawnItem, until a
// DeleteObject to that client or the session leaves the World. Inverted so a
// pickup reads its holders directly; `itemsBySession` lets removal skip a scan.
const itemHolders = new Map();
const itemsBySession = new WeakMap();

function holdItem(session, id) {
    let holders = itemHolders.get(id);
    if (!holders) itemHolders.set(id, holders = new Set());
    holders.add(session);
    let ids = itemsBySession.get(session);
    if (!ids) itemsBySession.set(session, ids = new Set());
    ids.add(id);
}

function releaseItem(session, id) {
    const holders = itemHolders.get(id);
    if (!holders?.delete(session)) return;
    if (!holders.size) itemHolders.delete(id);
    itemsBySession.get(session)?.delete(id);
}

function objectId(packet) {
    if (!packet || packet.length < 5 || typeof packet.readInt32LE !== 'function') {
        return null;
    }

    return packet.readInt32LE(1);
}

function trackNpcPacket(session, packet) {
    const id = objectId(packet);
    if (!session || id === null) return;

    if (packet[0] === NPC_INFO_OPCODE) {
        session.knownNpcIds ||= new Set();
        session.knownNpcIds.add(id);
    }
    else if (packet[0] === SPAWN_ITEM_OPCODE) {
        holdItem(session, id);
    }
    else if (packet[0] === DELETE_OBJECT_OPCODE) {
        session.knownNpcIds?.delete(id);
        releaseItem(session, id);
    }
}

// Online sessions whose client still shows ground item `id`, wherever they stand now.
function recipientsOf(id) {
    return [...(itemHolders.get(id) || [])].filter((session) => session.actor?.fetchIsOnline?.() === true);
}

function forgetSession(session) {
    const ids = itemsBySession.get(session);
    if (!ids) return;
    itemsBySession.delete(session);
    ids.forEach((id) => {
        const holders = itemHolders.get(id);
        holders?.delete(session);
        if (holders && !holders.size) itemHolders.delete(id);
    });
}

function npcRemovalRecipients(world, sourceSession, npcId) {
    const recipients = new Set();

    if (typeof sourceSession?.dataSendToMe === 'function') {
        recipients.add(sourceSession);
    }

    (world.user?.sessions || []).forEach((session) => {
        if (
            session?.actor?.fetchIsOnline?.() === true &&
            typeof session.dataSendToMe === 'function' &&
            session.knownNpcIds?.has(npcId)
        ) {
            recipients.add(session);
        }
    });

    return recipients;
}

function deleteKnownNpc(world, sourceSession, npcId, response = ServerResponse) {
    const packet = response.deleteOb(npcId);
    const recipients = npcRemovalRecipients(world, sourceSession, npcId);
    recipients.forEach((session) => {
        try {
            session.dataSendToMe(packet);
        }
        catch (error) {
            utils.infoWarn('NpcVisibility', 'failed to send DeleteObject for NPC %d: %s', npcId, error.message);
        }
    });
    return recipients.size;
}

module.exports = {
    deleteKnownNpc,
    forgetSession,
    npcRemovalRecipients,
    recipientsOf,
    trackNpcPacket
};
