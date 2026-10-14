const assert = require('assert');
require('../src/Global');
const Party = invoke('GameServer/Bot/AI/HotBackgroundParty');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const World = invoke('GameServer/World/World');
const Awareness = invoke('GameServer/Bot/AI/PartyAwareness');
const Tactics = invoke('GameServer/Bot/AI/BotPvpTactics');
const Restrictions = invoke('GameServer/Effects/EffectRestrictions');
const Raid = invoke('GameServer/Bot/AI/BotRaidSafety');
const Spots = invoke('GameServer/Bot/AI/SpotService');
const Travel = invoke('GameServer/Bot/AI/BotSpotTravel');
const TownTransit = invoke('GameServer/Bot/AI/TownTransitPolicy');
const Generics = invoke(path.actor);
const Geo = invoke('GameServer/Geodata/GeodataEngine');
const saved = [];
function replace(object, key, value) { const old = object[key]; saved.push(() => object[key] = old); object[key] = value; }
// x < 4000 is inside the party's spot; a bot with `town` stands in a town.
function actor(id, x = 0, kind = null) {
    return { x, hp: 100, town: false, fetchId: () => id, fetchSelfId: () => id, fetchKind: kind ? () => kind : undefined,
        fetchLocX() { return this.x; }, fetchLocY: () => 0, fetchLocZ: () => 0,
        fetchHp() { return this.hp; }, fetchMaxHp: () => 100, fetchMp: () => 100, fetchMaxMp: () => 100,
        fetchLevel: () => 20, fetchIsOnline: () => true, isDead() { return this.hp <= 0; },
        state: { seated: false, fetchSeated() { return this.seated; }, setSeated(v) { this.seated = v; } },
        automation: { replenishVitals() {} }, select() {}, moveTo(coords) { this.moved = true; this.move = coords; } };
}
try {
    replace(Geo, 'hasLineOfSight', () => true);
    const group = [1, 2, 3].map(id => ({ accountId: `bot_hot_anchor_${id}`, fetchAccountId() { return this.accountId; },
        hotBackgroundPartyId: 'anchor', actor: actor(id), dataSendToOthers() {} }));
    const [leader, healer, follower] = group;
    const party = { partyId: 'anchor', leaderId: 1, memberIds: [1, 2, 3], status: 'hot', spotId: 'S',
        stats: { objective: { npcId: 20 } } };
    const spot = { id: 'S', arrivalPoints: [] };
    replace(Parties, 'find', () => party);
    replace(World, 'user', { sessions: [], revision: 0 });
    group.forEach(session => World.insertUser(session));
    replace(World, 'fetchNpcsInRadius', () => []);
    replace(Awareness, 'npcThreateningActor', s => s.incoming || null);
    replace(Restrictions, 'canUseBasicAction', () => true);
    replace(Restrictions, 'canMove', () => true);
    replace(Raid, 'isProtectedRaidEntity', () => false);
    replace(Tactics, 'stop', () => {});
    replace(Tactics, 'support', () => false);
    replace(Spots, 'findById', () => spot);
    replace(Spots, 'containsLocation', (_spot, point) => point.locX < 4000);
    replace(TownTransit, 'townAt', a => a.town ? 'Giran' : null);
    const travel = { start: [], tick: [] };
    let startResult = true;
    replace(Travel, 'start', (s, a, to, at) => { travel.start.push([s, a, to, at]); return startResult; });
    replace(Travel, 'tick', (s) => { travel.tick.push(s); return true; });
    const AI = { executeCombat() {} };
    const tick = (s, now = 20000) => Party.tick(s, s.actor, Generics, AI, now);

    // A member restarted in town is not waited for: the leader keeps searching.
    follower.actor.x = 50000; follower.actor.town = true;
    tick(leader);
    assert.notStrictEqual(leader.lastDecision.action, 'party_wait_roster', 'the leader does not wait for a member in town');
    // A member at the spot but away from the leader is still waited for.
    follower.actor.x = 1500; follower.actor.town = false;
    tick(leader, 21000);
    assert.strictEqual(leader.lastDecision.action, 'party_wait_roster', 'the leader waits for a member at the spot');

    // The town member returns to the party's spot by gatekeeper, not toward the leader.
    follower.actor.x = 50000; follower.actor.town = true;
    tick(follower);
    assert.strictEqual(travel.start.length, 1, 'a town-restarted member starts the gatekeeper travel');
    assert.deepStrictEqual([travel.start[0][0], travel.start[0][2]], [follower, spot], 'to the party spot');
    assert.strictEqual(follower.lastDecision.action, 'party_return_to_spot');
    assert(!follower.actor.moved, 'the member does not walk toward the leader');
    follower.spotRelocation = { method: 'town_gatekeeper' };
    tick(follower, 21000);
    assert.deepStrictEqual(travel.tick, [follower], 'a running travel is ticked by the party controller');
    assert.strictEqual(travel.start.length, 1);
    follower.spotRelocation = undefined;
    startResult = false;
    tick(follower, 22000);
    assert(!follower.actor.moved, 'a refused travel (retry cooldown) idles instead of walking to town');
    startResult = true;

    // The leader is the one in town: the member at the spot regroups to the first member there.
    leader.actor.x = 50000; leader.actor.town = true;
    follower.actor.x = 3000; follower.actor.town = false;
    healer.actor.x = 100;
    follower.actor.moved = false;
    tick(follower, 23000);
    assert.strictEqual(follower.actor.move.to.locX, 100, 'members regroup at the first member at the spot, not at the leader');
    travel.start.length = 0;
    tick(leader, 23000);
    assert.strictEqual(travel.start.length, 1, 'the leader in town returns to the spot too');
    // The member at the spot leads the hunt meanwhile: no pull waits for the leader in town.
    healer.nextBackgroundTargetScanAt = 0;
    tick(healer, 24000);
    assert.notStrictEqual(healer.lastDecision.action, 'party_wait', 'the member at the spot is not parked behind the leader in town');

    // E73: a member in town goes back even while the party fights (the
    // party's incoming mob is no target for it), lands beside the member who
    // leads at the spot and drops a target held from before, which would
    // otherwise cancel the travel as combat.
    leader.actor.x = 100; leader.actor.town = false;
    healer.actor.x = 200;
    follower.actor.x = 50000; follower.actor.town = true;
    follower.spotRelocation = undefined; follower.currentTargetId = 4242; follower.actor.moved = false;
    const mob = { ...actor(900, 300, 'Monster'), fetchAttackable: () => true };
    leader.incoming = mob;
    travel.start.length = 0;
    tick(follower, 25000);
    assert.strictEqual(follower.lastDecision.action, 'party_return_to_spot', 'the party fight does not hold a member in town');
    assert.strictEqual(travel.start.length, 1);
    assert.strictEqual(travel.start[0][3].locX, 100, 'it returns beside the leader at the spot, not to the spot centre');
    assert.strictEqual(follower.currentTargetId, undefined, 'a stale target does not cancel the travel');
    assert(!follower.actor.moved, 'it does not walk from town toward the party mob');
    leader.incoming = null;

    // E73: the leader stepping over the spot cell edge stays the leader: the
    // others regroup to it instead of electing the first member inside.
    leader.actor.x = 4500;
    follower.actor.x = 100; follower.actor.town = false;
    tick(follower, 26000);
    assert.strictEqual(follower.lastDecision.action, 'party_regroup', 'the leader past the cell edge still leads');
    assert.strictEqual(follower.actor.move.to.locX, 4500);
    // ...but a leader travelling back from town does not lead.
    leader.spotRelocation = { method: 'town_gatekeeper' };
    follower.actor.moved = false;
    tick(follower, 27000);
    assert.notStrictEqual(follower.lastDecision.action, 'party_regroup', 'a leader on its way back from town is not followed');
    leader.spotRelocation = undefined;
    console.log('Hot background party anchor: roster wait, regroup point and return from town passed');
} finally { saved.reverse().forEach(restore => restore()); }
