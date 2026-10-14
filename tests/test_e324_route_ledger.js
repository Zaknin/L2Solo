const assert = require('assert');

require('../src/Global');

// E324: the main thread hands each cold bot its route in the context it sends
// the worker; the trip is committed only at the bot's next resolve, seconds
// later. A route handed out keeps its place in the occupancy the next
// contexts are routed with, across the one-second occupancy rebuilds, until
// the bot's commit lands, the bot gets another context, or it expires. The
// main admission and its capacity hold stay as they were.

const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const SpotRiskPolicy = invoke('GameServer/Bot/Population/SpotRiskPolicy');
const DataCache = invoke('GameServer/DataCache');
const {
    ColdSimulationCoordinator,
    admitSoloRouteTravelState
} = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');

DataCache.init();

const original = {
    ensure: SpotProfiles.ensure,
    currentOccupancy: SpotProfiles.currentOccupancy,
    findForState: SpotProfiles.findForState,
    findCurrentSpot: SpotService.findCurrentSpot,
    arrivalPointForState: SpotService.arrivalPointForState,
    now: Date.now
};

const level = 16;
const spot = (id, gx, extra = {}) => ({
    id, name: `Field ${id}`, center: { locX: gx * 6000, locY: -176000, locZ: -1000 },
    minLevel: level - 2, maxLevel: level + 4, avgLevel: level + 1, density: 12,
    levelCounts: { [level]: 6, [level + 2]: 6 }, ...extra
});
const current = spot('starter-field', 20);
// Capacity 4 with two hunters already there: two free places.
const small = spot('small-field', 22, { capacity: 4 });
const next = spot('next-field', 24, { capacity: 20 });
const profiles = [current, small, next];
const hunters = [901, 902].map(characterId => ({ characterId, phase: 'cold', activity: 'hunting', spotId: small.id }));

let clock = original.now();
let rebuilds = 0;
let occupancy = null;
// A rebuilt occupancy holds only the committed states, as the live index does.
const rebuild = () => {
    rebuilds += 1;
    occupancy = SpotProfiles.occupancySnapshot(profiles, hunters);
};

(async () => {
    Date.now = () => clock;
    SpotProfiles.ensure = () => profiles;
    SpotProfiles.currentOccupancy = () => occupancy;
    // The ranked search: the small spot first, the next one when it is full.
    SpotProfiles.findForState = (state, options) => [small, next].find(candidate =>
        SpotProfiles.hasCapacityForStates(candidate, options.capacityStates || [state], options.occupancy)) || null;
    SpotService.findCurrentSpot = () => current;
    SpotService.arrivalPointForState = (state, target) => ({ ...target.center, locX: target.center.locX + Number(state.characterId) });

    const coordinator = new ColdSimulationCoordinator();
    const bot = (characterId, extra = {}) => ({
        characterId, name: `Hunter${characterId}`, phase: 'cold', activity: 'hunting', level,
        spotId: current.id, currentRegion: current.name, loc: { ...current.center },
        timing: { lastResolvedAt: clock - 30000, nextResolveAt: clock + 30000 },
        stats: {}, ...extra
    });
    const routeOf = (state) => coordinator.contextFor(state, coordinator.contextIndex()).route?.spotId || null;

    // Four bots get contexts across two occupancy rebuilds, seconds apart.
    rebuild();
    assert.strictEqual(routeOf(bot(1)), small.id);
    assert.strictEqual(routeOf(bot(2)), small.id);
    clock += 2000;
    rebuild();
    assert.strictEqual(routeOf(bot(3)), next.id, 'a rebuilt occupancy keeps the places of routes not yet committed');
    assert.strictEqual(routeOf(bot(4)), next.id);
    assert.strictEqual(rebuilds, 2);
    assert.deepStrictEqual([...coordinator.pendingRoutes.keys()], [1, 2, 3, 4]);

    // A bot keeps its own route: its place does not block itself.
    clock += 2000;
    rebuild();
    assert.strictEqual(routeOf(bot(1)), small.id, 'a bot re-routed with its own pending place keeps the spot');

    // A new context without a route frees the place.
    assert.strictEqual(coordinator.contextFor(bot(2, { activity: 'resting' }), coordinator.contextIndex()).route, null);
    assert(!coordinator.pendingRoutes.has(2));
    clock += 2000;
    rebuild();
    assert.strictEqual(routeOf(bot(5)), small.id, 'a replaced route frees its place');
    assert.strictEqual(routeOf(bot(6)), next.id);

    // A landed commit frees the place (a refused trip, as here, or a non-travel state).
    await coordinator.handleCommitResults([{ ok: true, characterId: 5 }]);
    {
        assert(!coordinator.pendingRoutes.has(5), 'a landed commit ends the pending route');
        clock += 2000;
        rebuild();
        assert.strictEqual(routeOf(bot(7)), small.id, 'a committed route frees its place');

        // An entry expires two snapshot refreshes after the bot's resolve.
        const entry = coordinator.pendingRoutes.get(1);
        assert(entry.expiresAt <= entry.at + 180000 && entry.expiresAt >= clock + 30000);
        clock = entry.expiresAt;
        rebuild();
        coordinator.contextIndex();
        assert(!coordinator.pendingRoutes.has(1), 'an expired route leaves the ledger');
        assert(coordinator.pendingRoutes.has(7), 'a fresher route stays until its own expiry');
        clock = coordinator.pendingRoutes.get(7).expiresAt + 1;
        rebuild();
        coordinator.contextIndex();
        assert.strictEqual(coordinator.pendingRoutes.size, 0, 'every entry expires: the ledger cannot leak');
        assert.strictEqual(routeOf(bot(8)), small.id);

        // The admission is unchanged: a trip into a spot full of pending
        // routes is refused with the capacity backoff and the 30 s hold.
        assert.strictEqual(routeOf(bot(9)), small.id);
        assert.strictEqual(routeOf(bot(10)), next.id);
        clock += 2000;
        rebuild();
        const admissionOccupancy = coordinator.occupancyWithPendingRoutes(profiles);
        const base = bot(11);
        const travelling = { ...base, activity: 'traveling',
            stats: { travel: { reason: 'level_replan', spotId: small.id, arrivalAt: clock + 25000 } } };
        const refused = admitSoloRouteTravelState(travelling, base, profiles, admissionOccupancy, clock);
        assert.strictEqual(refused.admitted, false);
        assert.strictEqual(refused.state.activity, 'hunting');
        assert.strictEqual(refused.state.timing.nextResolveAt, clock + SpotRiskPolicy.ROUTE_CAPACITY_RETRY_MS);
        assert(SpotRiskPolicy.excludedSpotIdsForStates([refused.state], clock).has(small.id),
            'a refused bot keeps its capacity backoff');
        // A bot holding a pending place is admitted to it.
        const holder = bot(8);
        assert.strictEqual(admitSoloRouteTravelState({ ...holder, activity: 'traveling',
            stats: { travel: { reason: 'level_replan', spotId: small.id, arrivalAt: clock + 25000 } } },
        holder, profiles, admissionOccupancy, clock).admitted, true);
    }
})().then(() => {
    console.log('E324 route ledger checks passed');
    process.exit(0);
}, (error) => {
    console.error(error);
    process.exit(1);
}).finally(() => {
    Date.now = original.now;
    Object.assign(SpotProfiles, { ensure: original.ensure, currentOccupancy: original.currentOccupancy,
        findForState: original.findForState });
    Object.assign(SpotService, { findCurrentSpot: original.findCurrentSpot,
        arrivalPointForState: original.arrivalPointForState });
});
