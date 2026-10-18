// Party membership and actor lookups read the World's current registrations
// (the party index); no spatial eligibility is added here.
function actor(id) {
    const lookup = Number(id);
    const registered = invoke('GameServer/World/World').registeredActorById(lookup);
    const current = registered?.actor;
    return Number(current?.fetchId?.()) === lookup ? current : null;
}

function members(session) {
    const World = invoke('GameServer/World/World');
    const found = new Set([session, session?.partyCompanion ? session.followPlayerSession : null]);
    for (const key of World.pvpPartyMembershipKeys(session)) {
        for (const member of World.pvpPartySessionsForKey(key)) found.add(member);
    }
    return [...found].filter(Boolean);
}

module.exports = { actor, members };
