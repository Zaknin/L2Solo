// The resolver's usual cold cancel of a marked unopened raid party (its partyPatch
// dissolves the party) wakes the clan once, on the main thread, only after the
// dissolve is committed.
const assert = require('assert');
const EventEmitter = require('events');

require('../src/Global');
invoke('GameServer/DataCache').init();

const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Roster = require('../src/GameServer/Clan/ClanRaidRoster');
const ReviewEvents = require('../src/GameServer/Clan/ClanReviewEvents');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');

class FakeWorker extends EventEmitter {
    constructor() { super(); this.messages = []; }
    postMessage(message) { this.messages.push(message); }
    terminate() { return Promise.resolve(1); }
}

const ids = Array.from({ length: 9 }, (_, index) => index + 1);
const marker = { clanId: 7, ownerSection: 'goal', goalKey: 'g1', generation: 'v1', memberIds: ids,
    sourceId: 'raid:123', npcId: 123, raidInstanceId: 'spawn1', minPartySize: 9, maxPartySize: 9 };
const token = id => ({ characterId: id, ownerId: 'cold_simulation_owner', revision: 1,
    leaseId: `lease-${id}`, leaseUntil: Date.now() + 30000 });
const groupFor = (partyId, status, stats) => ({ id: `hunt:${partyId}`, memberIds: ids,
    partyChanges: [{ partyId, memberIds: ids, expectedUpdatedAt: 5, updatedAt: 6, nextResolveAt: null,
        status, statsJson: JSON.stringify(stats) }] });
const resultsFor = (group, ok, extra = {}) => ids.map(id => ({ ok, characterId: id, revision: 2, ...extra,
    proposal: { token: token(id), proposalId: `proposal-${group.id}-${id}`, atomicGroup: group } }));

async function legacyCases(cancelled, wakes) {
    const P = name => require(`../src/GameServer/Bot/Population/${name}`);
    const Raid = P('ColdRaidEncounter'), Authority = P('ColdRaidAuthority'), Parties = P('BackgroundPartyState');
    const Lifecycle = P('BackgroundPartyLifecycle'), Resolver = P('BackgroundPartyResolver');
    const Scope = invoke('GameServer/RaidBoss/RaidEncounterScope'), Database = invoke('Database');
    const saved = [[Raid, 'stage'], [Raid, 'acknowledge'], [Raid, 'abort'], [Authority, 'init'], [Authority, 'prepare'],
        [Authority, 'accept'], [Parties, 'acceptRow'], [Lifecycle, 'releaseMember'], [Resolver, 'resolve'], [Scope, 'decorateSpot'],
        [Database, 'clanRaidOwner'], [Owner, 'claimBatch'], [Owner, 'commitAndReleaseBatch'], [LifeState, 'prepareResolve']]
        .map(([target, key]) => [target, key, target[key]]);
    let commitOk = true;
    let patch = null;
    try {
        Raid.stage = async (_, run) => ({ result: run() });
        Raid.acknowledge = () => {}; Raid.abort = () => {};
        Authority.init = async () => {}; Authority.prepare = () => true; Authority.accept = () => {};
        Parties.acceptRow = row => row;
        Lifecycle.releaseMember = state => state;
        Scope.decorateSpot = spot => spot;
        Database.clanRaidOwner = () => null;
        Owner.claimBatch = async members => ({ grants: members.map(member => token(member.characterId)) });
        Owner.commitAndReleaseBatch = async entries => entries.map(entry => ({ ok: commitOk, characterId: entry.nextState.characterId,
            detail: commitOk ? undefined : 'stale_revision', raidPartyRow: { partyId: 'L1', status: entry.atomicGroup.partyChanges[0].status } }));
        LifeState.prepareResolve = async state => state;
        Resolver.resolve = ({ members }) => ({ atomic: true, events: [], nextResolveAt: null, debug: { reason: patch.stats.partyBreakReason },
            memberResults: members.map(state => ({ state, result: { patch: {}, events: [], materialize: { exp: 0, sp: 0, adena: 0, items: [] } } })),
            partyPatch: patch });
        const party = { partyId: 'L1', leaderId: 1, status: 'active', memberIds: ids, updatedAt: 5, stats: { objective: { fullRoster: marker } } };
        const members = ids.map(id => ({ characterId: id, level: 40, phase: 'cold', stats: {}, inventory: {} }));
        const spot = { id: 'raid:123', raidBoss: true, raidWorldAvailable: true, raidAuthorityRevision: 0 };
        const run = () => require('../src/GameServer/Bot/Population/ColdRaidLegacyCommit').resolve({ party, members, spot, targetNpcId: 123, elapsedMs: 1000 });

        patch = { status: 'dissolved', stats: { partyBreakReason: cancelled.partyBreakReason, dissolvedAt: 1 } };
        assert((await run()).ok);
        assert.deepStrictEqual(wakes, [[7, 'raid_cancelled']]);
        // A rejected commit wakes nothing (cancelUnopened is stubbed out here).
        wakes.length = 0; commitOk = false;
        assert(!(await run()).ok);
        assert.deepStrictEqual(wakes, []);
        // A committed dissolve for another reason does not wake.
        commitOk = true; patch = { status: 'dissolved', stats: { partyBreakReason: 'raid_unavailable', dissolvedAt: 1 } };
        assert((await run()).ok);
        assert.deepStrictEqual(wakes, []);
    } finally {
        for (const [target, key, value] of saved) target[key] = value;
    }
}

(async () => {
    const originals = { cachedState: LifeState.cachedState, releaseBatch: Owner.releaseBatch, cancelUnopened: Roster.cancelUnopened };
    const states = new Map(ids.map(id => [id, { characterId: id, level: 40, phase: 'cold', activity: 'hunting',
        loc: { locX: 10, locY: 20, locZ: -30 }, stats: {}, inventory: {} }]));
    LifeState.cachedState = id => states.get(Number(id)) || null;
    Owner.releaseBatch = async tokens => tokens.map(item => ({ ok: true, characterId: item.characterId }));
    const cancels = [];
    Roster.cancelUnopened = async (party, reason) => { cancels.push([party?.partyId, reason]); return false; };
    const wakes = [];
    const unsubscribe = ReviewEvents.subscribe((clanId, cause) => wakes.push([clanId, cause]));
    try {
        const coordinator = new ColdSimulationCoordinator({ WorkerClass: FakeWorker, workerPath: 'fake-worker.js' });
        coordinator.routeFor = () => null;
        coordinator.postCollections = () => 1;
        await ReviewEvents.drain(null, 1000);

        const cancelled = { objective: { fullRoster: marker }, partyBreakReason: 'raid_roster_source_changed', dissolvedAt: 1 };
        // Nine committed member results of one dissolved party: one wake.
        await coordinator.handleCommitResults(resultsFor(groupFor('p1', 'dissolved', cancelled), true));
        assert.deepStrictEqual(wakes, [[7, 'raid_cancelled']]);
        assert.deepStrictEqual(await ReviewEvents.drain(null), [{ clanId: 7, causes: ['raid_cancelled'] }]);
        assert.deepStrictEqual(cancels, []);

        // The same dissolve rejected by the commit: no wake from this path.
        wakes.length = 0;
        await coordinator.handleCommitResults(resultsFor(groupFor('p2', 'dissolved', cancelled), false, { reason: 'stale_revision' }));
        assert.deepStrictEqual(wakes, []);

        // A clan departure (owner changed) wakes too; a non-cancel dissolve, an unmarked
        // party and a marked party that stays active do not.
        await coordinator.handleCommitResults([
            ...resultsFor(groupFor('p3', 'dissolved', { ...cancelled, partyBreakReason: 'raid_roster_owner_changed' }), true),
            ...resultsFor(groupFor('p4', 'dissolved', { ...cancelled, partyBreakReason: 'raid_unavailable' }), true),
            ...resultsFor(groupFor('p5', 'dissolved', { partyBreakReason: 'raid_roster_source_changed' }), true),
            ...resultsFor(groupFor('p6', 'active', { objective: { fullRoster: marker } }), true)
        ]);
        assert.deepStrictEqual(wakes, [[7, 'raid_cancelled']]);

        // The shared rule used by cancelUnopened and the main-thread commit paths.
        assert.strictEqual(Roster.wakeCancelled({ stats: cancelled }), true);
        assert.strictEqual(Roster.wakeCancelled({ stats: cancelled }, 'raid_unavailable'), false);
        assert.strictEqual(Roster.wakeCancelled({ stats: { partyBreakReason: 'raid_roster_not_opened' } }), false);
        await ReviewEvents.drain(null, 1000);

        // The main-thread raid fallback commits the same resolver cancel.
        wakes.length = 0;
        await legacyCases(cancelled, wakes);
        console.log('Clan raid cancel commit wake test passed.');
    } finally {
        unsubscribe();
        LifeState.cachedState = originals.cachedState;
        Owner.releaseBatch = originals.releaseBatch;
        Roster.cancelUnopened = originals.cancelUnopened;
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
