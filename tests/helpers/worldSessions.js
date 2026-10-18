'use strict';

// Party members are read from the world's who-where party group
// (PartyAwareness.partySessions -> World.pvpPartySessionsForKey),
// which only World.insertUser and World.refreshPartyMemberships fill. A plain
// `World.user = { sessions }` registers nobody, so fixtures register their
// sessions here as production does. Party fields (partyCompanion,
// followPlayerSession) set before registration are published with it; a
// fixture that changes them afterwards calls World.refreshPartyMemberships.
// Required after src/Global, like every test module that invokes.
const World = invoke('GameServer/World/World');

// One fixture session; keeps its accountId (a `bot_` prefix marks a bot).
function insertSession(session) {
    session.fetchAccountId ??= () => session.accountId ?? `fixture_${session.actor.fetchId()}`;
    World.insertUser(session);
    return session;
}

// A fresh user list holding exactly these sessions, in this order.
function registerSessions(sessions) {
    World.user = { sessions: [], revision: 0 };
    for (const session of sessions) insertSession(session);
    return World.user;
}

module.exports = { insertSession, registerSessions };
