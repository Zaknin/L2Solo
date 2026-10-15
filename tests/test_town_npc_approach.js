const assert = require('assert');

require('../src/Global');

const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
const TownNpcApproach = invoke('GameServer/Bot/AI/TownNpcApproach');
const Slots = invoke('GameServer/Bot/AI/TownNpcSlots');
const verifyGeodataWhenAvailable = require('./helpers/verify_geodata_when_available');

function botAt(locX, locY, locZ = -100) {
    return {
        locX,
        locY,
        locZ,
        fetchLocX() { return this.locX; },
        fetchLocY() { return this.locY; },
        fetchLocZ() { return this.locZ; }
    };
}

function identifiedBotAt(actorId, locX, locY, locZ = -100) {
    return {
        ...botAt(locX, locY, locZ),
        fetchId: () => actorId
    };
}

const target = {
    actorId: 101,
    npcSelfId: 7001,
    name: 'Door Probe',
    town: 'Talking Island',
    locX: 1000,
    locY: 1000,
    locZ: -100,
    head: 0
};

const points = TownNpcApproach.pointsFor(target);
assert.deepStrictEqual(points.staging, { locX: 1240, locY: 1000, locZ: -100 });
assert.deepStrictEqual(points.interaction, { locX: 1072, locY: 1000, locZ: -100 });

const session = {};
const behind = botAt(824, 1000);
let approach = TownNpcApproach.plan(session, behind, target, 'shopping');
assert.strictEqual(approach.ready, false,
    'being inside ordinary NPC range behind the shopkeeper must not permit through-wall trade');
assert.strictEqual(approach.phase, 'staging');
assert.deepStrictEqual(
    { locX: approach.destination.locX, locY: approach.destination.locY, locZ: approach.destination.locZ },
    points.staging
);

behind.locX = points.staging.locX;
approach = TownNpcApproach.plan(session, behind, target, 'shopping');
assert.strictEqual(approach.phase, 'interaction', 'reaching the street waypoint must open the final approach');
assert.strictEqual(approach.ready, false);
assert.strictEqual(approach.arrivalRadius, TownNpcApproach.INTERACTION_ARRIVAL_RADIUS);

behind.locX = points.interaction.locX;
approach = TownNpcApproach.plan(session, behind, target, 'shopping');
assert.strictEqual(approach.ready, true, 'the front-side interaction point must permit the town errand');

behind.locX = points.interaction.locX + TownNpcApproach.INTERACTION_READY_RADIUS;
approach = TownNpcApproach.plan(session, behind, target, 'shopping');
assert.strictEqual(approach.ready, true,
    'a bot should interact from the modestly expanded front-side tolerance');

behind.locX += 1;
approach = TownNpcApproach.plan(session, behind, target, 'shopping');
assert.strictEqual(approach.ready, false,
    'the expanded tolerance must remain bounded near the interaction point');

const northFacing = TownNpcApproach.pointsFor({ ...target, head: 16384 });
assert.deepStrictEqual(northFacing.staging, { locX: 1000, locY: 1240, locZ: -100 },
    'Lineage heading units must project consistently onto world coordinates');
assert.strictEqual(TownNpcApproach.pointsFor({ ...target, head: null }), null,
    'targets without heading data must retain the legacy radius behavior');

for (let index = 0; index < 32; index++) {
    const session = {};
    const approach = TownNpcApproach.plan(session, identifiedBotAt(2200000 + index, 4000, 4000), target, 'shopping');
    assert(approach.destination && !approach.waiting,
        'distant shoppers must walk to the shop even when there are more shoppers than counter places');
    assert(!session.townNpcSlot && !session.townNpcQueue,
        'a cross-town walk must not reserve a counter place');
    TownNpcApproach.reset(session);
}

{
    const gate = { ...target, npcSelfId: 7002 };
    const shoppers = Array.from({ length: 32 }, (_, index) => ({
        session: {}, bot: identifiedBotAt(2300000 + index, 4000, 4000)
    }));
    for (const { session, bot } of shoppers) {
        const approach = TownNpcApproach.planOpen(session, bot, gate, 'town_gatekeeper');
        assert(approach.destination && !approach.waiting,
            'all departing shoppers must walk to the gatekeeper instead of queuing inside the shop');
        assert(!session.townNpcSlot && !session.townNpcQueue);
        bot.locX = gate.locX + 200;
        bot.locY = gate.locY;
    }
    const arrivals = shoppers.map(({ session, bot }) => TownNpcApproach.planOpen(session, bot, gate, 'town_gatekeeper'));
    assert.strictEqual(arrivals.filter(approach => !approach.waiting).length, 8,
        'the gatekeeper interaction places are shared only by nearby arrivals');
    shoppers.forEach(({ session }) => TownNpcApproach.reset(session));
}

{
    const key = 'queue-fairness';
    const points = () => [{ locX: 1 }, { locX: 2 }];
    const shoppers = Array.from({ length: 5 }, () => ({}));
    assert(Slots.reserve(shoppers[0], key, points, 0, 1000));
    assert(Slots.reserve(shoppers[1], key, points, 1, 1000));
    assert.strictEqual(Slots.reserve(shoppers[2], key, points, 0, 1000), null);
    assert.strictEqual(Slots.reserve(shoppers[3], key, points, 0, 1000), null);
    Slots.release(shoppers[0]);
    assert.strictEqual(Slots.reserve(shoppers[4], key, points, 0, 1100), null,
        'a newcomer must not steal the free place from the oldest waiting shopper');
    assert.strictEqual(Slots.reserve(shoppers[3], key, points, 0, 1100), null,
        'polling earlier must not overtake an older ticket');
    assert(Slots.reserve(shoppers[2], key, points, 0, 1100));
    Slots.release(shoppers[3]);
    Slots.release(shoppers[1]);
    assert(Slots.reserve(shoppers[4], key, points, 0, 1200),
        'cancelling a queued errand must immediately let the next shopper proceed');
    shoppers.forEach(Slots.release);

    const absent = {}, waiting = {}, next = {};
    const onePoint = () => [{ locX: 1 }];
    assert(Slots.reserve(absent, 'queue-expiry', onePoint, 0, 1000));
    assert.strictEqual(Slots.reserve(waiting, 'queue-expiry', onePoint, 0, 1000), null);
    assert.strictEqual(Slots.reserve(next, 'queue-expiry', onePoint, 0, 1000), null);
    assert.strictEqual(Slots.reserve(next, 'queue-expiry', onePoint, 0, 2000), null);
    assert(Slots.reserve(next, 'queue-expiry', onePoint, 0, 1000 + Slots.LEASE_MS),
        'abandoned leases and tickets must expire without retaining an actor');
    assert.strictEqual(Slots.reserve(absent, 'queue-expiry', onePoint, 0, 1001 + Slots.LEASE_MS), null,
        'an expired owner must rejoin the queue rather than revive its old lease');
    Slots.reserve(absent, 'other-shop', onePoint, 0, 1002 + Slots.LEASE_MS);
    Slots.release(next);
    assert(Slots.reserve(waiting, 'queue-expiry', onePoint, 0, 1003 + Slots.LEASE_MS),
        'changing shops must cancel the previous waiting ticket');
    [absent, waiting, next].forEach(Slots.release);
}

{
    const session = { shoppingDoneAnnounced: true };
    const owner = {};
    Slots.reserve(owner, 'finished-shopping', () => [1]);
    Slots.reserve(session, 'finished-shopping', () => [1]);
    invoke('GameServer/Bot/AI/States/ShoppingState').tick(session, {}, {}, {});
    assert(!session.townNpcQueue && !session.townNpcSlot,
        'a completed shopper awaiting its return callback must leave the queue immediately');
    assert(Slots.reserve(session, 'finished-shopping', () => [1]) === null);
    Slots.release(owner);
    invoke('GameServer/Bot/AI/States/ShoppingState').tick(session, {}, {}, {});
    assert(Slots.reserve({}, 'finished-shopping', () => [1]),
        'a completed shopper must not reserve the next place while waiting for its return');
}

verifyGeodataWhenAvailable(GeodataEngine, [[22, 22]], 'Giran Helvetia counter approach', () => {
    const helvetia = {
        actorId: 1001,
        npcSelfId: 7081,
        name: 'Helvetia',
        town: 'Giran',
        locX: 80518,
        locY: 147922,
        locZ: -3506,
        head: 32768
    };
    const helvetiaPoints = TownNpcApproach.pointsFor(helvetia);
    assert.deepStrictEqual(helvetiaPoints.interaction, { locX: 80467, locY: 147871, locZ: -3506 });
    const reachableCounterEdge = botAt(80456, 147864, -3504);
    assert.strictEqual(TownNpcApproach.hasLineOfSight(reachableCounterEdge, helvetia), false,
        'the last reachable Helvetia geodata cell should reproduce the live counter-edge LOS clip');
    assert.strictEqual(TownNpcApproach.plan({}, reachableCounterEdge, helvetia, 'shopping').ready, true,
        'reaching the tight edge of a validated counter point must permit interaction');
    const outsideCounterEdge = botAt(80448, 147864, -3504);
    assert.strictEqual(TownNpcApproach.hasLineOfSight(outsideCounterEdge, helvetia), false);
    assert.strictEqual(TownNpcApproach.plan({}, outsideCounterEdge, helvetia, 'shopping').ready, false,
        'a bot beyond the tight counter-edge allowance must still need direct line of sight');

    for (const fixture of [
        { id: 2002921, locY: 147688, npc: helvetia },
        { id: 2003604, locY: 148040, npc: { ...helvetia, actorId: 1002, npcSelfId: 7082, name: 'Denkus', locY: 147873 } }
    ]) {
        // Reproduce the two live stuck actors, then cover every slot choice.
        for (let offset = 0; offset < 10; offset++) {
            const bot = identifiedBotAt(fixture.id + offset, 80328, fixture.locY, -3504);
            const session = {};
            TownNpcApproach.plan(session, bot, fixture.npc, 'shopping');
            TownNpcApproach.skipStaging(session);
            const approach = TownNpcApproach.plan(session, bot, fixture.npc, 'shopping');
            const target = approach.destination;
            const path = GeodataEngine.findPath(bot.locX, bot.locY, bot.locZ, target.locX, target.locY, target.locZ,
                5000, { debug: false, goalRadius: approach.arrivalRadius, goalZTolerance: 64 });
            assert(path?.length, `${fixture.npc.name} slot ${offset} must be reachable from the actual street position`);
            Object.assign(bot, path.at(-1));
            assert(TownNpcApproach.plan(session, bot, fixture.npc, 'shopping').ready,
                'the reachable path endpoint must complete interaction without crossing the counter');
            TownNpcApproach.reset(session);
        }
    }

    const shoppers = Array.from({ length: 32 }, (_, index) => ({
        session: {}, bot: identifiedBotAt(2100000 + index, 84119, 147791, -3400)
    }));
    for (const { session, bot } of shoppers) {
        const approach = TownNpcApproach.plan(session, bot, helvetia, 'shopping');
        assert(approach.destination && !approach.waiting,
            'all 32 distant shoppers must start walking instead of waiting across town');
        assert(!session.townNpcSlot && !session.townNpcQueue,
            'walking across town must neither reserve a counter nor enter its local queue');
        Object.assign(bot, helvetiaPoints.staging);
    }
    const arrivals = shoppers.map(({ session, bot }) => TownNpcApproach.plan(session, bot, helvetia, 'shopping'));
    assert.strictEqual(arrivals.filter(approach => !approach.waiting).length, 2,
        'Helvetia must retain only the two actually reachable counter places');
    let completed = 0;
    // Reverse polling reproduces a scheduler that favors late arrivals.
    for (let wave = 0; wave < 32 && completed < shoppers.length; wave++) {
        for (const shopper of [...shoppers].reverse()) {
            if (shopper.done) continue;
            const { session, bot } = shopper;
            const approach = TownNpcApproach.plan(session, bot, helvetia, 'shopping');
            if (approach.waiting) continue;
            const destination = approach.destination;
            const path = GeodataEngine.findPath(bot.locX, bot.locY, bot.locZ,
                destination.locX, destination.locY, destination.locZ, 5000,
                { debug: false, goalRadius: approach.arrivalRadius, goalZTolerance: 64 });
            assert(path?.length, 'each queued shopper must receive a reachable counter place');
            Object.assign(bot, path.at(-1));
            assert(TownNpcApproach.plan(session, bot, helvetia, 'shopping').ready);
            TownNpcApproach.reset(session);
            shopper.done = true;
            completed++;
        }
    }
    assert.strictEqual(completed, 32, 'every shopper must reach the counter despite reversed tick order');
});

const firstOpenSession = {};
const secondOpenSession = {};
const firstOpen = TownNpcApproach.planOpen(
    firstOpenSession,
    identifiedBotAt(101, 500, 1000),
    target,
    'newbie_guide'
);
const secondOpen = TownNpcApproach.planOpen(
    secondOpenSession,
    identifiedBotAt(102, 500, 1000),
    target,
    'newbie_guide'
);
assert.strictEqual(firstOpen.phase, 'interaction',
    'an open-air NPC must skip the shop-door staging phase');
assert.notDeepStrictEqual(firstOpen.destination, secondOpen.destination,
    'nearby hot bots must not funnel through one shared open-air approach point');
assert(Math.hypot(firstOpen.destination.locX - target.locX, firstOpen.destination.locY - target.locY) <= TownNpcApproach.INTERACTION_DISTANCE + 1,
    'the open-air approach should finish close to the NPC');

const alreadyClose = TownNpcApproach.planOpen(
    {},
    identifiedBotAt(103, target.locX + 80, target.locY),
    target,
    'newbie_guide'
);
assert.strictEqual(alreadyClose.ready, true,
    'a bot already close with line of sight must interact without walking out to a staging point');

const openBoundaryBot = identifiedBotAt(
    104,
    target.locX + TownNpcApproach.OPEN_INTERACTION_READY_RADIUS,
    target.locY
);
const openBoundary = TownNpcApproach.planOpen({}, openBoundaryBot, target, 'newbie_guide');
assert.strictEqual(openBoundary.ready, true,
    'open-air NPC interaction should accept the expanded nearby radius');

openBoundaryBot.locX += 1;
const outsideOpenBoundary = TownNpcApproach.planOpen({}, openBoundaryBot, target, 'newbie_guide');
assert.strictEqual(outsideOpenBoundary.ready, false,
    'open-air interaction must still reject bots just outside the nearby radius');

console.log('Town NPC front-side approach checks passed');
