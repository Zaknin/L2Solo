// A member who left the clan is a roster owner change (cancels the party);
// transient member states stay retryable member changes.
const assert = require('assert');

require('../src/Global');

const Roster = require('../src/GameServer/Clan/ClanRaidRoster');

const ids = Array.from({ length: 9 }, (_, index) => index + 1);
const marker = { clanId: 7, ownerSection: 'goal', goalKey: 'g1', generation: 'v1', memberIds: ids,
    sourceId: 'raid:123', npcId: 123, raidInstanceId: 'spawn1', minPartySize: 9, maxPartySize: 9 };
const party = { partyId: 'p1', status: 'hot', memberIds: ids, spotId: marker.sourceId, stats: { objective: { fullRoster: marker } } };
const spot = { id: 'raid:123', raidBossTemplateId: 123, raidInstanceId: 'spawn1', raidWorldAvailable: true };
const freshMembers = () => ids.map(id => ({ characterId: id, classId: 1, clanId: 7, level: 50, phase: 'hot',
    partyId: 'p1', vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, stats: {} }));
const freshOwner = () => ({ mode: 'autonomous', marker, members: ids.map(id => [id, 1, 7, 50, false]) });
const options = owner => ({ owner, phase: 'hot', arrived: false });

function reason(change) {
    const members = freshMembers(), owner = freshOwner();
    change(members, owner);
    const result = Roster.admission(party, members, spot, options(owner));
    assert.strictEqual(result.ok, false);
    return result.reason;
}

// Control: an unchanged roster passes the member checks (it only waits for arrival).
assert.strictEqual(reason(() => {}), 'party_assembling');

// Clan departure: the member row, the owner row, or a missing owner row.
assert.strictEqual(reason(members => { members[8].clanId = 0; }), 'raid_roster_owner_changed');
assert.strictEqual(reason((members, owner) => { owner.members[8][2] = 0; }), 'raid_roster_owner_changed');
assert.strictEqual(reason((members, owner) => { owner.members.pop(); }), 'raid_roster_owner_changed');

// Transient member states keep the retryable reason.
assert.strictEqual(reason(members => { members[0].classId = 2; }), 'raid_roster_member_changed');
assert.strictEqual(reason(members => { members[0].level = 51; }), 'raid_roster_member_changed');
assert.strictEqual(reason((members, owner) => { owner.members[0][4] = true; }), 'raid_roster_member_changed');
assert.strictEqual(reason(members => { members[0].vitals.hp = 0; }), 'raid_roster_member_changed');
assert.strictEqual(reason(members => { members[0].stats.travel = { to: 1 }; }), 'raid_roster_member_changed');
assert.strictEqual(reason(members => { members[0].stats.tradeMeeting = { id: 1 }; }), 'raid_roster_member_changed');
assert.strictEqual(reason(members => { members[0].stats.playerPartyTakeover = true; }), 'raid_roster_member_changed');
assert.strictEqual(reason(members => { members[0].phase = 'cold'; }), 'raid_roster_member_changed');
assert.strictEqual(reason(members => { members[0].partyId = 'other'; }), 'raid_roster_member_changed');

console.log('Clan raid roster departure test passed.');
