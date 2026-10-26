'use strict';
// One reader answers "who is in this party": a player's party comes from the
// world's party index (only its members, not every session), living members by
// default, the dead too with includeDead. Raid competitors of one boss come
// from the party table by boss.
const assert = require('node:assert/strict');
require('../src/Global');

const World = invoke('GameServer/World/World');
const PartyAwareness = invoke('GameServer/Bot/AI/PartyAwareness');
const PartyCombatState = invoke('GameServer/Bot/AI/PartyCombatState');
const PartyRevivalService = invoke('GameServer/Bot/AI/PartyRevivalService');
const PartyPulling = invoke('GameServer/Bot/AI/PartyPulling');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const { registerSessions } = require('./helpers/worldSessions');

function actor(id) {
    const value = { id, dead: false };
    return Object.assign(value, {
        fetchId: () => id,
        fetchIsOnline: () => true,
        fetchLocX: () => 0,
        fetchLocY: () => 0,
        isDead: () => value.dead,
        state: { fetchDead: () => value.dead }
    });
}

const ids = sessions => sessions.map(session => session.actor.fetchId());
const originalUsers = World.user;
try {
    const leader = { actor: actor(1), accountId: 'player_1' };
    const fighter = { actor: actor(2), accountId: 'bot_2', partyCompanion: true, followPlayerSession: leader };
    const fallen = { actor: actor(3), accountId: 'bot_3', partyCompanion: true, followPlayerSession: leader };
    const stranger = { actor: actor(4), accountId: 'bot_4' };
    const otherLeader = { actor: actor(5), accountId: 'player_5' };
    const otherCompanion = { actor: actor(6), accountId: 'bot_6', partyCompanion: true, followPlayerSession: otherLeader };
    registerSessions([stranger, leader, otherLeader, fighter, otherCompanion, fallen]);
    fallen.actor.dead = true;

    assert.deepEqual(ids(PartyAwareness.partySessions(leader)), [1, 2], 'a party read keeps the online living members');
    assert.deepEqual(ids(PartyAwareness.partySessions(leader, { includeDead: true })), [1, 2, 3],
        'includeDead keeps a dead companion');
    assert.deepEqual(ids(PartyCombatState.partySessions(leader, { includeDead: true })), [1, 2, 3]);
    assert.deepEqual(ids(PartyRevivalService.partySessions(leader)), [1, 2, 3], 'revival sees the dead companion');
    assert.equal(PartyPulling.hasDeadPartyMember(leader), true);
    assert.deepEqual(ids(PartyAwareness.partySessions(otherLeader, { includeDead: true })), [5, 6]);

    fallen.actor.dead = false;
    assert.equal(PartyPulling.hasDeadPartyMember(leader), false);
    fighter.partyCompanion = false;
    World.refreshPartyMemberships([fighter]);
    assert.deepEqual(ids(PartyAwareness.partySessions(leader)), [1, 3], 'a dismissed companion leaves the party read');

    const unregistered = { actor: actor(7), accountId: 'player_7' };
    const follower = { actor: actor(8), accountId: 'bot_8', partyCompanion: true, followPlayerSession: unregistered };
    registerSessions([follower]);
    assert.deepEqual(ids(PartyAwareness.partySessions(unregistered)), [7, 8], 'a leader not yet registered goes first');
    console.log('PASS party member reader: index group only, dead flag, dismissal, unregistered leader');
} finally {
    World.user = originalUsers;
}

function raidRow(partyId, status, objective) {
    return { partyId, status, memberIdsJson: '[101,102]', statsJson: JSON.stringify({ objective }) };
}
const boss = { sourceKind: 'raid', raidBossTemplateId: 25001 };
Parties.acceptRow(raidRow('raid_a', 'active', boss));
Parties.acceptRow(raidRow('raid_b', 'active', { sourceKind: 'raid', npcId: 25001 }));
Parties.acceptRow(raidRow('raid_c', 'hot', boss));
Parties.acceptRow(raidRow('raid_d', 'active', { sourceKind: 'raid', raidBossTemplateId: 25002 }));
Parties.acceptRow(raidRow('hunt_e', 'active', { sourceKind: 'hunt', npcId: 25001 }));
Parties.acceptRow(raidRow('raid_f', 'active', boss));

const competitors = (status, except) => Parties.raidCompetitors(25001, status, except).map(party => party.partyId);
assert.equal(Parties.raidBossKey(Parties.find('raid_b')), 25001, 'npcId names the boss without a template id');
assert.equal(Parties.raidBossKey(Parties.find('hunt_e')), 0, 'a hunt is no raid party');
assert.deepEqual(competitors('active', 'raid_a'), ['raid_b', 'raid_f'], 'the active parties of one boss, without the asking party');
assert.deepEqual(competitors('hot', 'raid_a'), ['raid_c'], 'the hot parties of one boss');
Parties.acceptRow(raidRow('raid_b', 'active', { sourceKind: 'raid', npcId: 25001, note: 'changed' }));
assert.deepEqual(competitors('active', 'raid_a'), ['raid_f', 'raid_b'], 'the last accepted change goes last, as in active()');
Parties.acceptRow(raidRow('raid_c', 'active', boss));
assert.deepEqual(competitors('hot', 'raid_a'), [], 'a party that left hot is no hot competitor');
assert.deepEqual(competitors('active', 'raid_a'), ['raid_f', 'raid_b', 'raid_c']);
Parties.acceptRow(raidRow('raid_f', 'dissolved', boss));
assert.deepEqual(competitors('active', 'raid_a'), ['raid_b', 'raid_c'], 'a dissolved party leaves the competitors');
console.log('PASS raid competitors: one boss, by status, in order of last change, dissolved out');
