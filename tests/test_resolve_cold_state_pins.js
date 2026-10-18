const assert = require('assert');

require('../src/Global');

// Pins the observable behaviour of PopulationService.resolveColdState for
// every branch: early returns (preparation, clan hall, party market break,
// karma, joined party, inventory cleanup, mammon, craft service), the
// transition branch (travel, rest, cleanup after a worker fight), the craft
// branch, the planning and routing branches (worker plan retarget/replace,
// craft travel, missing spot, hunting trip, party fallback) and the applied
// resolve with its town/market/native-errand chain and post-commit review.
// Every outside effect is recorded into one ordered log together with the
// microtask tick at which it ran, so a moved await or a reordered call turns
// a case red. The method must stay synchronous: it throws synchronously and
// hands back the hall visit's value as it is.

// Destructured at PopulationService load: wrap before it loads.
const PartyRequestPlanner = invoke('GameServer/Bot/Population/PartyRequestPlanner');
const HuntingTravel = invoke('GameServer/Bot/Population/HuntingTravel');
const originalPartyRequestForPlan = PartyRequestPlanner.partyRequestForPlan;
const originalBeginHuntingTrip = HuntingTravel.beginHuntingTrip;
let pinsActive = false;
PartyRequestPlanner.partyRequestForPlan = (...args) => (pinsActive
    ? cfgCall('partyRequestForPlan', args, () => cfg.partyRequest)
    : originalPartyRequestForPlan(...args));
HuntingTravel.beginHuntingTrip = (...args) => (pinsActive
    ? cfgCall('beginHuntingTrip', args, () => cfg.huntTrip(...args))
    : originalBeginHuntingTrip(...args));

const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const LifeEvents = invoke('GameServer/Bot/Population/BotLifeEvents');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const SpotRiskPolicy = invoke('GameServer/Bot/Population/SpotRiskPolicy');
const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const BackgroundPartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Director = invoke('GameServer/Bot/Population/PopulationDirector');
const GlobalChat = invoke('GameServer/Bot/Population/BotGlobalChat');
const GoalService = invoke('GameServer/Bot/Goals/GoalService');
const GoalExecutor = invoke('GameServer/Bot/Goals/GoalExecutor');
const NeedsEvaluator = invoke('GameServer/Bot/Goals/NeedsEvaluator');
const ColdMarketService = invoke('GameServer/Bot/Economy/ColdMarketService');
const BotAfkMarketService = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const ColdMarketListingService = invoke('GameServer/Bot/Economy/ColdMarketListingService');
const BotWarehouse = invoke('GameServer/Bot/Economy/BotWarehouseService');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const PurchaseFunding = invoke('GameServer/Bot/Economy/PurchaseFunding');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const PartyWaitFallback = invoke('GameServer/Bot/Population/PartyWaitFallback');
const ColdCraftingService = invoke('GameServer/Bot/Economy/ColdCraftingService');
const ColdWealthCraftService = invoke('GameServer/Bot/Economy/ColdWealthCraftService');
const ColdShotEconomyService = invoke('GameServer/Bot/Economy/ColdShotEconomyService');
const CraftTelemetry = invoke('GameServer/Bot/Economy/CraftTelemetry');
const CraftWorkshopService = invoke('GameServer/Bot/Economy/CraftWorkshopService');
const BotImprovementService = invoke('GameServer/Bot/Economy/BotImprovementService');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const BotErrands = invoke('GameServer/Bot/Population/BotErrands');
const TradeMeeting = invoke('GameServer/AfkTrade/TradeMeetingService');
const ColdVisit = invoke('GameServer/ClanHall/ColdVisit');
const PartyMarketBreak = invoke('GameServer/Bot/Population/PartyMarketBreak');
const ColdKarmaPolicy = invoke('GameServer/Bot/Population/ColdKarmaPolicy');
const MammonUnseal = invoke('GameServer/Bot/AI/BotMammonUnseal');
const CombinedErrands = invoke('GameServer/Bot/Population/CombinedErrandPolicy');
const SurvivalFloor = invoke('GameServer/Bot/Population/SurvivalFloor');

const T0 = 1700000000000;
const trace = [];
const saves = [];
let cfg = null;
let nowCalls = 0;
let tick = 0;
let ticking = false;

// A microtask clock: one tick per turn of the microtask queue while a case
// runs, so every recorded effect carries the await depth it ran at.
function startClock() {
    tick = 0;
    ticking = true;
    const step = () => {
        if (!ticking || tick >= 20000) return;
        tick += 1;
        queueMicrotask(step);
    };
    queueMicrotask(step);
}

function tagOf(value) { return value?.tag || '?'; }
function retag(value, label) { return value ? { ...value, tag: `${tagOf(value)}>${label}` } : value; }

function S(value) {
    if (value === null || value === undefined) return String(value);
    if (typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(S).join(',')}]`;
    if ('characterId' in value) {
        return `#${value.characterId}:${value.activity}@${value.spotId || '-'}`
            + ` n=${value.timing?.nextResolveAt ?? '-'} st=${Object.keys(value.stats || {}).sort().join(',')} t=${tagOf(value)}`;
    }
    return `{${Object.keys(value).map((key) => `${key}:${typeof value[key] === 'function' ? 'fn' : S(value[key])}`).join(',')}}`;
}

function record(label, args) {
    trace.push(`${tick} ${label}(${args.map(S).join(', ')})`);
}

function cfgCall(label, args, impl) {
    record(label, args);
    return impl();
}

const stubbed = [];
function stub(target, name, label, impl) {
    stubbed.push([target, name, target[name]]);
    target[name] = (...args) => cfgCall(label, args, () => impl(...args));
}

function restoreAll() {
    for (let i = stubbed.length - 1; i >= 0; i -= 1) {
        const [target, name, original] = stubbed[i];
        target[name] = original;
    }
}

const spotA = { id: 'old_ground', name: 'Old Ground', center: { locX: 10, locY: 20, locZ: 30 } };
const spotB = { id: 'new_ground', name: 'New Ground', center: { locX: 9000, locY: 9000, locZ: 30 } };
const spots = [spotA, spotB];

function defaults() {
    return {
        prep: () => false,
        hallNeeded: false,
        hallResult: { hall: 'visit-result' },
        marketBreak: false,
        karma: null,
        cached: () => null,
        cleanupNeed: null,
        cleanupGoal: (need) => ({ type: 'sell_inventory', status: 'proposed', target: { itemCount: need.itemCount, npcOnlySlots: 1, cleanupReason: 'inventory_capacity' } }),
        marketTravel: (state) => ({ ...state, activity: 'traveling', stats: { ...(state.stats || {}), marketReturn: { spotId: 'old_ground' }, travel: { to: 'town', arrivalAt: T0 + 9000 } }, tag: `${tagOf(state)}>marketTravel` }),
        solo: () => ({ patch: { activity: 'hunting' }, events: [{ type: 'fight' }], debug: { fights: 1, wins: 1 } }),
        apply: (state, result) => ({ ...state, ...(result.patch || {}), tag: `${tagOf(state)}>apply` }),
        upsert: (state) => state,
        mammonFinish: null,
        mammonTravel: null,
        craftService: false,
        staleShopping: false,
        escrow: 0,
        bestSource: null,
        locked: false,
        partyRequest: null,
        planEvents: () => [],
        craft: null,
        craftTravel: null,
        partyWaiting: false,
        partyFallback: null,
        findSpot: spotA,
        physical: spotA,
        huntTrip: (state, trip, timestamp) => ({ ...state, activity: 'traveling', spotId: trip.spotId,
            stats: { ...(state.stats || {}), travel: { spotId: trip.spotId, mode: trip.mode, arrivalAt: timestamp + 5000 } }, tag: `${tagOf(state)}>huntTrip` }),
        limitsChanged: false,
        executePlan: (state) => Promise.resolve({ state: retag(state, 'board') }),
        leaf: null,
        inTown: false,
        reviewCold: (state) => Promise.resolve({ state: retag(state, 'improve'), changed: false }),
        edge: null,
        purchase: (state) => Promise.resolve({ state: retag(state, 'purchase'), purchased: false }),
        hotRow: () => null,
        canTradeRemotely: false,
        listingOpen: (state) => Promise.resolve({ state: retag(state, 'listingOpen'), listed: true }),
        finishVisit: () => null,
        goalReview: () => Promise.resolve({ current: { type: 'hunt' }, candidates: [{ type: 'hunt' }], economy: { e: 1 } }),
        survival: null
    };
}

function installStubs() {
    pinsActive = true;
    Config.developerDiagnostics = true;
    stubbed.push([Date, 'now', Date.now]);
    Date.now = () => T0 + (nowCalls++);
    stubbed.push([Math, 'random', Math.random]);
    Math.random = () => 0.25;
    stubbed.push([global.utils, 'infoWarn', global.utils.infoWarn]);
    global.utils.infoWarn = (...args) => record('infoWarn', args);
    stubbed.push([console, 'info', console.info]);
    console.info = (...args) => record('console.info', args);

    stub(Metrics, 'recordSkippedResolve', 'M.skipped', () => {});
    stub(Metrics, 'recordResolveDuration', 'M.duration', () => {});
    stub(Metrics, 'recordBackgroundResolve', 'M.background', () => {});
    stub(Metrics, 'recordCombat', 'M.combat', () => {});

    stub(TradeMeeting, 'hasPreparation', 'hasPreparation', (id) => cfg.prep(++cfg.prepCalls, id));
    stub(ColdVisit, 'needed', 'hall.needed', () => cfg.hallNeeded);
    stub(ColdVisit, 'resolve', 'hall.resolve', () => cfg.hallResult);
    stub(PartyMarketBreak, 'ready', 'marketBreak.ready', () => cfg.marketBreak);
    stub(BackgroundPartyState, 'find', 'party.find', () => null);
    stub(ColdKarmaPolicy, 'active', 'karma.active', () => !!cfg.karma);
    stub(ColdKarmaPolicy, 'plan', 'karma.plan', (state) => cfg.karma(state));

    stub(LifeState, 'cachedState', 'cachedState', (id) => cfg.cached(++cfg.cachedCalls, id));
    stub(LifeState, 'hotRow', 'hotRow', (id) => cfg.hotRow(id));
    stub(LifeState, 'applyResolve', 'applyResolve', (state, result, options) => {
        saves.push(['applyResolve', JSON.stringify(state), JSON.stringify(options)]);
        return Promise.resolve(cfg.apply(state, result, options));
    });
    stub(LifeState, 'upsertState', 'upsertState', (state, reason) => {
        saves.push(['upsertState', reason, JSON.stringify(state)]);
        return Promise.resolve(cfg.upsert(state, reason));
    });
    stub(LifeState, 'reviewTrainingAfterCommit', 'reviewTraining', (state) => Promise.resolve(retag(state, 'trained')));
    stub(LifeState, 'marketPurchaseBlocker', 'purchaseBlocker', () => null);
    stub(LifeEvents, 'recordMany', 'events.recordMany', () => Promise.resolve());
    stub(LifeEvents, 'record', 'events.record', () => Promise.resolve());

    stub(BotErrands, 'busyWith', 'errands.busyWith', () => false);
    stub(SurvivalFloor, 'forState', 'survival.forState', () => cfg.survival);
    stub(ItemDisposition, 'inventoryCleanupNeed', 'cleanupNeed', () => cfg.cleanupNeed);
    stub(ItemDisposition, 'npcOnlySlotCount', 'npcOnlySlots', () => 0);
    stub(NeedsEvaluator, 'cleanupGoal', 'cleanupGoal', (need) => cfg.cleanupGoal(need));
    stub(GoalExecutor, 'beginMarketTravel', 'beginMarketTravel', (state) => cfg.marketTravel(state));
    stub(GoalExecutor, 'finishMarketVisit', 'finishMarketVisit', (state) => cfg.finishVisit(state));

    stub(PartyRequestPlanner, 'expire', 'partyRequest.expire', (request) => request);
    stub(BackgroundResolver, 'resolveSolo', 'resolveSolo', (input) => cfg.solo(input));
    stub(BackgroundResolver, 'staleShopping', 'staleShopping', () => cfg.staleShopping);
    stub(Director, 'pressureForState', 'pressure', () => ({ p: 1 }));

    stub(MammonUnseal, 'finish', 'mammon.finish', (state) => Promise.resolve(cfg.mammonFinish(state)));
    stub(MammonUnseal, 'beginTravel', 'mammon.beginTravel', (state) => (cfg.mammonTravel ? cfg.mammonTravel(state) : null));
    stub(GearAcquisitionPlanner, 'isCraftService', 'isCraftService', () => cfg.craftService);
    stub(GearAcquisitionPlanner, 'bestSourceForPlan', 'bestSourceForPlan', () => cfg.bestSource);
    stub(GearAcquisitionPlanner, 'retargetPlanSource', 'retargetPlanSource', (state, plan, source) => ({ ...plan, retargeted: source.id }));
    stub(GearAcquisitionPlanner, 'clanGoalPlanLocked', 'clanGoalPlanLocked', () => cfg.locked);
    stub(GearAcquisitionPlanner, 'replacementPlanFor', 'replacementPlanFor', (state, plan) => ({ status: 'active', strategy: 'craft', replaces: plan.strategy }));
    stub(GearAcquisitionPlanner, 'finalizePlan', 'finalizePlan', (state, previous, replacement) => ({ ...replacement, finalized: true }));

    stub(SpotProfiles, 'ensure', 'spots.ensure', () => {
        if (cfg.ensureThrows) throw new Error('atlas_unavailable');
        return spots;
    });
    stub(SpotProfiles, 'currentOccupancy', 'spots.occupancy', () => ({ old_ground: 1 }));
    stub(SpotProfiles, 'findForState', 'spots.findForState', () => cfg.findSpot);
    stub(SpotProfiles, 'findById', 'spots.findById', (id) => spots.find((spot) => spot.id === id) || null);
    stub(SpotService, 'findCurrentSpot', 'spot.findCurrent', () => cfg.physical);
    stub(SpotService, 'arrivalPointForState', 'spot.arrivalPoint', (state, spot) => ({ ...spot.center }));
    stub(SpotRiskPolicy, 'excludedSpotIdsForStates', 'risk.excluded', () => ['bad_ground']);
    stub(SpotRiskPolicy, 'backoffForStates', 'risk.backoff', () => null);

    stub(BotAfkMarketService, 'buyOrderEscrow', 'buyOrderEscrow', () => cfg.escrow);
    stub(BotAfkMarketService, 'reviewPurchaseLimits', 'reviewPurchaseLimits', (state) => Promise.resolve({ state: retag(state, 'limits'), changed: cfg.limitsChanged }));
    stub(BotAfkMarketService, 'executePlan', 'executePlan', (state, plan, options) => cfg.executePlan(state, plan, options));
    stub(BotAfkMarketService, 'reconcile', 'reconcile', (state) => Promise.resolve({ state: retag(state, 'reconcile'), changed: false }));
    stub(BotAfkMarketService, 'canTradeRemotely', 'canTradeRemotely', () => cfg.canTradeRemotely);
    stub(BotAfkMarketService, 'desiredSide', 'desiredSide', () => 'sell');
    stub(PurchaseFunding, 'tripEscrow', 'tripEscrow', () => 0);
    stub(PurchaseFunding, 'spendable', 'spendable', () => 5000);
    stub(PurchaseFunding, 'budget', 'budget', () => 5000);

    stub(CraftTelemetry, 'planEvents', 'craft.planEvents', () => cfg.planEvents());
    stub(CraftTelemetry, 'stationTravelEvent', 'craft.stationTravelEvent', (state, travel) => ({ type: 'station_travel', stationId: travel.stationId }));
    stub(CraftTelemetry, 'progressEvents', 'craft.progressEvents', () => [{ type: 'progress' }]);
    stub(ColdCraftingService, 'craft', 'craft', (state) => Promise.resolve(cfg.craft(state)));
    stub(ColdCraftingService, 'beginTravel', 'craft.beginTravel', (state) => (cfg.craftTravel ? cfg.craftTravel(state) : null));
    stub(PartyWaitFallback, 'waiting', 'partyWait.waiting', () => cfg.partyWaiting);
    stub(PartyWaitFallback, 'spotFor', 'partyWait.spotFor', () => cfg.partyFallback);

    stubbed.push([Coordinator, 'economyDecisions', Coordinator.economyDecisions]);
    stubbed.push([Coordinator, 'worker', Coordinator.worker]);
    stubbed.push([Coordinator, 'workerEpoch', Coordinator.workerEpoch]);
    stubbed.push([Coordinator, 'stopping', Coordinator.stopping]);
    stubbed.push([Coordinator, 'fencedBots', Coordinator.fencedBots]);
    Coordinator.economyDecisions = {
        hold: (...args) => record('decisions.hold', args),
        release: (...args) => record('decisions.release', args),
        activity: (...args) => cfgCall('decisions.activity', args, () => cfg.leaf)
    };

    stub(BotImprovementService, 'inTown', 'improvement.inTown', () => cfg.inTown);
    stub(BotImprovementService, 'reviewCold', 'improvement.reviewCold', (state) => cfg.reviewCold(state));
    stub(CombinedErrands, 'edge', 'errands.edge', () => cfg.edge);
    stub(CraftWorkshopService, 'review', 'workshop.review', (state) => Promise.resolve(retag(state, 'workshop')));
    stub(ColdShotEconomyService, 'review', 'shots.review', (state) => Promise.resolve({ state: retag(state, 'shots') }));
    stub(ColdWealthCraftService, 'tryCraft', 'wealth.tryCraft', (state) => Promise.resolve({ state: retag(state, 'wealth') }));
    stub(BotWarehouse, 'releaseCold', 'warehouse.releaseCold', (state) => Promise.resolve({ state: retag(state, 'warehouse') }));
    stub(ColdMarketListingService, 'resolve', 'listing.resolve', (state) => Promise.resolve({ state: retag(state, 'listing'), closed: false }));
    stub(ColdMarketListingService, 'open', 'listing.open', (state) => cfg.listingOpen(state));
    stub(GoalService, 'currentForMarket', 'goal.currentForMarket', () => Promise.resolve({ current: cfg.marketGoal || { type: 'hunt' } }));
    stub(GoalService, 'review', 'goal.review', (state) => cfg.goalReview(state));
    stub(ColdMarketService, 'tryPurchase', 'market.tryPurchase', (state) => cfg.purchase(state));
    stub(ColdMarketService, 'finishTownErrands', 'market.finishTownErrands', (state) => Promise.resolve(retag(state, 'errands')));
    stub(GlobalChat, 'maybeAnnounce', 'chat.maybeAnnounce', () => {});
}

function hunter(extra = {}) {
    return {
        characterId: 501,
        name: 'Pin501',
        phase: 'cold',
        activity: 'hunting',
        level: 40,
        adena: 1000,
        spotId: spotA.id,
        currentRegion: 'Old Ground',
        loc: { ...spotA.center },
        inventory: {},
        timing: { lastResolvedAt: T0 - 30000 },
        stats: {},
        tag: 'in',
        ...extra
    };
}

const workerFight = (patch = {}) => ({
    patch: { activity: 'hunting', spotId: spotA.id, ...patch },
    events: [{ type: 'worker_fight' }],
    debug: { fights: 2, wins: 2 }
});

const marketPlan = { status: 'active', strategy: 'market', target: { selfId: 100, slot: 7, name: 'Sword' }, market: { price: 10 } };

const cases = {
    preparation_pending: () => {
        cfg.prep = () => true;
        return { state: hunter() };
    },
    hall_visit_value_passthrough: () => {
        cfg.hallNeeded = true;
        return { state: hunter(), workerRequest: { precomputedPlan: { statsPacket: { packet: 1 } } }, options: { workerAdmission: false } };
    },
    hall_visit_from_stats: () => {
        return { state: hunter({ stats: { clanHallVisit: { hallId: 3 } } }) };
    },
    party_market_break: () => {
        cfg.marketBreak = true;
        return { state: hunter({ stats: { partyMarketReturn: { partyId: 5, objective: { clanGoalKey: 'k1' } } } }) };
    },
    karma: () => {
        cfg.karma = (state) => ({ plannedState: { ...state, activity: 'pk_hunting', tag: 'karma' }, spot: spotB, targetNpcId: 77 });
        return { state: hunter(), options: { from: 'caller' } };
    },
    karma_but_joined: () => {
        cfg.karma = (state) => ({ plannedState: { ...state, activity: 'pk_hunting', tag: 'karma' }, spot: spotB, targetNpcId: 77 });
        cfg.cached = () => ({ party: { partyId: 9 } });
        return { state: hunter() };
    },
    joined_before_resolve: () => {
        cfg.cached = () => ({ party: { partyId: 9 } });
        return { state: hunter() };
    },
    cleanup_travel: () => {
        cfg.cleanupNeed = { itemCount: 12 };
        return { state: hunter() };
    },
    cleanup_travel_write_rejected: () => {
        cfg.cleanupNeed = { itemCount: 12 };
        cfg.upsert = () => null;
        return { state: hunter() };
    },
    transition_traveling: () => {
        cfg.solo = () => ({ patch: { activity: 'hunting', spotId: spotB.id }, events: [{ type: 'arrived' }], debug: { arrived: true } });
        return { state: hunter({ activity: 'traveling', stats: { travel: { spotId: spotB.id, arrivalAt: T0 - 1 }, partyRequest: { r: 1 } } }) };
    },
    transition_worker_result_with_card: () => {
        return {
            state: hunter({ activity: 'traveling', stats: { travel: { spotId: spotB.id, arrivalAt: T0 - 1 } } }),
            workerRequest: { precomputedResult: workerFight({ spotId: spotB.id }), precomputedPlan: { economyDecision: { card: 1 }, statsPacket: { packet: 2 } } },
            options: { workerAdmission: true }
        };
    },
    transition_apply_failed: () => {
        cfg.apply = () => null;
        return { state: hunter({ activity: 'traveling', stats: { travel: { spotId: spotB.id } } }), workerRequest: { precomputedPlan: { economyDecision: { card: 2 } } } };
    },
    transition_joined_after_solo: () => {
        cfg.solo = () => { cfg.joined = true; return workerFight(); };
        cfg.cached = () => (cfg.joined ? { party: { partyId: 4 } } : null);
        return { state: hunter({ activity: 'traveling', stats: { travel: { spotId: spotB.id } } }) };
    },
    transition_resting_no_market: () => {
        return { state: hunter({ activity: 'resting', stats: { restUntil: T0 + 100 } }) };
    },
    transition_resting_market_recovery: () => {
        return { state: hunter({ activity: 'resting', stats: { restUntil: T0 + 100, equipmentPlan: marketPlan } }) };
    },
    transition_resting_recovery_goal_fails: () => {
        cfg.goalReview = () => Promise.reject(new Error('goal_down'));
        return { state: hunter({ activity: 'resting', stats: { restUntil: T0 + 100, equipmentPlan: marketPlan } }) };
    },
    transition_resting_recovery_no_trip: () => {
        cfg.marketTravel = () => null;
        cfg.cached = (n) => (n >= 4 ? hunter({ tag: 'cachedAfterRecovery' }) : null);
        return { state: hunter({ activity: 'resting', stats: { restUntil: T0 + 100, equipmentPlan: marketPlan } }) };
    },
    transition_cleanup_after_worker_fight: () => {
        cfg.cleanupNeed = { itemCount: 30 };
        return { state: hunter(), workerRequest: { precomputedResult: workerFight() } };
    },
    transition_cleanup_after_fight_write_rejected: () => {
        cfg.cleanupNeed = { itemCount: 30 };
        cfg.upsert = () => null;
        return { state: hunter(), workerRequest: { precomputedResult: workerFight() } };
    },
    mammon_finish: () => {
        cfg.mammonFinish = (state) => ({ ...state, activity: 'hunting', tag: 'mammonDone' });
        return { state: hunter({ activity: 'crafting', stats: { mammonReturn: { at: 1 } } }) };
    },
    mammon_travel: () => {
        cfg.mammonTravel = (state) => ({ ...state, activity: 'traveling', tag: 'mammonTrip' });
        cfg.upsert = () => null;
        return { state: hunter() };
    },
    craft_service_idle: () => {
        cfg.craftService = true;
        return { state: hunter({ activity: 'crafting', stats: { equipmentPlan: { status: 'active' }, craftStationId: 's1' }, timing: { nextResolveAt: T0 + 5 } }) };
    },
    craft_completed_with_supply: () => {
        cfg.craft = (state) => ({ reason: 'crafted', state: retag(state, 'crafted'), supplementedMaterials: [{ amount: 2, name: 'Iron Ore' }],
            recipeId: 9, productId: 90, productName: 'Blade', stationId: 'forge', batchCount: 2 });
        return { state: hunter({ activity: 'crafting', stats: { equipmentPlan: { status: 'ready_to_craft' } } }) };
    },
    craft_component_completed: () => {
        cfg.craft = (state) => ({ reason: 'component_crafted', state: retag(state, 'component'), recipeId: 8, productId: 80, productName: 'Part', stationId: 'bench' });
        cfg.upsert = () => null;
        return { state: hunter({ activity: 'crafting', stats: {} }) };
    },
    craft_dual_combined: () => {
        cfg.craft = () => ({ reason: 'dual_sword_combined', recipeId: 7, productId: 70, productName: 'Duals', stationId: 'smith' });
        return { state: hunter({ activity: 'crafting', stats: {} }) };
    },
    craft_wait_recovers_hunting: () => {
        cfg.craft = (state) => ({ reason: 'materials_changed', state: retag(state, 'wait') });
        return { state: hunter({ activity: 'crafting', stats: { travel: { old: 1 } } }) };
    },
    craft_wait_travelling_kept: () => {
        cfg.craft = (state) => ({ reason: 'station_busy', state: { ...state, activity: 'traveling', tag: 'craftTrip' }, supplementedMaterials: [{ amount: 1, name: 'Coal' }] });
        return { state: hunter({ activity: 'crafting', stats: {} }) };
    },
    worker_plan_retarget: () => {
        cfg.bestSource = { id: 'src_b' };
        cfg.planEvents = () => [{ type: 'plan_changed' }];
        return {
            state: hunter({ stats: { equipmentPlan: { status: 'old' } } }),
            workerRequest: { precomputedPlan: {
                acquisitionPlan: { status: 'active', strategy: 'direct_drop', next: { spotId: spotA.id, npcId: 42 } },
                previousPlan: { status: 'active', strategy: 'market', target: { name: 'Helm' } },
                replanFailure: { targetId: 9, reason: 'no_drop' }
            } }
        };
    },
    worker_plan_replace: () => {
        cfg.partyRequest = { objective: 'boss' };
        return {
            state: hunter({ stats: { partyRequest: { stale: true } } }),
            workerRequest: { precomputedPlan: {
                acquisitionPlan: { status: 'active', strategy: 'craft', next: { spotId: spotB.id } },
                previousPlan: null
            } }
        };
    },
    worker_plan_locked: () => {
        cfg.locked = true;
        return {
            state: hunter(),
            workerRequest: { precomputedPlan: {
                acquisitionPlan: { status: 'active', strategy: 'direct_drop', next: { spotId: spotB.id, npcId: 5 } },
                previousPlan: { status: 'x' }
            } }
        };
    },
    craft_travel: () => {
        cfg.planEvents = () => [{ type: 'plan' }];
        cfg.craftTravel = (state) => ({ ...state, activity: 'traveling', timing: { ...state.timing, stale: 1 },
            stats: { ...state.stats, travel: { stationId: 'forge', arrivalAt: T0 + 7000 } }, tag: 'craftTravel' });
        return { state: hunter() };
    },
    craft_travel_write_rejected: () => {
        cfg.craftTravel = (state) => ({ ...state, activity: 'traveling', stats: { ...state.stats, travel: { arrivalAt: T0 + 7000 } }, tag: 'craftTravel' });
        cfg.upsert = () => null;
        return { state: hunter() };
    },
    missing_spot: () => {
        cfg.findSpot = null;
        return { state: hunter({ stats: { routeRecovery: { attempts: 2 } } }) };
    },
    missing_spot_write_rejected: () => {
        cfg.findSpot = null;
        cfg.upsert = () => null;
        return { state: hunter() };
    },
    hunting_trip_to_new_spot: () => {
        cfg.findSpot = spotB;
        return { state: hunter() };
    },
    party_wait_fallback: () => {
        cfg.partyWaiting = true;
        cfg.partyFallback = { spot: spotB, npcId: 55 };
        return { state: hunter({ activity: 'resting' }) };
    },
    party_wait_without_fallback: () => {
        cfg.partyWaiting = true;
        return { state: hunter({ activity: 'shopping' }) };
    },
    worker_command_spot: () => {
        return { state: hunter(), workerRequest: { precomputedResult: workerFight(), context: { route: { needed: true, spotId: spotB.id } } } };
    },
    main_hunt_default: () => ({ state: hunter() }),
    main_stale_shopping: () => {
        cfg.staleShopping = true;
        return { state: hunter({ activity: 'shopping' }) };
    },
    main_apply_failed: () => {
        cfg.apply = () => null;
        return { state: hunter(), workerRequest: { precomputedPlan: { economyDecision: { card: 3 }, statsPacket: { packet: 3 } } } };
    },
    main_joined_after_planning: () => {
        cfg.solo = () => { cfg.joined = true; return workerFight(); };
        cfg.cached = () => (cfg.joined ? { party: { partyId: 4 } } : null);
        return { state: hunter() };
    },
    main_limits_changed_skips_plan: () => {
        cfg.limitsChanged = true;
        return { state: hunter({ activity: 'shopping' }), workerRequest: { precomputedResult: workerFight({ activity: 'shopping' }), precomputedPlan: { economyPlan: { buy: 1 } } } };
    },
    main_shopping_economy_plan: () => {
        cfg.inTown = true;
        cfg.executePlan = (state, plan, options) => {
            options.beforeWrite();
            return Promise.resolve({ state: retag(state, 'board') });
        };
        cfg.finishVisit = (state) => ({ ...state, activity: 'traveling', tag: 'visitDone' });
        cfg.cached = () => ({ characterId: 501, phase: 'cold', activity: 'shopping', tag: 'cachedCold' });
        return {
            state: hunter({ activity: 'shopping', currentRegion: 'Giran' }),
            workerRequest: { precomputedResult: workerFight({ activity: 'shopping' }), precomputedPlan: { economyPlan: { buy: 1 }, economyDecision: { card: 4 }, statsPacket: { packet: 4 } } }
        };
    },
    main_shopping_stale_worker_refusal: () => {
        cfg.executePlan = (state, plan, options) => {
            Coordinator.workerEpoch = 99;
            try { options.beforeWrite(); } catch (error) { return Promise.reject(error); }
            return Promise.resolve({ state });
        };
        return {
            state: hunter({ activity: 'shopping' }),
            workerRequest: { precomputedResult: workerFight({ activity: 'shopping' }), precomputedPlan: { economyPlan: { buy: 1 }, economyDecision: { card: 5 } } }
        };
    },
    main_shopping_hot_fence_refusal: () => {
        cfg.executePlan = (state, plan, options) => {
            Coordinator.fencedBots = new Set([501]);
            try { options.beforeWrite(); } catch (error) { return Promise.reject(error); }
            return Promise.resolve({ state });
        };
        return {
            state: hunter({ activity: 'shopping' }),
            workerRequest: { precomputedResult: workerFight({ activity: 'shopping' }), precomputedPlan: { economyPlan: { buy: 1 } } }
        };
    },
    main_giran_improvement_changed: () => {
        cfg.inTown = true;
        cfg.leaf = { activity: 'improving', improvement: { kind: 'crystallize' } };
        cfg.reviewCold = (state) => Promise.resolve({ state: retag(state, 'crystallized'), changed: true });
        return { state: hunter({ currentRegion: 'Giran' }), workerRequest: { precomputedResult: workerFight(), context: { spot: { id: spotA.id } }, precomputedPlan: { economyDecision: { card: 6 } } } };
    },
    main_giran_improvement_unchanged: () => {
        cfg.inTown = true;
        cfg.leaf = { activity: 'improving', improvement: { kind: 'luxury_exchange' } };
        const town = invoke('GameServer/World/TownRespawn').towns.giran_town;
        return { state: hunter({ currentRegion: 'Giran', loc: { locX: town.locX, locY: town.locY, locZ: town.locZ } }),
            workerRequest: { precomputedResult: workerFight(), context: { spot: { id: spotA.id } } } };
    },
    main_crafting_after_apply: () => {
        cfg.solo = () => ({ patch: { activity: 'crafting' }, events: [], debug: { craft: true } });
        return { state: hunter() };
    },
    main_purchased_batch: () => {
        cfg.purchase = (state) => Promise.resolve({ state: retag(state, 'bought'), purchased: true });
        return { state: hunter({ timing: { lastResolvedAt: T0 - 500, activityStartedAt: T0 - 400 } }) };
    },
    main_purchase_pending: () => {
        cfg.purchase = (state) => Promise.resolve({ state: retag(state, 'pending'), pending: true });
        return { state: hunter() };
    },
    main_hot_row_after_purchase: () => {
        cfg.hotRow = () => ({ characterId: 501, phase: 'hot', activity: 'hunting', tag: 'hot' });
        return { state: hunter() };
    },
    main_hot_row_after_errands: () => {
        cfg.hotRowCalls = 0;
        cfg.hotRow = () => (++cfg.hotRowCalls >= 2 ? { characterId: 501, phase: 'hot', activity: 'hunting', tag: 'hotLater' } : null);
        return { state: hunter() };
    },
    main_forced_cleanup_listing: () => {
        cfg.purchase = (state) => Promise.resolve({ state: { ...state, stats: { ...state.stats, forcedMarketCleanup: { itemCount: 3 } }, tag: 'cleanupBag' } });
        return { state: hunter() };
    },
    main_forced_cleanup_listing_in_shop: () => {
        cfg.purchase = (state) => Promise.resolve({ state: { ...state, activity: 'shopping', stats: { ...state.stats, forcedMarketCleanup: { itemCount: 3 } }, tag: 'cleanupBag' } });
        cfg.listingOpen = (state) => Promise.resolve({ state: retag(state, 'opened'), listed: true });
        return { state: hunter() };
    },
    main_listing_pending: () => {
        cfg.marketGoal = { type: 'sell_inventory' };
        cfg.listingOpen = (state) => Promise.resolve({ state: retag(state, 'openPending'), pending: true });
        return { state: hunter() };
    },
    main_remote_trade_listing: () => {
        cfg.marketGoal = { type: 'sell_inventory' };
        cfg.canTradeRemotely = true;
        return { state: hunter() };
    },
    main_trip_edge_market_travel: () => {
        cfg.edge = { edge: 'town' };
        return { state: hunter() };
    },
    main_survival_unload_travel: () => {
        cfg.survivalCalls = 0;
        cfg.survival = null;
        cfg.marketTravel = (state) => ({ ...state, activity: 'traveling', tag: `${tagOf(state)}>unloadTrip` });
        const base = hunter();
        // Only the post-review survival check asks to unload.
        SurvivalFloor.forState = (...args) => cfgCall('survival.forState', args, () => (++cfg.survivalCalls >= 2 ? { action: 'unload' } : null));
        return { state: base };
    },
    main_goal_review_fails: () => {
        cfg.goalReview = () => Promise.reject(new Error('review_down'));
        return { state: hunter() };
    },
    main_preparation_at_review: () => {
        cfg.prep = (n) => n >= 3;
        return { state: hunter() };
    },
    main_preparation_after_errands: () => {
        cfg.prep = (n) => n >= 2;
        cfg.finishVisit = () => assert.fail('a preparing bot must not finish its visit');
        return { state: hunter() };
    },
    main_cached_state_after_commit: () => {
        cfg.cached = (n) => (n >= 4 ? hunter({ tag: 'cachedCommit' }) : null);
        return { state: hunter() };
    },
    main_worker_admission: () => ({ state: hunter(), options: { workerAdmission: { owner: 1 } } }),
    sync_throw_on_atlas: () => {
        cfg.ensureThrows = true;
        return { state: hunter() };
    }
};

async function runCase(name) {
    cfg = { ...defaults(), prepCalls: 0, cachedCalls: 0 };
    trace.length = 0;
    saves.length = 0;
    nowCalls = 0;
    Coordinator.worker = 'W1';
    Coordinator.workerEpoch = 1;
    Coordinator.stopping = false;
    Coordinator.fencedBots = new Set();
    const surviving = SurvivalFloor.forState;
    const input = cases[name]();
    const options = input.options;
    const optionsBefore = JSON.stringify(options);
    const deferredBefore = Number(PopulationService.planDeferred || 0);
    startClock();
    let returned;
    let syncThrow = null;
    try {
        returned = input.workerRequest || options
            ? PopulationService.resolveColdState(input.state, input.workerRequest || null, options)
            : PopulationService.resolveColdState(input.state);
    } catch (error) {
        syncThrow = error.message;
    }
    const kind = syncThrow ? `throw:${syncThrow}` : (returned && typeof returned.then === 'function') ? 'promise' : 'value';
    trace.push(`${tick} <returned ${kind}>`);
    let outcome;
    if (!syncThrow) {
        try {
            outcome = JSON.stringify(await returned);
        } catch (error) {
            outcome = `rejected:${error.name}:${error.message}`;
        }
    }
    const settled = tick;
    ticking = false;
    SurvivalFloor.forState = surviving;
    assert.strictEqual(JSON.stringify(options), optionsBefore, `${name}: caller options must stay unchanged`);
    return {
        trace: [...trace],
        saves: saves.map((entry) => entry.join(' | ')),
        outcome: outcome ?? null,
        settledTick: settled,
        planDeferred: Number(PopulationService.planDeferred || 0) - deferredBefore,
        dateNowCalls: nowCalls
    };
}

async function run() {
    assert.notStrictEqual(PopulationService.resolveColdState.constructor.name, 'AsyncFunction',
        'resolveColdState must stay synchronous: callers rely on its synchronous throws and pass-through values');
    installStubs();
    const actual = {};
    try {
        for (const name of Object.keys(cases)) actual[name] = await runCase(name);
    } finally {
        ticking = false;
        pinsActive = false;
        restoreAll();
    }
    if (process.env.PIN_RECORD) {
        require('fs').writeFileSync(require('path').join(__dirname, 'fixtures/resolve_cold_state_pins.json'), `${JSON.stringify(actual, null, 1)}\n`);
        console.log('recorded', Object.keys(actual).length, 'cases');
        return;
    }
    const EXPECTED = require('./fixtures/resolve_cold_state_pins.json');
    assert.deepStrictEqual(Object.keys(actual), Object.keys(EXPECTED), 'case list changed');
    for (const name of Object.keys(EXPECTED)) {
        assert.deepStrictEqual(actual[name], EXPECTED[name], `resolveColdState pin "${name}" changed`);
    }
    // Spot checks that the recorded pins mean what they say.
    assert.match(actual.sync_throw_on_atlas.trace.at(-1), /<returned throw:atlas_unavailable>/);
    assert.match(actual.hall_visit_value_passthrough.trace.at(-1), /<returned value>/);
    assert.strictEqual(actual.hall_visit_value_passthrough.outcome, JSON.stringify({ hall: 'visit-result' }));
    assert.match(actual.preparation_pending.outcome, /"pending":true/);
    assert.match(actual.main_shopping_stale_worker_refusal.outcome, /^rejected:.*stale_worker_source/);
    assert.match(actual.main_shopping_hot_fence_refusal.outcome, /^rejected:.*hot_handoff_fenced/);
    assert.strictEqual(actual.main_hunt_default.planDeferred, 1);
    assert.strictEqual(actual.worker_plan_retarget.planDeferred, 0);
    console.log(`resolveColdState pins passed (${Object.keys(actual).length} cases)`);
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
