'use strict';
// L70: one verdict "the held economy plan is still valid". Hard events cut
// through at once; soft changes wait for their kind's wall-clock delay since
// the last actual decision (docs/principles.md section 3 point 5).
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l70-held-plan-'));
process.env.L2NODE_CONFIG_FILE = path.join(dir, 'config.ini');
delete process.env.L2NODE_SHARED_CONFIG_FILE;
fs.writeFileSync(process.env.L2NODE_CONFIG_FILE, fs.readFileSync(path.join(__dirname, '../config/default.ini'), 'utf8')
    + `\n[Database]\npath=${dir}/world.sqlite\nhistoryPath=${dir}/history.sqlite\n`);
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Sections = invoke('GameServer/Bot/Economy/DecisionSections');
const Events = invoke('GameServer/Bot/AI/DecisionEvents');
const Providers = invoke('GameServer/Bot/Economy/WishProviders');
const Decisions = invoke('GameServer/Bot/Population/ColdEconomyDecision');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Floor = invoke('GameServer/Bot/Population/SurvivalFloor');
const { BoardIndex, SELL } = invoke('GameServer/AfkTrade/BoardIndex');

const T = 1e12, MINUTE = 60 * 1000;
const board = new BoardIndex();
const deps = { timestamp: T, knowledgeEnabled: true, board, spots: invoke('GameServer/Bot/Population/SpotProfiles').ensure() };
const at = timestamp => ({ ...deps, timestamp });
const originalBuild = Providers.build;
let builds = 0;
Providers.build = (...args) => { builds++; return originalBuild(...args); };
const bag = extra => Life.inventorySummaryFromItems([
    { id: 1, selfId: 1, amount: 1, equipped: 1, slot: 7 },
    { id: 2, selfId: 1835, amount: 100000, equipped: 0, slot: 0 },
    { id: 3, selfId: 1869, amount: 100000 + extra, equipped: 0, slot: 0 }]);
function subject(characterId, adena = 50) {
    return { characterId, level: 35, phase: 'cold', activity: 'hunting', adena, sp: 0,
        currentRegion: 'Giran', loc: { locX: 80000, locY: 148000, locZ: -3500 }, inventory: bag(0),
        stats: { classId: 1, exp: Data.experience[34], coldCombat: { classId: 1, skillSource: 'database', skills: [] } },
        timing: { lastResolvedAt: T }, updatedAt: T, vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 } };
}
// A decided bot: one actual build, its packet adopted as the native step does.
function decided(characterId, adena) {
    let state = subject(characterId, adena);
    const economy = Economy.forState(state, deps);
    state = { ...state, stats: { ...state.stats, ...economy.statsPacket } };
    return { state, economy, accepted: Decisions.advisory(economy, state) };
}
// The bot's own result inside one decision: hunting -> resting, free loot
// inside its quantity band, one adena more.
const ownResult = (state, activity = 'resting') => ({ ...state, activity, adena: state.adena + 1, inventory: bag(1),
    updatedAt: state.updatedAt + 1, vitals: { ...state.vitals, mp: state.vitals.mp - 1 }, stats: { ...state.stats } });

try {
    assert.equal(Sections.capability(subject(1), T), Sections.capability(subject(1), T + 11 * MINUTE),
        'fixture: the game day/night build mark does not move inside the test window');
    // (a) after-result own result only: no new build, the card is restamped.
    {
        const { state, economy, accepted } = decided(93001);
        assert(state.stats.wishSections.at === T, 'the saved baseline records the time of the actual decision');
        assert(accepted && accepted.activity === 'hunting');
        const band = Economy.decodeCalculationFence(accepted.fence)[3].find(row => row[0] === 1869);
        assert(band && band[2] >= 100001, 'fixture: the free material has a quantity band');
        const [low, high] = state.stats.wishSections.cashBounds;
        assert(state.adena + 1 > low && (high === null || state.adena + 1 < high), 'fixture: adena stays inside the cash bounds');
        const next = ownResult(state);
        assert.notEqual(Economy.inputKey(next, at(T + 1000)), Economy.inputKey(state, at(T + 1000)),
            'fixture: the own result changes the raw input key (activity in the route frame, loot)');
        const before = builds;
        const reused = Economy.forState(next, at(T + 1000));
        assert.equal(builds, before, 'an own result inside the bands rebuilds nothing');
        assert.strictEqual(reused.plan, economy.plan, 'the held plan of the step is reused');
        assert.equal(reused.statsPacket.wishSections.at, T, 'the reused packet keeps the last actual decision time');
        const card = Decisions.advisory(reused, next);
        assert(card, 'the reused plan publishes a card');
        assert.equal(card.card.key, Decisions.stateKey(next), 'the card is stamped with the new state key');
        assert.equal(card.activity, 'resting');
        // After eviction, the card path: restamped after the result only.
        Economy.forgetContext(next.characterId);
        const thinBuilds = builds;
        const thin = Decisions.refreshAdvisory(next, accepted, at(T + 1000), { afterResult: true });
        assert(thin, 'after a result the card accepts the own hunting -> resting step');
        assert.equal(builds, thinBuilds);
        assert.equal(thin.decision.key, Decisions.stateKey(next));
        // Before an action a resting bot's step is its own rest; the card is
        // executed only through a hunter's target, so a rester reuses it too.
        assert(Decisions.refreshAdvisory(next, accepted, at(T + 1000)), 'before an action a resting bot reuses the card');
        assert.equal(Decisions.refreshAdvisory({ ...next, activity: 'shopping' }, accepted, at(T + 1000)), null,
            'before an action a shopper still rebuilds');
        assert.equal(Decisions.refreshAdvisory({ ...next, activity: 'traveling' }, accepted, at(T + 1000)), null,
            'a traveller without a trip record (resolved as a fight) still rebuilds');
        assert.equal(Decisions.refreshAdvisory({ ...next, activity: 'shopping' }, accepted, at(T + 1000), { afterResult: true }), null,
            'only hunting, resting and travelling are equalised');
        assert.equal(Decisions.refreshAdvisory({ ...next, loc: { ...next.loc, locX: next.loc.locX + 500 } }, accepted,
            at(T + 1000), { afterResult: true }), null, 'a location change stays exact');
    }
    // (h) a trip to the held hunting leaf's own spot executes the plan: no
    // event; a trip to another spot or a town stays exact (lever 2).
    {
        const { state, economy, accepted } = decided(93011);
        const leaf = accepted.card.activity;
        assert(leaf && leaf.activity === 'hunting' && leaf.spotId != null, 'fixture: a hunting leaf at a spot');
        const trip = (spotId, extra = {}) => ({ ...state, activity: 'traveling', updatedAt: state.updatedAt + 1,
            stats: { ...state.stats, travel: { from: { ...state.loc }, to: { locX: 81000, locY: 149000, locZ: -3500 }, spotId,
                regionName: 'Hunting Ground', arrivalActivity: 'hunting', townName: null, method: 'gatekeeper_spot',
                startedAt: T, arrivalAt: T + 10 * MINUTE, ...extra } } });
        const own = trip(leaf.spotId);
        let before = builds;
        assert.strictEqual(Economy.forState(own, at(T + 1000)).plan, economy.plan, 'the cache keeps the plan on its own trip');
        assert.equal(builds, before);
        assert.equal(Economy.calculationHolds(own, accepted.fence, at(T + 1000)), false,
            'without the card options the proof stays exact');
        assert(Economy.calculationHolds(own, accepted.fence, at(T + 1000), { activity: 'hunting', leaf }),
            'the build activity and the own leaf accept the trip start');
        Economy.forgetContext(state.characterId);
        assert(Decisions.refreshAdvisory(own, accepted, at(T + 1000)), 'before an action the own trip keeps the card');
        assert(Decisions.refreshAdvisory(own, accepted, at(T + 1000), { afterResult: true }), 'after a result as well');
        assert.equal(Decisions.refreshAdvisory(trip(`${leaf.spotId}_other`), accepted, at(T + 1000)), null,
            'a trip to another spot rebuilds');
        assert.equal(Decisions.refreshAdvisory(trip(leaf.spotId, { townName: 'Giran', arrivalActivity: 'shopping' }), accepted,
            at(T + 1000)), null, 'a town trip rebuilds');
        assert(Decisions.refreshAdvisory(trip(leaf.spotId, { arrivalAt: T + 500 }), accepted, at(T + 1000)),
            'a due arrival keeps the card before an action: the step resolves the arrival, not a fight');
        assert.equal(Decisions.refreshAdvisory({ ...own, activity: 'hunting', spotId: leaf.spotId,
            loc: own.stats.travel.to, stats: { ...own.stats, travel: null } }, accepted, at(T + 1000), { afterResult: true }),
        null, 'the arrival (location and spot) stays exact');
    }
    // (i) shots used between the survival line and the target: noise below
    // the bot's own error; the survival line and any rise stay hard (lever 3).
    {
        const shotBag = shots => Life.inventorySummaryFromItems([
            { id: 1, selfId: 1, amount: 1, equipped: 1, slot: 7 },
            { id: 2, selfId: 1835, amount: shots, equipped: 0, slot: 0 },
            { id: 3, selfId: 1869, amount: 100000, equipped: 0, slot: 0 }]);
        const probe = Economy.basics({ ...subject(93012, 1e6), inventory: shotBag(1) }, deps).stock('shots');
        const floor = Math.max(1, Math.ceil(probe.survivalTarget - (probe.beginnerCurrent || 0)));
        const target = Math.ceil(probe.target - (probe.beginnerCurrent || 0));
        assert(probe.itemId === 1835 && floor + 2 < target, 'fixture: room between the survival line and the target '
            + JSON.stringify([floor, target]));
        const amount = target - 1;
        let state = { ...subject(93012, 1e6), inventory: shotBag(amount) };
        const economy = Economy.forState(state, deps);
        state = { ...state, stats: { ...state.stats, ...economy.statsPacket } };
        const accepted = Decisions.advisory(economy, state);
        const band = Economy.decodeCalculationFence(accepted.fence)[3].find(row => row[0] === 1835);
        assert(band && band[2] === amount && band[1] >= floor && band[1] < amount,
            'shots below the target have a consumption band ' + JSON.stringify(band));
        const used = shots => ({ ...state, inventory: shotBag(shots), updatedAt: state.updatedAt + 1, stats: { ...state.stats } });
        const before = builds;
        assert.strictEqual(Economy.forState(used(amount - 1), at(T + 1000)).plan, economy.plan, 'one shot used inside the band');
        assert.equal(builds, before);
        Economy.forgetContext(state.characterId);
        assert(Decisions.refreshAdvisory(used(amount - 1), accepted, at(T + 1000), { afterResult: true }), 'the card holds too');
        assert(Decisions.refreshAdvisory(used(band[1]), accepted, at(T + 1000), { afterResult: true }), 'the band edge holds');
        assert.equal(Decisions.refreshAdvisory(used(band[1] - 1), accepted, at(T + 1000), { afterResult: true }), null,
            'use beyond the error or the survival line rebuilds');
        assert.equal(Decisions.refreshAdvisory(used(floor - 1), accepted, at(T + 1000), { afterResult: true }), null,
            'below the survival line rebuilds at once');
        assert.equal(Decisions.refreshAdvisory(used(amount + 1), accepted, at(T + 1000), { afterResult: true }), null,
            'a rise below the target stays exact');
        // A held purchase of the shots themselves orders only the rise since
        // its decision, so its own item stays exact (else it would buy short).
        const options = { activity: accepted.activity, leaf: accepted.card.activity };
        assert(Economy.calculationHolds(used(amount - 1), accepted.fence, at(T + 1000), options), 'fixture: the held leaf holds the band');
        assert.equal(Economy.calculationHolds(used(amount - 1), accepted.fence, at(T + 1000),
            { ...options, leaf: { activity: 'shopping', kind: 'buy', itemId: 1835, amount: target - amount + 1 } }), false,
        'a held shots purchase keeps the shots exact');
    }
    // (j) the build publishes its potion and shot targets; the sale list keeps
    // by them without a second earning-spot search (L72).
    {
        const { state, economy } = decided(93013);
        const potions = economy.stock('potions'), shots = economy.stock('shots');
        assert.deepEqual(state.stats.stockTargets, [potions.itemId, potions.target, shots.itemId, shots.target],
            'the packet carries the plan\'s own stock targets');
        const Route = require('../src/GameServer/Bot/Economy/EquipmentIncomeRoute'), select = Route.select;
        let searches = 0;
        Route.select = (...args) => { searches++; return select(...args); };
        try {
            const marked = { ...state, stats: { ...state.stats, stockTargets: [potions.itemId, 7, shots.itemId, 11] } };
            const read = Economy.keptTargets(marked);
            assert.equal(read.potions, 7);
            assert.equal(read.shots.target, 11);
            assert.equal(read.shots.itemId, shots.itemId);
            assert.equal(searches, 0, 'a published target needs no earning-spot search');
            invoke('GameServer/Bot/Economy/ItemDisposition').saleCandidates(marked, { unlimited: true });
            assert.equal(searches, 0, 'the sale list reads the published targets');
            const other = Economy.keptTargets({ ...marked, stats: { ...marked.stats, stockTargets: [potions.itemId, 7, shots.itemId + 1, 11] } });
            assert(searches > 0 && other.shots.target === shots.target, 'another shot item falls back to the foundation');
        } finally { Route.select = select; }
    }
    // (b) hard events rebuild at once.
    {
        const { state, economy } = decided(93002, 1e6);
        const [low] = state.stats.wishSections.cashBounds;
        assert(low >= 0, 'fixture: a protected spending bound below the wallet');
        let before = builds;
        const newItem = { ...ownResult(state), inventory: { ...bag(1), ...Life.inventorySummaryFromItems([
            { id: 4, selfId: 1870, amount: 1, equipped: 0, slot: 0 }]) } };
        assert.notStrictEqual(Economy.forState(newItem, at(T + 1000)).plan, economy.plan, 'a new item is an event');
        assert(builds > before);
        const outside = decided(93008, 1e6);
        before = builds;
        Economy.forState({ ...ownResult(outside.state), inventory: bag(1e7) }, at(T + 1000));
        assert(builds > before, 'loot beyond the quantity band is an event');
        const held = decided(93003, 1e6);
        before = builds;
        const nativePenalty = Floor.weightPenalty;
        Floor.weightPenalty = (...args) => nativePenalty(...args) + 1;
        try { Economy.forState(ownResult(held.state), at(T + 1000)); } finally { Floor.weightPenalty = nativePenalty; }
        assert(builds > before, 'a weight tier change is an event');
        const poor = decided(93004, 1e6);
        before = builds;
        Economy.forState({ ...ownResult(poor.state), adena: low - 1 }, at(T + 1000));
        assert(builds > before, 'adena below the lower cash bound is an event');
        assert.equal(Decisions.refreshAdvisory({ ...ownResult(poor.state), adena: low - 1 }, poor.accepted, at(T + 1000),
            { afterResult: true }), null, 'the card refuses the same hard money event');
    }
    // (c) a read market item is soft: 10 min since the last actual decision.
    {
        const { state, economy, accepted } = decided(93005);
        const wished = economy.network.queue.map(wish => Number(wish.object?.itemId)).find(Boolean);
        assert(wished, 'fixture: a wished item the review read');
        board.put({ id: 9300501, kind: 'shop', storeType: SELL, ownerId: 7, lines: [{ lineId: 1, selfId: wished, count: 1, price: 10 }] });
        let before = builds;
        assert.strictEqual(Economy.forState(state, at(T + MINUTE)).plan, economy.plan, 'a moved market token waits');
        assert.equal(builds, before);
        assert(Decisions.refreshAdvisory(state, accepted, at(T + MINUTE)), 'the card waits on the same soft market');
        assert.equal(Economy.calculationHolds(state, accepted.fence, at(T + MINUTE)), false,
            'without the card options the proof stays exact');
        assert.equal(Decisions.refreshAdvisory(state, accepted, at(T + 11 * MINUTE)), null, 'after 10 min the card is re-examined');
        before = builds;
        assert.notStrictEqual(Economy.forState(state, at(T + 11 * MINUTE)).plan, economy.plan, 'after 10 min the plan is rebuilt');
        assert(builds > before);
    }
    // (f) soft market never excuses the held leaf's own offer (critic 1).
    {
        board.remove(9300501); // the line of (c): the own offer below is the only one
        const tripCost = Object.assign(() => 0, { details: () => ({ known: true, hours: .1, fees: 0 }) });
        const tdeps = timestamp => ({ ...deps, tripCost, timestamp });
        let state = subject(93009, 1e6);
        const economy = Economy.forState(state, tdeps(T));
        state = { ...state, stats: { ...state.stats, ...economy.statsPacket } };
        const wished = economy.network.queue.map(wish => Number(wish.object?.itemId)).find(Boolean);
        assert(wished, 'fixture: a wished item the review read');
        board.put({ id: 9300901, kind: 'shop', storeType: SELL, ownerId: 7, town: 'Giran',
            lines: [{ lineId: 1, selfId: wished, count: 5, price: 10 }] });
        // fixture: the held decision's own next step buys that line
        economy.plan.network.activity = { activity: 'shopping', kind: 'buy', itemId: wished, amount: 1, unitPrice: 10,
            sourceType: 'afk', town: 'Giran' };
        assert(Economy.acceptedActivityHolds(state, economy.plan.network.activity, tdeps(T + MINUTE)),
            'fixture: the own offer, funding and route hold');
        let before = builds;
        assert.strictEqual(Economy.forState(state, tdeps(T + MINUTE)).plan, economy.plan,
            'a moved read token waits while the own offer holds');
        assert.equal(builds, before);
        board.put({ id: 9300901, kind: 'shop', storeType: SELL, ownerId: 7, town: 'Giran',
            lines: [{ lineId: 1, selfId: wished, count: 5, price: 20 }] });
        before = builds;
        assert.notStrictEqual(Economy.forState(state, tdeps(T + 2 * MINUTE)).plan, economy.plan,
            'the own line moved: rebuild inside the market delay');
        assert(builds > before);
    }
    // (g) a resting crafter's MP is a resource: the card is refused (critic 2a).
    {
        let state = { ...subject(93010), craftLevel: 1 };
        const economy = Economy.forState(state, deps);
        state = { ...state, stats: { ...state.stats, ...economy.statsPacket } };
        const accepted = Decisions.advisory(economy, state);
        assert(accepted && accepted.mp === state.vitals.mp);
        const resting = { ...ownResult(state), vitals: { ...state.vitals } };
        Economy.forgetContext(state.characterId);
        assert(Decisions.refreshAdvisory(resting, accepted, at(T + 1000), { afterResult: true }),
            'fixture: the same MP keeps the crafter card');
        assert.equal(Decisions.refreshAdvisory({ ...resting, vitals: { ...state.vitals, mp: state.vitals.mp + 50 } }, accepted,
            at(T + 1000), { afterResult: true }), null, 'a crafter MP rise refuses the card');
    }
    // (d) a reconcile event of this step is never overwritten by a reused packet.
    {
        const { state, economy, accepted } = decided(93006);
        // BotLifeState.prepareResolve: reconcile first, then the economy, then
        // the packet is merged into the next state.
        const next = { ...ownResult(state, 'hunting'), level: state.level + 1, stats: { ...state.stats } };
        const changed = Events.reconcile(state, next, T + 1000);
        assert(changed.includes('build'));
        assert(next.stats.wishDirty > 0);
        assert.equal(Decisions.refreshAdvisory(next, accepted, at(T + 1000), { afterResult: true }), null,
            'a raised event refuses the card');
        const before = builds;
        const rebuilt = Economy.forState(next, at(T + 1000));
        assert(builds > before, 'a raised event rebuilds');
        assert.notStrictEqual(rebuilt.plan, economy.plan);
        Object.assign(next.stats, rebuilt.statsPacket);
        assert.equal(next.stats.decisionSeq, state.stats.decisionSeq + 1, 'the event of the step survives the packet merge');
        assert.equal(next.stats.wishSections.at, T + 1000, 'the new decision restarts every soft delay');
        // A soft-only drift does not raise an event at all within its delay.
        const drift = { ...ownResult(next, 'hunting'), stats: { ...next.stats } };
        assert.deepEqual(Events.reconcile(next, drift, T + 2000), []);
    }
    // (e) the shared money verdict (cold reconcile and the hot observer).
    {
        const state = subject(93007, 50);
        const packet = [100, .1, 10, 100, .2, 20, 1];
        const base = { ...state, stats: { ...state.stats, money: packet } };
        const wishSections = { at: T, wallet: 50, cashBounds: [30, 130], funding: Sections.fundingMark(base), moneyError: 10,
            ...Sections.semanticFacts(base, T) };
        const before = { ...base, stats: { ...base.stats, wishSections } };
        const after = adena => ({ ...before, adena, stats: { ...before.stats } });
        assert.equal(Sections.events(before, after(61), T + 30 * 1000).includes('funding'), false,
            'a drift above the money error inside the bounds waits for the next decision point');
        assert.equal(Sections.events(before, after(129), T + 59 * 1000).includes('funding'), false);
        assert(Sections.events(before, after(61), T + 61 * 1000).includes('funding'), 'after 60 s the drift is re-examined');
        assert(Sections.events(before, after(130), T + 61 * 1000).includes('funding'), 'a newly payable wish after 60 s');
        assert(Sections.events(before, after(29), T + 1000).includes('funding'), 'below the lower bound is immediate');
        assert.equal(Sections.moneyEvent(after(55), wishSections, T + 1000), false);
        assert(Sections.moneyEvent(after(61), { ...wishSections, at: undefined }, T + 1000),
            'a baseline saved before L70 behaves as an elapsed delay');
        assert(Sections.softDue(wishSections, 'observation', T + 5 * MINUTE));
        assert.equal(Sections.softDue(wishSections, 'market', T + 9 * MINUTE), false);
    }
    console.log('PASS L70 held plan: own result reuse and restamp, own-spot trip, shot use below target, hard events, soft market delay, reconcile kept, shared money verdict');
} finally {
    Providers.build = originalBuild;
    fs.rmSync(dir, { recursive: true, force: true });
}
