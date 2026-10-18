'use strict';

const assert = require('node:assert/strict');
const nativeFixture = require('./helpers/isolatedSocialDatabase')('f1-spatial-test_n62_pvp_actor_lookup');
require('../src/Global');
nativeFixture.assertConfigured(options.default);
const World = invoke('GameServer/World/World');
const Actor = invoke('GameServer/Model/Actor');
const Index = invoke('GameServer/Bot/AI/BotPvpIndex');
const Threats = invoke('GameServer/Bot/AI/BotPvpThreats');
const previousUser = World.user;
const realNow = Date.now;
let now = realNow(), serial = 8_900_000;
const loc = { locX: 0, locY: 0, locZ: -3400 };

function register(properties = {}) {
    const id = properties.id ?? ++serial;
    const accountId = properties.accountId ?? `player_pvp_lookup_${id}`;
    const session = { accountId, fetchAccountId() { return this.accountId; } };
    session.actor = new Actor({ id, name: accountId, username: accountId, clanId: 0,
        isOnline: false, ...loc, ...properties });
    session.actor.session = session;
    World.insertUser(session);
    session.actor.setIsOnline(true);
    return session;
}

function instrument(session) {
    const reads = { actor: 0, coordinates: 0 };
    let actor = session.actor;
    Object.defineProperty(session, 'actor', { configurable: true,
        get() { reads.actor++; return actor; }, set(value) { actor = value; } });
    for (const key of ['fetchLocX', 'fetchLocY', 'fetchLocZ']) {
        const original = actor[key];
        actor[key] = function() { reads.coordinates++; return original.call(this); };
    }
    return reads;
}

function reset(reads) { for (const row of reads) row.actor = row.coordinates = 0; }
function totals(reads) {
    return reads.reduce((sum, row) => ({ actor: sum.actor + row.actor,
        coordinates: sum.coordinates + row.coordinates }), { actor: 0, coordinates: 0 });
}

try {
    assert.equal(invoke('Database').isReady(), false, 'fixture never opens a database or initializes World');
    Date.now = () => now;
    World.user = { sessions: [], revision: 0 };
    const target = register(), id = target.actor.fetchId();
    const originalActor = target.actor;
    assert.equal(Index.actor(String(id)), originalActor, 'numeric caller ids select the exact registered actor');
    assert.equal(Index.actor(id + 1000), null);
    assert.equal(Index.actor(NaN), null);
    target.actor.setIsOnline(false);
    assert.equal(Index.actor(id), originalActor, 'raw identity lookup also retains offline actors');
    target.actor.setIsOnline(true);
    World.retireUserActor(target, originalActor);
    assert.equal(World.registeredActorById(id).retired, true);
    assert.equal(Index.actor(id), originalActor, 'terminal spatial retirement does not change raw PvP identity');
    assert(!World.realPlayerSessionsNear(loc, 100).includes(target));
    World.insertUser(target);
    target.actor.setLocXYZ({ ...loc, locZ: NaN });
    assert.equal(Index.actor(id), originalActor, 'raw lookup has no new coordinate or floor eligibility filter');
    target.actor.setLocXYZ(loc);
    World.removeUser(target);
    assert.equal(Index.actor(id), null, 'explicit removal invalidates immediately');
    World.insertUser(target);
    const replacement = register({ id, accountId: target.accountId });
    assert.equal(Index.actor(id), replacement.actor, 'replacement is current without waiting for the old snapshot TTL');
    World.removeUser(target);
    World.retireUserActor(target, originalActor);
    originalActor.setLocXYZ({ ...loc, locX: 30_000 });
    originalActor.setIsOnline(true);
    assert.equal(Index.actor(id), replacement.actor, 'late old-source cleanup and setters cannot reclaim a replacement');
    replacement.actor.setId(id + 1);
    assert.equal(Index.actor(id), null, 'the selected current actor id is revalidated');
    replacement.actor.setId(id);
    World.updateUserLocation(replacement);
    assert.equal(Index.actor(id), replacement.actor);
    assert.equal(Threats.character({ fetchKind: () => 'Summon', fetchOwnerId: () => id }), replacement.actor,
        'the real summon-owner consumer resolves the registered owner');
    assert.equal(Threats.character({ fetchKind: () => 'Summon', fetchOwnerId: () => id + 1000 }), null);
    console.log('PASS native registered identity, offline/terminal, removal/replacement/late source and summon-owner controls');

    const companion = register();
    companion.partyCompanion = true; companion.followPlayerSession = replacement;
    const partyA = register(), partyB = register(), forming = register();
    partyA.coldLifeState = partyB.coldLifeState = { party: { partyId: 'pvp_lookup_party' } };
    forming.coldLifeState = { party: { partyId: 'forming' } };
    World.refreshPartyMemberships([companion, partyA, partyB, forming]);
    assert.deepEqual(Index.members(replacement), [replacement, companion]);
    assert.deepEqual(Index.members(companion), [companion, replacement]);
    assert.deepEqual(Index.members(partyA), [partyA, partyB]);
    assert.deepEqual(Index.members(forming), [forming]);
    companion.followPlayerSession = forming;
    World.refreshPartyMemberships([companion]);
    assert.deepEqual(Index.members(replacement), [replacement], 'a companion that follows another leader leaves the old party');
    assert.deepEqual(Index.members(forming), [forming, companion]);
    console.log('PASS unchanged follow-player/background/forming party membership');

    const unrelated = Array.from({ length: 64 }, (_, n) => instrument(register({ locX: 100_000 + n * 6000 })));
    reset(unrelated);
    assert.equal(Index.actor(id), replacement.actor);
    assert.deepEqual(totals(unrelated), { actor: 0, coordinates: 0 },
        'direct actor lookup must never read distant unrelated registered owners');
    assert.equal(invoke('Database').isReady(), false);
    console.log('PASS indexed PvP actor lookup; zero unrelated-owner reads and no database/server');
} finally {
    Date.now = realNow;
    World.user = previousUser;
    require('node:fs').rmSync(nativeFixture.directory, { recursive: true, force: true });
}
