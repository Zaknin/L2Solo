'use strict';
const ClassProgression = invoke('GameServer/ClassProgression');

const GearThreat = require('./GearThreat');

const ItemIndex = require('../../Item/ItemTemplateIndex');
const Valuation = require('./EconomicValuation');
const Providers = require('./WishProviders');
const Sections = require('./DecisionSections');
// Read through the module object at call time (tests replace withProfileScope).
const CombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const SpotRiskPolicy = require('../Population/SpotRiskPolicy');
const { WishNetwork, remember, admitRoots, remainingQuantity, moneyQueue, cashCharge } = require('./WishNetwork');
const { isMainThread } = require('node:worker_threads');
const { deflateRawSync, inflateRawSync } = require('node:zlib');
const Diagnostics = require('./EconomyDiagnostics');
const { fnv1a32 } = require('../Fnv1a');
const engine = new WishNetwork();
const Trip = require('./EconomicTrip');
const FENCE_BYTES = 4096;
const FENCE_RAW_BYTES = 65536, FENCE_SPOTS = 4096;
const SOURCE_MEMO_LIMIT = 8;
const fenceEncoder = new TextEncoder(), fenceDecoder = new TextDecoder();
let routeAnchors = new WeakMap();
let mainColdForState = null;
let runtime = {};
const extensions = new Map();
function configure(providers = {}) { runtime = providers; reset(); }
function registerProvider(key, provider) {
    if (typeof provider !== 'function') throw new TypeError('invalid_economy_provider');
    extensions.set(key, provider); reset();
}
// actorKey -> { key, reads, plan, stateRef, gearThreat } of bots: bounded
// (WishNetwork.remember). The plan is data (planOf); a reader gets view().
const cache = new Map();
let planningContexts = 0;
function setPlanningContexts(count) {
    planningContexts = Math.max(0, Math.min(64, Math.floor(Number(count) || 0)));
    while (cache.size > 64 - planningContexts) {
        const key = cache.keys().next().value; cache.delete(key); engine.forget(key, 'planning_capacity');
        if (Diagnostics.active()) { Diagnostics.count('context', 'eviction', 'planning_capacity'); noteRelease(key, 'planning_capacity'); }
    }
}
// Groups apart, so a party composition that weighs many candidate groups
// never evicts the bots' own reviews: `group:<partyId>` -> { key, ids,
// context }, removed when the party ends (forgetGroup) and bounded besides;
// a proposed composition (`proposal:` party id) is built and not kept.
const groups = new Map();
const GROUP_LIMIT = 256;
// Shadow count (perf item 1, diagnostics only): per actor the hash of its last
// input key, when that build ran and what released its context since, to count
// rebuilds whose inputs equal the bot's previous request (a retained context
// would have served them), how long after it, and what dropped the context
// (perf B1: only a short gap is reachable within the worker's memory budget).
// The entry also keeps the hash of the plan that build produced (focus, queue
// with funding, activity, dormant), so a rebuild is counted by whether its
// inputs and its plan repeated the actor's previous build: how many rebuilds
// change nothing a bot does (the B5 question). It never decides anything.
const lastKeyHashes = new Map();
const LAST_KEY_LIMIT = 8192;
const GAP_BUCKETS = [[1000, 'lt1s'], [5000, '1_5s'], [15000, '5_15s'], [30000, '15_30s'], [60000, '30_60s'], [120000, '60_120s']];
const gapBucket = ms => GAP_BUCKETS.find(([limit]) => ms < limit)?.[1] || 'ge120s';
// A build forState did not keep stays 'unkept': a later release of an older
// kept context of the same actor is not its release.
function noteRelease(actorKey, reason) {
    const last = lastKeyHashes.get(actorKey);
    if (last && last.released !== 'unkept') last.released = reason;
}
const positive = value => Math.max(0, Number(value) || 0);
// What a bot acts on from its plan: the focus key, the ordered queue with its
// funding, the chosen activity and the dormant keys; prices and play-hour
// stamps inside focus/dormant rows are not acted on. Shadow count only.
const planHash = network => fnv1a32(JSON.stringify([network.focus?.[0] ?? null, (network.queue || []).map(row => [row.key, row.funded === true]),
    network.activity?.key ?? network.activity?.kind ?? null, (network.dormant || []).map(row => Array.isArray(row) ? row[0] : row)]));

function stateForActor(actor, session = actor?.session) {
    const stored = session?.coldLifeState || {};
    const current = invoke('GameServer/Bot/Population/BotLifeState').cachedState?.(actor.fetchId?.());
    const inventory = {};
    const physicalInventory = actor.backpack?.fetchItems?.() || [];
    for (const item of physicalInventory) {
        const id = Number(item.fetchSelfId?.());
        if (!id) continue;
        const amount = positive(item.fetchAmount?.());
        const equipped = !!item.fetchEquipped?.();
        const previous = inventory[id];
        inventory[id] = { selfId: id, amount: amount + positive(previous?.amount),
            equipped: equipped || previous?.equipped, equippedCount: Number(equipped) + positive(previous?.equippedCount),
            slot: equipped ? Number(item.fetchSlot?.()) : previous?.slot || 0,
            enchant: item.fetchEnchantLevel?.() ?? item.fetchEnchant?.() ?? 0, stackable: item.fetchStackable?.(),
            instances: [...(previous?.instances || []), { id: item.fetchId?.(), selfId: id, amount, equipped,
                slot: Number(item.fetchSlot?.() || 0), enchant: item.fetchEnchantLevel?.() ?? item.fetchEnchant?.() ?? 0 }] };
    }
    const hotKit = invoke('GameServer/Bot/Population/ColdCombatProfile').capture(actor);
    const state = { ...stored, characterId: actor.fetchId?.(), level: actor.fetchLevel?.(), inventory, physicalInventory,
        clanId: Number(actor.fetchClanId?.() ?? stored.clanId ?? stored.stats?.clanId ?? 0),
        craftLevel: actor.backpack?.fetchDwarvenCraftLevel?.(actor) ?? stored.craftLevel,
        acceptedIncoming: current?.acceptedIncoming || stored.acceptedIncoming || {},
        incomingPending: current ? current.incomingPending === true : stored.incomingPending === true,
        adena: actor.backpack?.fetchItemFromSelfId?.(57)?.fetchAmount?.() || 0,
        sp: actor.fetchSp?.() ?? stored.sp,
        spotId: session?.currentSpot?.id || stored.spotId,
        stats: { ...session?.heldEconomy?.statsPacket, ...session?.decisionStats, ...stored.stats, coldCombat: hotKit, hennas: [...(session?.hennas || stored.stats?.hennas || [])], soulCrystalQuest: session?.questStates?.get(350)?.isStarted() === true || stored.stats?.soulCrystalQuest, classId: actor.fetchClassId?.(), exp: actor.fetchExp?.(), karma: actor.fetchKarma?.(), pk: actor.fetchPk?.() },
        party: session?.hotBackgroundPartyId ? { partyId: session.hotBackgroundPartyId, role: stored.party?.role } : null,
        activity: session?.plan || 'hunting' };
    const loc = { locX: Number(actor.fetchLocX?.()), locY: Number(actor.fetchLocY?.()), locZ: Number(actor.fetchLocZ?.()) };
    if (!Object.values(loc).every(Number.isFinite)) Object.assign(loc, stored.loc || {});
    state.loc = loc;
    return routeState(state, session);
}
function routeState(state, session) {
    if (!session || typeof session !== 'object') return state;
    const frame = Trip.frame(state); frame.loc = null;
    const event = JSON.stringify([state.spotId, state.stats?.decisionSeq, frame]);
    const held = routeAnchors.get(session);
    const anchor = held?.event === event ? held : { event, loc: state.loc };
    routeAnchors.set(session, anchor);
    return { ...state, loc: anchor.loc };
}
const rowKey = row => [row.selfId, row.amount, row.equippedCount || row.equipped,
    row.slot, row.enchant, row.stackable, row.starterMobLootAmount, row.kind, row.rank,
    row.reservedAmount, row.protectedAmount, row.protected, row.acceptedCustomer, row.assignedClan, row.available,
    (row.instances || []).map(item=>[item.id,item.enchant,item.slot,item.equipped,item.amount].join('/')).join(';')].join(':');
// ARCH-NOTE: PERF: a bag row is not mutated while one forState build runs.
// Once the build's own key missed the held one (rowKeys set: a miss or the
// own-result check), a row's key part is made once and shared by the state's
// later keys and its section copies, whose unbanded rows are the same
// objects. The same-inputs hit makes one key and sets nothing. A nested build
// starts without it; it dies when forState returns.
let rowKeys = null;
const heldRowKey = row => {
    if (row === null || typeof row !== 'object') return rowKey(row);
    let key = rowKeys.get(row);
    if (key === undefined) rowKeys.set(row, key = rowKey(row));
    return key;
};
function inputKey(state, deps = {}) {
    const stats = state.stats || {};
    const items = Object.values(state.inventory || {}).map(rowKeys === null ? rowKey : heldRowKey).sort().join(',');
    // A native bag change, own sample or relation revision is an input event.
    // No timing poll, no world-wide counter: the board and the market are
    // inputs only through the items the bot read (see `market` in forState).
    return [state.level, stats.classId, state.craftLevel ?? stats.dwarvenCraftLevel, items, positive(state.adena), stats.decisionSeq, stats.activityLeaf, stats.visitEvery?.[0], stats.visitEvery?.[1],
        deps.workshop?.recipeId, deps.workshop?.productId, deps.workshop?.incomePerHour, deps.workshop?.cycleHours,
        Providers.recipeIds(state, deps).join(','), deps.producerRevision ?? '',
        Number(stats.shotRecipeDemand?.at) + 30 * 60 * 1000 > Number(deps.timestamp || Date.now())
            ? Number(stats.shotRecipeDemand.itemId) : 0,
        Number(state.vitals?.mp), positive(deps.buyOrderEscrow),
        Math.floor(positive(stats.frustration) * 10), stats.karma, stats.clanId, state.clanId, state.party?.partyId, state.partyId,
        stats.generatedCold, stats.race, stats.marketSellRetryAfter,
        Number(stats.marketSellRetryAfter || 0) > Number(deps.timestamp || Date.now()),
        invoke('GameServer/Bot/Economy/ItemDisposition').reservationInputKey(state), JSON.stringify(stats.clanMaterialDemand || null),
        invoke('GameServer/Bot/Economy/PersonalWarehouseIndex').version(state),
        state.spotId, deps.gearThreatMask ?? GearThreat.maskFor(state, deps), stats.huntEfficiency?.[0]?.at, deps.memory?.revision || stats.memoryRevision || 0,
        deps.inputKey || '', deps.mode || '', state.incomingPending === true, JSON.stringify(state.acceptedIncoming || null), Trip.key(state), deps.routeRows ? 'route_ready' : deps.tripCost ? 'route_given' : 'route_pending', stats.pk, stats.soulCrystalQuest, (stats.hennas || []).join(','),
        Math.floor(positive(stats.exp ?? state.exp) / Math.max(1, positive(state.level) ** 2 * 100)),
        deps.knowledgeEnabled ?? invoke('GameServer/Bot/AI/KnowledgeLearning').knowledgeEnabled(),
        stats.production?.crafts || 0, positive(state.sp),
        (stats.coldCombat?.skills || state.skills || []).map(row => `${row.selfId}:${row.level}`).join(',')].join('|');
}
// Every section keeps only its used inputs. Current combat resources and
// financial facts do not invalidate a sword's benefit or its source graph.
// A caller reads one part: the build compares only its source sections, the
// verdict and the fence only the structure, so the other key is not built (L73).
function sectionKeys(state, deps = {}, bands = [], part = 'structural') {
    const stats = state.stats || {}, inventory = { ...state.inventory };
    const role = state.party?.role || stats.role || invoke('GameServer/Bot/AI/BotRoles').inferRole(stats.classId || 0);
    const partyId = Number(state.party?.partyId || state.partyId || 0);
    delete inventory[57];
    for (const [id, low, high, original] of bands) {
        const row = inventory[id], amount = Number(row?.amount);
        if (!row || !(amount >= low) || high !== null && !(amount <= high)) continue;
        const template = ItemIndex.find(invoke('GameServer/DataCache').items, Number(id));
        // The native loot projection omits a free stack's default metadata;
        // DB publication restores it. Its actual flags and ownership remain
        // inputs, while absent false/zero fields describe the same stack.
        inventory[id] = { ...row, amount: original,
            equipped: !!row.equipped, equippedCount: Number(row.equippedCount || 0),
            slot: Number(row.slot || 0), enchant: row.enchant === null ? null : Number(row.enchant || 0),
            stackable: row.stackable ?? template?.etc?.stackable,
            ...(row.instances ? { instances: row.instances.map(item => ({ ...item,
                amount: Number(item.amount) >= low && (high === null || Number(item.amount) <= high) ? original : item.amount })) } : {}) };
    }
    const plan = stats.equipmentPlan;
    // The planner publishes this known empty result after the wish review.
    // It names no target, reservation or next action. Unknown plan fields
    // keep the exact dependency instead of being treated as an empty plan.
    const calculationPlan = Sections.isEmptyWishPlan(plan) ? null : plan;
    const stable = { ...state, adena: 0, sp: 0, inventory,
        party: partyId ? { ...state.party, partyId, role } : null, partyId,
        clanId: Number(state.clanId ?? stats.clanId ?? 0),
        vitals: { ...state.vitals, mp: 0 },
        stats: { ...stats, role, clanId: Number(stats.clanId ?? state.clanId ?? 0),
            karma: stats.karma ?? 0, decisionSeq: 0, activityLeaf: 0, exp: 0, huntEfficiency: [] } };
    const build = Sections.capability(state, deps.timestamp);
    if (part === 'structural') return { build, structural: `${inputKey(stable, deps)}|${build}|${JSON.stringify([
        calculationPlan, stats.craftStationId, stats.persona, Number(stats.spotRisk?.windowDeaths || 0),
        state.marketTrades, stats.marketTrades, stats.relations,
        stats.production, role, state.accountName])}` };
    const sourceStable = { ...stable, inventory: Object.fromEntries(Object.entries(inventory)
        .filter(([, row]) => row.equipped || row.equippedCount)), stats: { ...stable.stats, memoryRevision: 0 } };
    const sourceKey = `${inputKey(sourceStable, { ...deps, memory: null })}|${build}|${Sections.hash([
        calculationPlan, stats.craftStationId, stats.persona, state.marketTrades, stats.marketTrades,
        role, state.accountName,
        // Source descriptors include route admission. Reuse only while the
        // native active exclusions are equal at this already scheduled review.
        [...SpotRiskPolicy.excludedSpotIdsForStates([state], deps.timestamp)].sort(),
        stats.huntEfficiency, stats.huntClock, stats.spotRisk,
        stats.money ? [stats.money[0], Number(stats.money[3]) > 0] : stats.wishFocus?.[2],
        stats.exp ?? state.exp,
        Number(state.craftLevel ?? stats.dwarvenCraftLevel) > 0 ? state.vitals?.mp : 0])}`;
    return { build, sources: sourceKey };
}
// Diagnostics only (L115): the group name of each '|' segment of the
// structural key above, in its order: the inputKey fields, then the
// capability, then the JSON tail (equipment plan, persona, spot deaths,
// market trades, relations, production, role, account). A bounded set of
// 16 names keeps the worker's counter keys few. The positions hold while no
// field before the differing one contains '|' (all are numbers, ids, or
// JSON of numbers and town names). The trip part is named apart (L114):
// the hunting spot, the route rows' readiness, and inside Trip.key the
// field that moved (travel or activity before location, since a new
// travel or activity also releases the session's location anchor).
const STRUCTURAL_SEGMENTS = [
    'progress', 'progress', 'progress', 'loot', 'other', 'other', 'other', 'other', 'other',
    'workshop', 'workshop', 'workshop', 'workshop', 'workshop', 'workshop', 'time', 'other', 'other',
    'frustration', 'other', 'other', 'other', 'other', 'other', 'other', 'other',
    'time', 'time', 'clan_loot', 'clan_loot', 'clan_loot', 'spot_id', 'gear_threat', 'other', 'memory',
    'other', 'other', 'other', 'other', 'trip_key', 'route_ready', 'other', 'other', 'other', 'progress', 'other',
    'workshop', 'progress', 'progress', 'build'];
// held/current: the two structural keys, to name the Trip.key field.
function structuralSegment(index, held = null, current = null) {
    const name = index < STRUCTURAL_SEGMENTS.length ? STRUCTURAL_SEGMENTS[index] : 'plan_tail';
    if (name !== 'trip_key' || held === null || current === null) return name;
    try {
        const [, a] = JSON.parse(held.split('|')[index]), [, b] = JSON.parse(current.split('|')[index]);
        const same = field => JSON.stringify(field(a)) === JSON.stringify(field(b));
        if (!same(row => [row.activity, row.stats?.travel])) return 'trip_travel';
        return same(row => row.loc) ? 'trip_other' : 'trip_loc';
    } catch { return 'trip_other'; }
}
// L70: the bot's own hunting/resting/travelling is not an economic event.
// Only this kind is equalised; location, region and the travel target stay
// exact inside Trip.key, so 'to town' never matches 'to a spot'. One trip
// is the plan itself: a hunter or rester leaving for its held hunting
// leaf's own spot. Only that trip record is dropped from the comparison;
// a trip to any other spot or a town, and the arrival, stay exact.
const FIELD_ACTIVITIES = new Set(['hunting', 'resting', 'traveling']);
function fieldActivity(state, activity, leaf = null) {
    if (!activity || activity === state.activity || !FIELD_ACTIVITIES.has(activity) || !FIELD_ACTIVITIES.has(state.activity)) return state;
    const travel = state.stats?.travel;
    return travel && state.activity === 'traveling' && leaf?.activity === 'hunting' && leaf.spotId != null
        && travel.spotId != null && String(travel.spotId) === String(leaf.spotId)
        && travel.arrivalActivity === 'hunting' && travel.townName == null
        ? { ...state, activity, stats: { ...state.stats, travel: null } } : { ...state, activity };
}
// The held leaf's own purchase item stays exact: its order counts only the
// rise since the decision (remainingToOrder), so use inside a band would buy short.
function bandsHold(state, bands = [], leaf = null) {
    const bought = leaf?.activity === 'shopping' ? Number(leaf.itemId) || 0 : 0;
    for (const [id, low, high, original] of bands) {
        const amount = Number(state.inventory?.[id]?.amount);
        if (bought && Number(id) === bought ? amount !== original
            : !(amount >= low) || high !== null && !(amount <= high)) return false;
    }
    return true;
}
// The event part of the one verdict "the held plan is still valid" (L70),
// called by both held-plan stores: the cache entry (decisionHolds) and the
// card (ColdEconomyDecision.canReuse). A raised event (wishDirty) and a
// crafter's MP cut through at once; money is hard below the lower cash
// bound or on a moved funding mark; soft money, observation and horizon
// changes wait for their kind's delay since the last actual decision.
// held: { baseline, mp, expPerHour, persona } of the last actual decision.
// A failing check names itself in `why` (an array or null) and fails.
const miss = (why, reason) => { why?.push(reason); return false; };
// why: an array that receives the failing event's name (L114 diagnostics).
function heldEventsQuiet(state, held, timestamp, deps = {}, deferred = null, why = null) {
    const stats = state.stats || {}, baseline = held.baseline;
    if (stats.wishDirty) return miss(why, 'wish_dirty');
    if (Number(state.craftLevel ?? stats.dwarvenCraftLevel) > 0
        && Number(state.vitals?.mp) !== Number(held.mp)) return miss(why, 'crafter_mp');
    if (Sections.moneyEvent(state, baseline, timestamp)) return miss(why, 'money');
    if (Sections.observationEvent(state, baseline, timestamp, deps.mode)) return miss(why, 'observation');
    if (Sections.horizonEvent(state, baseline, held.expPerHour, held.persona, timestamp)) return miss(why, 'horizon');
    if (deferred) {
        if (Sections.meaningfulMoney(state, baseline)) deferred.push('money');
        if (Sections.observationChanged(state, baseline, timestamp, deps.mode)) deferred.push('observation');
        if (Sections.horizonChanged(state, baseline, held.expPerHour, held.persona)) deferred.push('horizon');
    }
    return true;
}
// The cache store of the verdict: the shared events, then the band-aware
// structure of the build (as its calculation fence) and bag slots/weight.
function decisionHolds(state, held, timestamp, deps, deferred = null) {
    if (!held || held.bandHash === undefined || held.plan.pending
        || extensions.size || deps.nodes?.length || deps.withNodes && !held.projection) return false;
    const stats = state.stats || {};
    const sameDecision = Number(stats.decisionSeq || 0) === Number(held.plan.statsPacket.decisionSeq || 0)
        || held.key === inputKey(state, { ...deps, timestamp });
    if (!sameDecision || !heldEventsQuiet(state, { baseline: held.plan.statsPacket.wishSections, mp: held.mp,
        expPerHour: held.plan.hunt.expPerHour, persona: held.plan.persona }, timestamp, deps, deferred)) return false;
    const bands = held.plan.quantityBands || [];
    if (!bandsHold(state, bands, held.plan.network?.activity) || fnv1a32(sectionKeys(fieldActivity(state, held.activity, held.plan.network?.activity),
        { ...deps, timestamp }, bands).structural) !== held.bandHash) return false;
    const safety = bagSafety(state, timestamp), heldSafety = held.plan.bagSafety;
    return !!heldSafety && safety.every((value, at) => value === heldSafety[at]);
}
// Soft market/crowd never excuses the held leaf's own offer, funding and
// route: they are checked exactly through the existing authority.
function ownLeafHolds(state, plan, deps) {
    const leaf = plan.network?.activity;
    return !leaf || acceptedActivityHolds(state, leaf, deps);
}
function occupancyToken(deps, id) {
    const row = deps.occupancy?.get?.(id) || deps.occupancy?.[id];
    return `${Number(row?.reservedCount ?? row?.count) || 0}`;
}
function spotsHold(deps, reads = []) {
    for (const [id, token] of reads) if (occupancyToken(deps, id) !== token) return false;
    return true;
}
function quantityBands(state, context, projection) {
    const bands = [], stock = new Map();
    for (const kind of ['shots', 'potions', 'scrolls']) {
        const row = context.stock(kind);
        if (row?.itemId && row.target > 0) stock.set(Number(row.itemId), [Math.max(1, Math.ceil(row.target - positive(row.beginnerCurrent))),
            kind === 'shots' ? row : null]);
    }
    const reserved = invoke('GameServer/Bot/Economy/ItemDisposition').reservedEquipmentAmounts(state);
    const used = new Set((projection?.nodes || []).filter(node => node.key.startsWith('item:')).map(node => Number(node.key.slice(5))));
    const error = Sections.incomeError(state, context.persona);
    for (const [id, row] of Object.entries(state.inventory || {})) {
        const amount = positive(row.amount), itemId = Number(id), template = ItemIndex.find(invoke('GameServer/DataCache').items, itemId);
        if (!amount || row.equipped || row.equippedCount || row.protected || row.protectedAmount || row.reservedAmount
            || row.acceptedCustomer || row.assignedClan || row.available === false || positive(reserved[id])
            || (row.stackable ?? template?.etc?.stackable) !== true) continue;
        if (stock.has(itemId)) {
            const [target, shots] = stock.get(itemId);
            if (amount >= target) bands.push([itemId, target, null, amount]);
            else if (shots && shots.unitPrice > 0) {
                // Shots between the survival line and the target: each unit
                // only moves the restock wish's amount, price and value
                // together. Consumption below the bot's own error (money and
                // hours) is noise; the survival line (survival reserve,
                // `needed`) and an empty stack (use rate, planned slot) stay
                // hard, and any rise is the purchase's own event.
                const floor = Math.max(1, Math.ceil(shots.survivalTarget - positive(shots.beginnerCurrent)));
                const allowance = Math.floor(Math.min(positive(context.hourAdena) * error / shots.unitPrice,
                    shots.benefitPerUnit > 0 ? error / shots.benefitPerUnit : Infinity));
                const low = Math.max(floor, amount - allowance);
                if (amount >= floor && low < amount) bands.push([itemId, low, amount, amount]);
            }
            continue;
        }
        // Only existing free stacks absent from every admitted requirement.
        // A book, recipe, target, new stack or unknown item keeps exact facts.
        const kind = String(template?.template?.kind || row.kind || '');
        if (used.has(itemId) || state.clanId || state.stats?.clanId || positive(state.stats?.karma)
            || !/^Other\.(Material|Arrow)/.test(kind)) continue;
        const unitValue = positive(context.buyback(itemId));
        if (!(unitValue > 0)) continue;
        const allowance = Math.floor(positive(context.hourAdena) * error / unitValue);
        bands.push([itemId, kind.startsWith('Other.Arrow') ? 1 : amount, amount + allowance, amount]);
    }
    return bands;
}
function bagSafety(state, timestamp) {
    const Floor = invoke('GameServer/Bot/Population/SurvivalFloor');
    const bag = Floor.stateInventory(state, invoke('GameServer/DataCache').items);
    const profile = invoke('GameServer/Bot/Population/ColdCombatProfile').profileFor(state, timestamp);
    return [bag.slots, Floor.weightPenalty(bag.load, profile.maxLoad), profile.maxLoad];
}
function calculationFence(state, sections, reads, spots, deps, bands = [], safety = null) {
    if (extensions.size || deps.nodes?.length || deps.workshops && !deps.workshopRevision && !deps.inputKey) return null;
    const tokens = [], indexes = new Map(), items = [];
    for (const [id, token] of reads) {
        if (!indexes.has(token)) { indexes.set(token, tokens.length); tokens.push(token); }
        items.push(id, indexes.get(token));
    }
    return encodeCalculationFence([sectionKeys(state, deps, bands).structural,
        [tokens, items], [...spots], bands, safety], !isMainThread);
}
// Grid ids and occupancy versions stay exact. Canonical coordinates share
// successive differences; dungeon/noncanonical ids keep their original keys.
// Only the worker compresses large proofs, and only the existing owner keeps
// their <=4KB result. No hash, global dictionary or saved dependency list.
// A size refusal is counted as fence:drop:<reason> while diagnostics run (L115).
function fenceDrop(reason) {
    if (Diagnostics.active()) Diagnostics.count('fence', 'drop', reason);
    return null;
}
function encodeCalculationFence(fields, compact = true) {
    const plain = fenceEncoder.encode(JSON.stringify(fields));
    if (!compact || plain.byteLength <= 2048) return plain.byteLength <= FENCE_BYTES ? plain : fenceDrop('plain_over_4k');
    if (plain.byteLength > FENCE_RAW_BYTES) return fenceDrop('raw_over_64k');
    if (fields[2].length > FENCE_SPOTS) return fenceDrop('spots_over_4096');
    const tokens = [], indexes = new Map(), grid = [], other = [];
    for (const [id, token] of fields[2]) {
        if (!indexes.has(token)) { indexes.set(token, tokens.length); tokens.push(token); }
        const parts = typeof id === 'string' && /^(?:0|[1-9]\d*|-[1-9]\d*)_(?:0|[1-9]\d*|-[1-9]\d*)$/.test(id)
            ? id.split('_').map(Number) : null;
        if (parts?.every(Number.isSafeInteger)) grid.push([parts[0], parts[1], indexes.get(token)]);
        else other.push([id, token]);
    }
    grid.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const coordinates = []; let x = 0, y = 0;
    for (const row of grid) {
        if (!Number.isSafeInteger(row[0] - x) || !Number.isSafeInteger(row[1] - y)) return null;
        coordinates.push(row[0] - x, row[1] - y, row[2]); x = row[0]; y = row[1];
    }
    const packed = fenceEncoder.encode(JSON.stringify([fields[0], fields[1], [tokens, coordinates, other], fields[3], fields[4]]));
    if (packed.byteLength > FENCE_RAW_BYTES) return fenceDrop('raw_over_64k');
    const compressed = deflateRawSync(packed, { level: 6 });
    if (compressed.byteLength + 1 > FENCE_BYTES) return fenceDrop('compressed_over_4k');
    const result = new Uint8Array(compressed.byteLength + 1); result[0] = 1; result.set(compressed, 1);
    return result;
}
function decodeCalculationFence(fence) {
    if (!(fence instanceof Uint8Array) || !fence.byteLength || fence.byteLength > FENCE_BYTES) return null;
    let fields;
    try {
        fields = JSON.parse(fenceDecoder.decode(fence[0] === 1
            ? inflateRawSync(fence.subarray(1), { maxOutputLength: FENCE_RAW_BYTES }) : fence));
        if (fence[0] === 1) {
            const encoded = fields?.[2];
            if (!Array.isArray(encoded) || encoded.length !== 3) return null;
            const [tokens, coordinates, other] = encoded;
            if (!Array.isArray(tokens) || tokens.length > FENCE_SPOTS || tokens.some(token => typeof token !== 'string')
                || !Array.isArray(coordinates) || coordinates.length % 3 || !Array.isArray(other)
                || coordinates.length / 3 + other.length > FENCE_SPOTS) return null;
            const spots = []; let x = 0, y = 0;
            for (let at = 0; at < coordinates.length; at += 3) {
                const token = coordinates[at + 2];
                if (!Number.isSafeInteger(coordinates[at]) || !Number.isSafeInteger(coordinates[at + 1])
                    || !Number.isSafeInteger(token) || token < 0 || token >= tokens.length) return null;
                x += coordinates[at]; y += coordinates[at + 1];
                if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) return null;
                spots.push([`${x}_${y}`, tokens[token]]);
            }
            fields[2] = spots.concat(other);
        }
    } catch (_) { return null; }
    if (!Array.isArray(fields) || fields.length !== 5 || typeof fields[0] !== 'string'
        || !Array.isArray(fields[1]) || fields[1].length !== 2 || !Array.isArray(fields[1][0])
        || fields[1][0].some(token => typeof token !== 'string') || !Array.isArray(fields[1][1]) || fields[1][1].length % 2
        || !Array.isArray(fields[2]) || fields[2].length > FENCE_SPOTS
        || fields[2].some(row => !Array.isArray(row) || row.length !== 2
            || !['string', 'number'].includes(typeof row[0]) || typeof row[1] !== 'string')
        || !Array.isArray(fields[3]) || fields[3].some(row => !Array.isArray(row) || row.length !== 4
            || !Number.isSafeInteger(row[0]) || row[0] <= 0 || !Number.isFinite(row[1]) || row[1] < 1
            || !Number.isFinite(row[3]) || row[3] < row[1]
            || row[2] !== null && (!Number.isFinite(row[2]) || row[2] < row[1]))
        || fields[4] !== null && (!Array.isArray(fields[4]) || fields[4].length !== 3 || !fields[4].every(Number.isFinite))) return null;
    const [tokens, items] = fields[1];
    const itemIds = new Set();
    for (let at = 0; at < items.length; at += 2) {
        if (!Number.isSafeInteger(items[at]) || items[at] < 0 || itemIds.has(items[at])
            || !Number.isSafeInteger(items[at + 1]) || items[at + 1] < 0 || items[at + 1] >= tokens.length) return null;
        itemIds.add(items[at]);
    }
    if (new Map(fields[2]).size !== fields[2].length) return null;
    return fields;
}
// Without options the proof is exact, as for a fresh build. With the
// card's options (L70) the bot's own field activity is equalised and the
// read market/spot crowd become soft: they fail only once the market delay
// since the last actual decision (options.baseline.at) has passed.
// options.why: an array that receives the failing part's name (L114
// diagnostics); a structural miss names the first differing key segment
// (inputKey order, then capability, then the tail) while diagnostics run.
function calculationHolds(state, fence, deps = {}, options = {}) {
    const why = options.why;
    if (!(fence instanceof Uint8Array) || fence.byteLength > FENCE_BYTES || extensions.size || deps.nodes?.length) return miss(why, 'invalid');
    deps = resolved(state, deps);
    if (deps.workshops && !deps.workshopRevision && !deps.inputKey) return miss(why, 'workshop');
    const fields = decodeCalculationFence(fence);
    if (!fields) return miss(why, 'invalid');
    const [key, [tokens, items], spots, bands, safety] = fields;
    if (!bandsHold(state, bands, options.leaf)) return miss(why, 'bands');
    if (safety) {
        const Floor = invoke('GameServer/Bot/Population/SurvivalFloor'), bag = Floor.stateInventory(state, invoke('GameServer/DataCache').items);
        if (bag.slots !== safety[0] || Floor.weightPenalty(bag.load, safety[2]) !== safety[1]) return miss(why, 'safety');
    }
    // options.activity is the fence's own build activity, so one key compares;
    // options.leaf is its held leaf (a trip to the leaf's own spot).
    const structural = sectionKeys(fieldActivity(state, options.activity, options.leaf), deps, bands).structural;
    if (key !== structural) return miss(why, why && Diagnostics.active() ? `structural:${structuralSegment(firstSegment(key, structural), key, structural)}` : 'structural');
    const reads = new Map();
    for (let at = 0; at < items.length; at += 2) reads.set(items[at], tokens[items[at + 1]]);
    if (marketHolds(deps.board, reads, deps) && spotsHold(deps, spots)) return true;
    if (!Object.hasOwn(options, 'baseline') || Sections.softDue(options.baseline, 'market', options.timestamp ?? Date.now())) return miss(why, 'market');
    if (options.countDeferral && Diagnostics.active()) Diagnostics.count('advisory', 'soft_deferred', 'market');
    return true;
}
function firstSegment(a, b) {
    const left = a.split('|'), right = b.split('|');
    let at = 0;
    while (at < left.length && left[at] === right[at]) at++;
    return at;
}
// A retained leaf is calculation data. Recheck its native source, physical
// resources and funding now; execution still uses the existing command/CAS.
function acceptedActivityHolds(state, leaf, deps = {}, current = null) {
    if (leaf.activity === 'hunting') return true;
    deps = resolved(state, deps, false);
    const trip = deps.tripCost || Trip.preparedReader(deps.routeRows || [], { hourAdena: positive(state.stats?.money?.[0]) });
    const route = trip.details?.(leaf.town);
    if (!route?.known || !Number.isFinite(route.fees) || route.fees > positive(state.adena)) return false;
    if (leaf.activity === 'shopping' && leaf.kind === 'buy' && leaf.itemId > 0 && leaf.amount > 0
        && leaf.unitPrice > 0 && ['npc', 'configured_store', 'afk'].includes(leaf.sourceType)) {
        const remaining = invoke('GameServer/Bot/Population/ColdEconomyDecision').remainingToOrder(leaf, state);
        if (!(remaining > 0)) return false;
        const offer = require('./WishPurchaseEvidence').reader(state, { board: deps.board, trip }, deps)(leaf.itemId);
        if (!offer || offer.sourceType !== leaf.sourceType || offer.town !== leaf.town
            || offer.unitPrice !== leaf.unitPrice || offer.availableUnits < remaining) return false;
        const Funding = require('./PurchaseFunding');
        return Funding.spendable(state, deps.buyOrderEscrow, Funding.nativeTerms(leaf, leaf.itemId)) >= remaining * offer.unitPrice + route.fees;
    }
    if (leaf.activity === 'selling' && leaf.kind === 'liquidate' && leaf.funding === true && leaf.items?.length
        && invoke('GameServer/Bot/Population/ColdOccupationSources').hasNpcSellerInTown(leaf.town)) {
        return Providers.liquidationCandidates(state, current ? current() : basics(state, deps)).some(row => leaf.items.includes(Number(row.selfId)));
    }
    return false;
}
// The market as an input of one bot: the board lines and the counter of each
// item its review read, as tokens at the time of reading. The context stays
// valid while every token holds; a deal or a line of another item, anywhere
// in the world, rebuilds nobody (design 16.5). Not inputs, by the same rule:
// the all-counter average a counter without its own move falls back to
// (MarketCounters.moveOf) and PriceBelief's hourly demand cache.
function marketToken(board, id, deps = {}) {
    const Counters = invoke('GameServer/Bot/Economy/MarketCounters');
    return `${board?.itemRevision ? board.itemRevision(id) : '-'}|${Counters.revisionOf(Counters.counterOf(id))}|${deps.workshopRevision?.(id) || 0}`;
}
function marketHolds(board, reads, deps) {
    for (const [id, token] of reads) if (marketToken(board, id, deps) !== token) return false;
    return true;
}
function marketKey(reads) {
    let hash = 0x811c9dc5;
    for (const [id, token] of reads) {
        const text = `${id}=${token};`;
        for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
    }
    return hash.toString(16);
}
// Board reads of the review go through here while it is built, so each
// item it looked at is remembered with its token. Later readers of
// context.board (a market look, a sale) do not widen what the review
// depends on.
function watchedBoard(board, watch) {
    if (!board) return board;
    return Object.assign(Object.create(board), {
        first: (selfId, ...rest) => { watch(selfId); return board.first(selfId, ...rest); },
        list: (selfId, ...rest) => { watch(selfId); return board.list(selfId, ...rest); },
        ...(board.heads ? { heads: (selfId, ...rest) => { watch(selfId); return board.heads(selfId, ...rest); } } : {})
    });
}
function defaultProducerSource(state, board) {
    const index = invoke('GameServer/Bot/Population/ColdOccupationSources').recipeIndex(board);
    const level = invoke('GameServer/Bot/Economy/CraftEligibility').craftLevelFor(state), scope = index.scopeFor(level);
    return { recipes: index.rowsFor(level), scope, revision: index.revision(scope) };
}
function resolved(state, deps, production = true) {
    deps = { ...runtime, ...deps };
    if (typeof deps.board === 'function') deps.board = deps.board();
    if (!deps.board && isMainThread) deps.board = invoke('GameServer/AfkTrade/AfkTradeService').boardIndex();
    if (typeof deps.spots === 'function') deps.spots = deps.spots();
    if (typeof deps.memory === 'function') deps.memory = deps.memory(state.characterId);
    // Stock, survival and own shot-use readers need only the hunt foundation.
    // Production sources and recipe books belong to the full wish review.
    if (production) {
        if (typeof deps.workshop === 'function') deps.workshop = deps.workshop(state.characterId);
        if (typeof deps.knownRecipes === 'function') deps.knownRecipes = deps.knownRecipes(state.characterId);
        if (!deps.fixedProductionOffersFor) deps.fixedProductionOffersFor = invoke('GameServer/Bot/Population/ColdOccupationSources').fixedBuyerOffersFor;
        if (!deps.producerSource && deps.board) deps.producerSource = defaultProducerSource;
        if (typeof deps.producerSource === 'function') {
            const source = deps.producerSource(state, deps.board);
            deps.producerRecipes = source?.recipes;
            deps.producerRevision = source?.revision;
            if (source?.scope != null) deps.onSourceScope?.(source.scope);
        }
        if (isMainThread && !Object.hasOwn(deps, 'workshop')) deps.workshop = craftIncome(state);
        if (isMainThread && !Object.hasOwn(deps, 'workshops')) {
            const Workshops = invoke('GameServer/Bot/Economy/CraftWorkshopService');
            deps.workshops = Workshops.publicForRecipe;
            deps.workshopRevision = Workshops.publicRecipeDigest;
        }
        if (isMainThread && !Object.hasOwn(deps, 'knownRecipes')) {
            const Workshops = invoke('GameServer/Bot/Economy/CraftWorkshopService');
            if (Workshops.bookFor(state.characterId) !== null) deps.knownRecipes = Workshops.cachedRecipes(state.characterId);
        }
        if (typeof deps.buyOrderEscrow === 'function') deps.buyOrderEscrow = deps.buyOrderEscrow(state.characterId);
    }
    if (!deps.spots && isMainThread) deps.spots = invoke('GameServer/Bot/Population/SpotProfiles').ensure();
    if (!deps.npcOffersFor && isMainThread) deps.npcOffersFor = id => {
        const Sources = invoke('GameServer/Bot/Population/ColdOccupationSources');
        Sources.initialise(); return Sources.npcOffersFor(id);
    };
    return deps;
}
function personaOf(state, deps) {
    return deps.persona || invoke('GameServer/Bot/AI/BotPersona').of(state) || { traits: {}, understanding: 0.3 };
}
function pricing(state, persona, board, timestamp, deps, read = () => {}, prices = new Map()) {
    const Belief = invoke('GameServer/Bot/Economy/PriceBelief');
    const knowledgeEnabled = deps.knowledgeEnabled ?? invoke('GameServer/Bot/AI/KnowledgeLearning').knowledgeEnabled();
    const priceCtx = { characterId: state.characterId, understanding: persona.understanding ?? 0.3,
        marketTrades: state.marketTrades, knowledgeEnabled, board, timestamp };
    const beliefs = new Map();
    return { knowledgeEnabled, prices, beliefs, price: id => {
        read(id);
        if (!prices.has(Number(id))) {
            const belief = Belief.prior(id, priceCtx);
            if (belief) beliefs.set(Number(id), belief);
            prices.set(Number(id), belief ? Math.exp(belief.mu) : 0);
        }
        return prices.get(Number(id));
    } };
}
// Price future carried scroll uses only if a review needs extra stock.
// Resolve the known hunt through the existing catalogue index; a merchant
// location during a town visit is never a future hunting origin.
function scrollHoursFor(state, spots, bestSpotId) {
    if (invoke('GameServer/Karma').closesTowns(state.stats?.karma)) return 0;
    const origin = invoke('GameServer/Bot/AI/SpotIndex').spotById(spots, bestSpotId)?.center
        || state.stats?.marketReturn?.loc || (state.activity === 'hunting' ? state.loc : null);
    if (!origin || ![origin.locX, origin.locY, origin.locZ].every(Number.isFinite)
        || origin.locX === 0 && origin.locY === 0) return 0;
    const Trip = invoke('GameServer/Bot/Population/ColdTrip'), Routes = invoke('GameServer/Bot/Travel/TravelRoutes');
    const destination = Routes.landingTown(origin);
    const routeState = { ...state, loc: origin, inventory: { 736: { amount: 0 } } };
    const walking = Trip.townPlan(routeState, destination);
    const recall = Trip.townPlan({ ...routeState, inventory: { 736: { amount: 1 } } }, destination);
    return walking && recall && recall.scroll ? Math.max(0, walking.durationMs - recall.durationMs) / 3600000 : 0;
}
// stock(kind) and kitCost(id) over the kit data of one review: the build and
// every later view of its plan answer from the same numbers. Prices go
// through the caller's price reader, so each read joins the review's inputs.
function kitReader(data, price, scrollUseHours) {
    const stock = kind => {
        if (kind === 'scrolls') {
            const current = data.scrolls,
                target = invoke('GameServer/Bot/Travel/ScrollStock').TARGET_AMOUNT, survivalTarget = 1;
            const missing = Math.max(0, target - Math.max(current, survivalTarget));
            const benefitPerUnit = current < target ? scrollUseHours() : 0;
            return { itemId: 736, usePerHour: 0, current, hours: Infinity, targetHours: data.targetHours, target,
                survivalTarget, survivalMissing: Math.max(0, survivalTarget - current), missing,
                unitPrice: price(736), benefitPerUnit, benefitHours: missing * benefitPerUnit, needed: current < target };
        }
        const shots = kind === 'shots';
        const row = shots ? data.shots : data.potions;
        const { itemId, use, current } = row;
        const wantedTarget = Math.max(Math.ceil(use), Math.ceil(use * data.targetHours));
        // Useful owned stock need not justify expensive replacement stock.
        const target = row.canRestock ? wantedTarget : Math.min(current, wantedTarget);
        // Forecast consumption may be fractional; both purchase tranches use
        // the same whole-unit survival stock so their sum remains executable.
        const survivalTarget = row.canRestock ? Math.ceil(use) : Math.min(current, Math.ceil(use));
        const survivalMissing = Math.max(0, survivalTarget - current);
        const missing = Math.max(0, target - Math.max(current, survivalTarget));
        const benefitPerUnit = use > 0 ? row.benefit / use : 0;
        const benefitHours = missing * benefitPerUnit;
        return { itemId: Number(itemId), usePerHour: use, ...(shots ? { ownedUsePerHour: row.ownedUsePerHour, beginnerCurrent: row.beginnerCurrent,
                beginnerUsePerHour: row.beginnerUsePerHour, paidUsePerHour: row.paidUsePerHour } : {}),
            current, hours: use > 0 ? current / use : Infinity,
            targetHours: data.targetHours, target, survivalTarget, missing, survivalMissing, unitPrice: price(itemId), benefitPerUnit, benefitHours,
            needed: use > 0 && current < survivalTarget };
    };
    const kit = [stock('shots'), stock('potions')];
    const escapeCost = data.closed ? 0 : price(736) * Math.max(0, 1 - data.scrolls);
    // A known executable quote pays whole missing units once. The personal
    // price estimate still values an unseen option; it must not underfund
    // a concrete merchant's mandatory stock and trigger repeated tiny fills.
    const kitCost = (id, unitPrice = null) => {
        const quoted = Number.isFinite(unitPrice) && unitPrice > 0;
        if (Number(id) === 736 && data.closed) return 0;
        if (Number(id) === 736) return quoted ? unitPrice * Math.max(0, 1 - data.scrolls) : escapeCost;
        return kit.filter(row => row.itemId === Number(id)).reduce((sum, row) => sum
            + row.survivalMissing
                * (quoted ? unitPrice : row.unitPrice), 0);
    };
    return { stock, kitCost, kit, escapeCost };
}
// The bot's hour, death and karma prices and its stock of shots and potions:
// the part of a review that needs no wish network. forState builds on it and
// basics() returns it alone, so a reader that wants only these never builds
// the network, and both give the same numbers.
function foundation(state, deps, persona, timestamp, price) {
    const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
    const Table = invoke('GameServer/Bot/AI/SpotValueTable');
    const role = state.party?.role || state.stats?.role || invoke('GameServer/Bot/AI/BotRoles').inferRole(state.stats?.classId || 0);
    const tableRole = role === 'melee' ? 'dps' : role === 'nuker' ? 'mage' : role === 'crafter' ? 'spoiler' : role;
    let hunt = Hunt.huntIncome(state, timestamp, deps.mode);
    const incomeRoute = require('./EquipmentIncomeRoute').select(state, { ...deps, timestamp, price,
        required: invoke('GameServer/Bot/AI/PersonalGearProgression').assess(state).required });
    if (incomeRoute) {
        const row = incomeRoute.row;
        hunt = { perHour: row.income * Hunt.onSpotShare(state), perKill: row.kills > 0 ? row.income / row.kills : 0,
            expPerHour: row.exp * Hunt.onSpotShare(state), source: 'route', spotId: incomeRoute.spot.id,
            progressSpotId: incomeRoute.spot.id, useShots: row.useShots };
    }
    const lostGearHours = hunt.perHour > 0 ? Valuation.pkDropValue(state, price) / hunt.perHour : 0;
    const bestSpotId = hunt.spotId || state.spotId;
    const walkBackHours = invoke('GameServer/Bot/Economy/WalkBack').hours(bestSpotId, state, deps.spots || invoke('GameServer/Bot/AI/SpotService').spots);
    const deathHours = Valuation.deathHours(state, { ...hunt, lostGearHours, walkBackHours });
    const spotTable = bestSpotId ? Table.value(bestSpotId, tableRole, state.level, hunt.useShots !== false) : null;
    const bestTable = spotTable || Table.best(tableRole, state.level, hunt.useShots !== false);
    const ShotStock = invoke('GameServer/Inventory/ShotStock');
    const shotPlan = ShotStock.planForState(state);
    const shotItemId = shotPlan.selfId;
    const potionItemId = invoke('GameServer/Bot/AI/HealingPotionStock').purchasePotionFor(state).selfId;
    const withoutShots = bestSpotId ? Table.value(bestSpotId, tableRole, state.level, false) : null;
    const shotPolicy = ShotStock.usePolicy(state, { plan: shotPlan, bestTable, withoutShots,
        hourAdena: Hunt.huntHour(hunt, state), unitPrice: price(shotItemId) });
    const shotBenefit = shotPolicy.benefit;
    const beginnerCurrent = ShotStock.beginnerAmount(state, shotPlan);
    const shotUse = positive(state.inventory?.[shotItemId]?.amount) + beginnerCurrent > 0
        ? shotPolicy.usePerHour : shotPolicy.purchaseUsePerHour;
    const potionUse = positive(bestTable?.potions);
    let bagHours = 2;
    const hasBagForecast = spotTable?.stacks !== null && spotTable?.stacks !== undefined;
    if (hasBagForecast) {
        const Floor = invoke('GameServer/Bot/Population/SurvivalFloor'), Data = invoke('GameServer/DataCache');
        const race = state.stats?.race ?? (Data.classTemplates == null ? undefined : ClassProgression.firstClassRow(Data.classTemplates, state.stats?.classId || 0))?.template?.race;
        // ARCH-NOTE: size the E9 bag interval on the bag after its
        // planned kit stacks exist. Otherwise an empty shot/potion row uses
        // no slot, its refill uses one, and the shorter interval immediately
        // sells part of that refill back to the NPC. Existing stacks retain
        // the exact physical free-slot formula; zero-use stock reserves none.
        const plannedSlots = Number(shotUse > 0 && !positive(state.inventory?.[shotItemId]?.amount) && !beginnerCurrent)
            + Number(potionUse > 0 && !positive(state.inventory?.[potionItemId]?.amount));
        let slotLimit = Floor.inventoryLimit(race);
        const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
        const saleLimit = Disposition.soloSaleSlotLimit(state, timestamp);
        if (saleLimit !== null) {
            // Stock cannot be its own reason for an earlier town visit. Keep
            // the entire usable kit while checking known free saleable loot.
            const keptAmounts = { [shotItemId]: positive(state.inventory?.[shotItemId]?.amount),
                ...invoke('GameServer/Bot/AI/HealingPotionStock').keptAmounts(state, { targetAmount: Infinity }),
                736: positive(state.inventory?.[736]?.amount) };
            if (Disposition.saleCandidates(state, { keptAmounts, preparedReservations: deps.saleReservations,
                presenceOnly: true })) slotLimit = Math.min(slotLimit, saleLimit);
        }
        const free = Math.max(0, slotLimit - Floor.stateInventory(state, Data.items).slots - plannedSlots);
        bagHours = free === 0 ? 0 : spotTable.stacks > 0 ? free / spotTable.stacks : 24;
    }
    const Visits = invoke('GameServer/Bot/Economy/TownVisitInterval');
    // Bag space bounds a planned outing; it never chooses its duration.
    // Keep the existing initial estimate until actual town visits teach one.
    const targetHours = hasBagForecast
        ? Math.min(Visits.targetHours(state.stats), Visits.targetHours({}, bagHours))
        : Visits.targetHours(state.stats);
    // The kit as data (perf C1): what stock() and kitCost() read, so a kept
    // plan answers them later without this build scope.
    const kitData = { targetHours, scrolls: positive(state.inventory?.[736]?.amount),
        closed: invoke('GameServer/Karma').closesTowns(state.stats?.karma), scrollHours: undefined,
        shots: { itemId: shotItemId, use: shotUse, current: positive(state.inventory?.[shotItemId]?.amount) + beginnerCurrent,
            canRestock: shotPolicy.purchaseUsePerHour > 0, benefit: shotBenefit, ownedUsePerHour: shotPolicy.usePerHour,
            beginnerCurrent, beginnerUsePerHour: shotPolicy.beginnerUsePerHour, paidUsePerHour: shotPolicy.paidUsePerHour },
        potions: { itemId: potionItemId, use: potionUse, current: positive(state.inventory?.[potionItemId]?.amount),
            canRestock: true, benefit: positive(bestTable?.deaths) * deathHours } };
    const { stock, kitCost, kit, escapeCost } = kitReader(kitData, price,
        () => kitData.scrollHours ??= scrollHoursFor(state, deps.spots, bestSpotId));
    const reserve = escapeCost + kit.reduce((sum, row) => sum + row.survivalMissing * row.unitPrice, 0);
    return { tableRole, hunt, hourAdena: Hunt.huntHour(hunt, state), survivalReserve: reserve, kitCost, kit: kitData,
        lostGearHours, bestSpotId, deathHours, bestTable, stock,
        riskWeight: Valuation.riskWeight(state, persona),
        expectedDeathHours: positive(bestTable?.deaths) * deathHours,
        karmaHours: Valuation.karmaHours(state, { ...hunt, lostGearHours, deathsPerHour: positive(bestTable?.deaths) }) };
}
function basics(state = {}, deps = {}) {
    deps = resolved(state, deps, false);
    const timestamp = Number(deps.timestamp || Date.now());
    const persona = personaOf(state, deps);
    const board = deps.board || (isMainThread ? invoke('GameServer/AfkTrade/AfkTradeService').boardIndex() : null);
    const { price } = pricing(state, persona, board, timestamp, deps);
    return { persona, price, timestamp, ...foundation(state, deps, persona, timestamp, price) };
}
function stockFor(state, kind, deps = {}) { return basics(state, deps).stock(kind); }
// The build reads the bot's own combat profile several times at one
// timestamp; one build of it serves them (ColdCombatProfile.withProfileScope).
function forState(state = {}, deps = {}) {
    const outer = rowKeys;
    rowKeys = null;
    try { return CombatProfile.withProfileScope(state, () => buildForState(state, deps)); }
    finally { rowKeys = outer; }
}
// The shadow plan comparison, also by the card refusal that sent this build
// (deps.advisoryRefusal, set by the cold worker while diagnostics run), so a
// refusal that rebuilds the same plan shows itself (L114).
function countShadowPlan(deps, sameKey, samePlan) {
    const plan = samePlan ? 'same_plan' : 'new_plan';
    Diagnostics.count('context', 'shadow_plan', `${sameKey ? 'same_key' : 'new_key'}:${plan}`);
    if (deps.advisoryRefusal) Diagnostics.count('advisory', 'refusal_plan', `${deps.advisoryRefusal}:${plan}`);
}
function buildForState(state, deps) {
    const diagnostic = Diagnostics.active();
    if (diagnostic) Diagnostics.count('context', 'request');
    if (diagnostic && isMainThread && state.phase === 'cold') {
        const caller = deps.caller || 'other';
        mainColdForState ||= new Map();
        const slot = mainColdForState.has(caller) || mainColdForState.size < 63 ? caller : 'overflow';
        mainColdForState.set(slot, (mainColdForState.get(slot) || 0) + 1);
    }
    deps = resolved(state, deps);
    if (typeof deps.routeRows === 'function') deps.routeRows = deps.routeRows(state);
    if (!deps.tripCost && !deps.routeRows && isMainThread)
        deps.routeRows = preparedRouteRows(state) || invoke('GameServer/Bot/Population/ColdSimulationCoordinator').routeRows?.(state);
    const timestamp = Number(deps.timestamp || Date.now());
    const actorKey = deps.actorKey || `character:${Number(state.characterId || 0)}`;
    const sourceBoard = deps.board || (isMainThread ? invoke('GameServer/AfkTrade/AfkTradeService').boardIndex() : null);
    const held = deps.rememberContext === false ? null : cache.get(actorKey);
    // A valid completed card survives planner-slot reuse or card eviction;
    // the same route is repriced with the current hour value, never a wallet.
    if (!deps.routeRows && held?.plan.routeKey === Trip.key(state)) deps.routeRows = held.plan.routeRows;
    const gearThreat = GearThreat.prepare(state, deps, held?.gearThreat);
    deps.gearThreatMask = gearThreat.mask;
    const key = inputKey(state, { ...deps, timestamp });
    if (held?.key !== key) rowKeys = new Map();
    // A caller that needs the member's graph nodes (a worker group solve)
    // builds unless the held entry kept them (the main thread keeps them).
    // Market items read and the spot crowd are soft (L70): a moved token
    // rebuilds only once the market delay since the last actual decision
    // has passed, and never while the held leaf's own offer, funding or
    // route fails; every hard condition above still cuts through at once.
    const deferred = diagnostic ? [] : null;
    if ((held?.key === key || decisionHolds(state, held, timestamp, deps, deferred)) && (!deps.withNodes || held.projection)
        && (marketHolds(sourceBoard, held.reads, deps) && spotsHold(deps, held.spotReads)
            || !Sections.softDue(held.plan.statsPacket?.wishSections, 'market', timestamp)
                && ownLeafHolds(state, held.plan, deps) && (deferred?.push('market'), true))) {
        if (deps.onSourceRead) for (const id of held.reads.keys()) deps.onSourceRead(id);
        if (diagnostic) {
            Diagnostics.count('context', 'hit', held.key === key ? 'same_inputs' : 'own_result');
            if (deps.advisoryRefusal) Diagnostics.count('advisory', 'refusal_hit', deps.advisoryRefusal);
            for (const kind of deferred) Diagnostics.count('context', 'soft_deferred', kind);
            // The gap is measured from the last use, as the cache keeps by last use.
            const last = lastKeyHashes.get(actorKey);
            if (last) last.at = Date.now();
        }
        held.gearThreat = gearThreat;
        held.stateRef = new WeakRef(state);
        remember(cache, actorKey, held);
        // A late price read of a held plan joins its inputs, as in its build.
        const late = id => { id = Number(id); if (held.reads.has(id)) return;
            held.reads.set(id, marketToken(sourceBoard, id, deps)); deps.onSourceRead?.(id); };
        return view(state, held.plan, deps, { board: sourceBoard, read: late, projection: held.projection,
            fenceData: { sections: held.sections, reads: held.reads, spots: held.spotReads } });
    }
    const sections = sectionKeys(state, { ...deps, timestamp }, [], 'sources');
    const started = diagnostic ? performance.now() : 0;
    // Identity replacement is the worker's technical safety backstop, not an
    // economic event. An input-key mismatch is named as a dependency change;
    // it does not claim which historical event caused it.
    const diagnosticReason = !diagnostic ? null : !held ? 'not_retained' : held.key !== key
        ? 'input_dependency_changed' : !isMainThread && held.stateRef.deref() !== state ? 'state_publication'
        : deps.withNodes && !held.projection ? 'nodes_needed' : 'used_market_changed';
    if (diagnostic) Diagnostics.count('context', 'miss', diagnosticReason);
    let shadowSame = false, previousPlan = null, shadowEntry = null;
    if (diagnostic) {
        const hash = fnv1a32(key), last = lastKeyHashes.get(actorKey), at = Date.now();
        const same = last?.hash === hash;
        shadowSame = same; previousPlan = last?.plan ?? null;
        Diagnostics.count('context', 'shadow', `${diagnosticReason}:${same ? 'same_key' : 'new_key'}`);
        if (same) {
            Diagnostics.count('context', 'shadow_gap', gapBucket(Math.max(0, at - last.at)));
            // 'capacity' (LRU), 'planning_capacity', 'unkept' (forState did not keep it) or the owner's forgetContext reason.
            if (diagnosticReason === 'not_retained') Diagnostics.count('context', 'shadow_released', last.released || 'unknown');
        }
        const kept = deps.rememberContext !== false && planningContexts < 64;
        shadowEntry = { hash, at, released: kept ? null : 'unkept', plan: null };
        remember(lastKeyHashes, actorKey, shadowEntry, LAST_KEY_LIMIT);
    }
    const reads = new Map();
    let building = true;
    // MVP-6 Bounds: while a gear candidate's arena is built its reads wait
    // in its own scope; the provider keeps the scopes whose descriptors
    // survive the final cut, so a rejected candidate's items never become
    // inputs of the review.
    let scope = null;
    const nodeScopes = [];
    const spotReads = new Map();
    const bagToken = id => JSON.stringify([state.inventory?.[id] || null, state.acceptedIncoming?.[id] || 0]);
    const bagIds = () => Object.keys(state.inventory || {}).filter(id => Number(id) !== 57);
    // ARCH-NOTE: PERF: the build is one synchronous call (its generators are
    // drained inside it; board, counter and workshop deltas and occupancy
    // reservations apply between calls), so an item's market token and a
    // spot's occupancy token are constant while it runs: each is built once
    // per build. The bag (state.inventory rows, state.acceptedIncoming) is
    // not mutated during the build either: an item's bag token and the bag's
    // id list are built once too. A late read through the view (after either
    // return below) builds it fresh, as its inputs may have moved since.
    // Dies at return.
    let tokensLive = true, liveBagIds = null, liveBagKeys = null;
    const marketTokens = new Map(), spotTokens = new Map(), bagTokens = new Map();
    const endTokens = () => { tokensLive = false; marketTokens.clear(); spotTokens.clear(); bagTokens.clear(); liveBagIds = liveBagKeys = null; };
    const tokenOf = id => {
        if (!tokensLive) return marketToken(sourceBoard, id, deps);
        let token = marketTokens.get(id);
        if (token === undefined) marketTokens.set(id, token = marketToken(sourceBoard, id, deps));
        return token;
    };
    const spotTokenOf = id => {
        if (!tokensLive) return occupancyToken(deps, id);
        let token = spotTokens.get(id);
        if (token === undefined) spotTokens.set(id, token = occupancyToken(deps, id));
        return token;
    };
    const bagTokenOf = id => {
        if (!tokensLive) return bagToken(id);
        const at = String(id); // the property key bagToken reads
        let token = bagTokens.get(at);
        if (token === undefined) bagTokens.set(at, token = bagToken(id));
        return token;
    };
    const wholeBagIds = () => tokensLive ? liveBagIds ??= bagIds() : bagIds();
    const wholeBagKeys = () => tokensLive ? liveBagKeys ??= JSON.stringify(wholeBagIds().slice().sort())
        : JSON.stringify(bagIds().sort());
    const read = id => { id = Number(id);
        for (const local of nodeScopes) local.items.set(id, tokenOf(id));
        if (reads.has(id)) return;
        if (scope) { if (!scope.has(id)) scope.set(id, tokenOf(id)); return; }
        reads.set(id, tokenOf(id)); deps.onSourceRead?.(id);
    };
    const watch = id => { if (building) read(id); };
    const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
    const Table = invoke('GameServer/Bot/AI/SpotValueTable');
    const persona = personaOf(state, deps);
    const cash = Sections.bounds(positive(state.adena));
    const board = watchedBoard(sourceBoard, watch);
    // A price is remembered, so every price read counts, also a late one
    // through context.price: its item joins the review's inputs.
    const { price, prices, beliefs, knowledgeEnabled } = pricing(state, persona, board, timestamp, deps, read);
    const base = foundation(state, deps, persona, timestamp, price);
    const own = Hunt.sampledRows(state, timestamp, deps.mode);
    const calibrations = own.flatMap(row => {
        const value = Table.value(row.spotId, base.tableRole, state.level, true);
        return value?.exp > 0 ? [Math.max(0, row.exp) / row.cycleMs * 3600000 / value.exp] : [];
    });
    const calibration = calibrations.length ? calibrations.reduce((sum, value) => sum + value, 0) / calibrations.length : 1;
    const context = { inputKey: key, actorKey, state, timestamp, gearThreatMask: gearThreat.mask, persona, board, hunt: base.hunt, price, buyback, calibration,
        riskWeight: base.riskWeight, bestSpotId: base.bestSpotId, deathHours: base.deathHours, lostGearHours: base.lostGearHours,
        karmaHours: base.karmaHours, expectedDeathHours: base.expectedDeathHours, stock: base.stock,
        survivalReserve: base.survivalReserve, kitCost: base.kitCost, hourAdena: base.hourAdena,
        walletBoundary: cash.watch,
        // Every evaluated source participates in admission/ranking, including a losing candidate.
        sourceSpot: id => { const token = spotTokenOf(id);
            spotReads.set(id, token);
            for (const local of nodeScopes) local.spots.set(id, token); },
        nodeInputs: { begin: () => { const local = { items: new Map(), spots: new Map(), bag: new Map() }; nodeScopes.push(local); return local; },
            end: () => nodeScopes.pop(),
            bag: id => { if (!(Number(id) > 0) || !nodeScopes.length) return;
                const token = bagTokenOf(id);
                for (const local of nodeScopes) local.bag.set(Number(id), token); },
            wholeBag: () => { if (!nodeScopes.length) return;
                for (const id of wholeBagIds()) context.nodeInputs.bag(id);
                const token = wholeBagKeys();
                for (const local of nodeScopes) local.bag.set(-1, token); },
            holds: input => (!deps.workshops || !!deps.workshopRevision || !!deps.inputKey)
                && marketHolds(sourceBoard, input.items || [], deps)
                && input.spots.every(([id, token]) => spotTokenOf(id) === token)
                && (input.bag || []).every(([id, token]) => (id === -1 ? wholeBagKeys() : bagTokenOf(id)) === token),
            keep: input => { for (const [id] of input.items) read(id);
                for (const [id] of input.spots) context.sourceSpot(id);
                for (const [id] of input.bag || []) if (id === -1) context.nodeInputs.wholeBag(); else context.nodeInputs.bag(id); } },
        readScope: { open: () => (scope = new Map()), close: () => { scope = null; },
            keep: kept => { for (const [id, token] of kept) if (!reads.has(id)) { reads.set(id, token); deps.onSourceRead?.(id); } } } };
    const workshop = Object.hasOwn(deps, 'workshop') ? deps.workshop : isMainThread
        ? craftIncome(state, { hourAdena: base.hourAdena, worth: price, timestamp }) : null;
    context.workshop = workshop || { recipeId: 0, productId: 0, incomePerHour: NaN, cycleHours: NaN };
    const productive = workshop?.known !== false && workshop?.incomePerHour > 0 && Number.isFinite(workshop.incomePerHour)
        && workshop.cycleHours > 0 && Number.isFinite(workshop.cycleHours);
    if (productive) { watch(workshop.productId); context.hourAdena = Math.max(context.hourAdena, workshop.incomePerHour); }
    context.routeKey = Trip.key(state); context.routeRows = Array.isArray(deps.routeRows) && deps.routeRows.length === Trip.towns.length ? deps.routeRows : null;
    context.routePending = !deps.tripCost && !context.routeRows;
    const tripHour = context.hourAdena;
    context.trip = deps.tripCost || Trip.preparedReader(context.routeRows || [], { hourAdena: tripHour });
    const readSpot = invoke('GameServer/Bot/Economy/SpotEconomics').create(state, { ...deps, timestamp, persona, price, deathHours: context.deathHours });
    context.spotValue = (spot, ...args) => { context.sourceSpot(spot.id); return readSpot(spot, ...args); };
    if (state.incomingPending) {
        // ARCH-NOTE: an oversized incoming projection waits on the existing
        // settlement/preparation owner. Never replace unknown stock with zero
        // demand or renew the decision seed while that input is unavailable.
        context.network = { inputKey: key, queue: [], activity: null, plans: new Map(), demands: new Map(),
            focus: state.stats?.wishFocus || null, dormant: state.stats?.dormantWishes || [],
            moneyPrice: positive(state.stats?.money?.[1]), hourAdena: context.hourAdena, available: 0,
            decisionSeq: state.stats?.decisionSeq || 0, activityLeaf: state.stats?.activityLeaf || 0 };
        context.moneyPrice = context.network.moneyPrice; context.gapHorizonHours = 0;
        context.watchList = []; context.intentPending = true;
        context.itemUsefulness = () => 0; context.worth = price; context.purchaseBudget = () => 0;
        context.statsPacket = { wishFocus: context.network.focus, dormantWishes: context.network.dormant,
            decisionSeq: context.network.decisionSeq, activityLeaf: context.network.activityLeaf,
            money: state.stats?.money || [0, 0, base.survivalReserve, 0], stockTargets: state.stats?.stockTargets || stockTargets(base) };
        if (shadowEntry) {
            const plan = planHash(context.network); shadowEntry.plan = plan;
            if (previousPlan !== null) countShadowPlan(deps, shadowSame, plan === previousPlan);
        }
        endTokens();
        return view(state, planOf(context, base, { key, market: null, tripHour, prices }), deps, { price, kit: base, board, read, spotValue: context.spotValue, trip: context.trip });
    }
    // One stock reader for the provider's gear witnesses and the network
    // build; the projection is read lazily once it exists (stock roots).
    context.wallet = positive(state.adena) + positive(deps.buyOrderEscrow);
    context.stockFor = stockReader(state, rootKey => context.projection?.nodes.find(node => node.key === rootKey)?.object?.itemId);
    const extra = [...extensions.values()].flatMap(provider => provider(state, context) || []);
    const sourceSections = held?.sections?.sources === sections.sources
        ? held.sourceSections : null;
    const projection = Providers.build(state, context, { ...deps, sourceSections, nodes: [...(deps.nodes || []), ...extra] });
    context.projection = projection;
    if (productive) projection.moneyPaths.push({ activity: 'crafting', kind: 'production', recipeId: workshop.recipeId,
        object: workshop.productId, incomePerHour: workshop.incomePerHour,
        cycleHours: workshop.cycleHours, repeatable: true });
    const market = marketKey(reads);
    const networkKey = `${key}#${market}`;
    const choiceBands = quantityBands(state, context, projection);
    // Above a native stock target, exact quantities are execution facts.
    // Unused free loot is compared with the last decision's own value/error,
    // while required materials retain their exact quantities in the key.
    const choiceShape = sectionKeys(state, deps, choiceBands.map(([id, low, high]) => [id, low, high, high === null ? low : 1]));
    const bagValue = choiceBands.reduce((value, [id, , high]) => value + (high === null ? 0
        : positive(state.inventory[id]?.amount) * positive(context.buyback(id))), 0);
    const acceptedSections = state.stats?.wishSections;
    context.choiceInputs = Sections.hash([choiceShape.structural,
        [...reads].sort(([a], [b]) => a - b), [...spotReads].sort(([a], [b]) => String(a).localeCompare(String(b)))]);
    const unchangedChoice = Number(acceptedSections?.choices) === context.choiceInputs
        && Number.isFinite(acceptedSections?.bagValue)
        && Math.abs(bagValue - acceptedSections.bagValue) <= positive(context.hourAdena) * positive(acceptedSections.incomeError)
        && (!held || marketHolds(sourceBoard, held.reads, deps) && spotsHold(deps, held.spotReads));
    context.choiceBagValue = unchangedChoice ? acceptedSections.bagValue : bagValue;
    const network = engine.build({ actorKey, inputKey: networkKey, ...projection,
        remembered: deps.rememberContext !== false,
        stockFor: context.stockFor,
        characterId: state.characterId, decisionSeq: state.stats?.decisionSeq, activityLeaf: state.stats?.activityLeaf,
        wallet: context.wallet, survivalReserve: base.survivalReserve,
        preserveFocus: !state.stats?.wishDirty && Number(state.stats?.activityLeaf) > 0 && unchangedChoice,
        playedHours: positive(state.stats?.playedHours), persona,
        previous: { focus: state.stats?.wishFocus, dormant: state.stats?.dormantWishes },
        hourAdena: context.hourAdena, riskWeight: context.riskWeight,
        caller: deps.caller || 'economy_context', trigger: deps.trigger || diagnosticReason || 'context_build' });
    context.inputKey = networkKey;
    context.horizonHours = projection.horizon;
    context.network = network;
    context.moneyPrice = network.moneyPrice;
    context.hourAdena = network.hourAdena;
    // Affordability removes a funding gap, not the benefit lost while waiting.
    const urgent = network.gap || network.queue.find(row => row.key === network.focus?.[0]) || network.queue[0];
    context.gapHorizonHours = !urgent ? 0 : urgent.key === 'stock:shots' ? base.stock('shots').targetHours
        : urgent.key === 'stock:potions' ? base.stock('potions').targetHours : projection.horizon;
    Object.assign(context, valueReaders(state, network, projection.values, persona, knowledgeEnabled,
        base.kitCost, () => context.statsPacket.money));
    context.watchList = invoke('GameServer/Bot/Economy/TradeIntent').project(state, network, projection, id => context.worth(id) ?? price(id));
    context.intentPending = context.watchList === null;
    context.watchList ||= [];
    const Funding = invoke('GameServer/Bot/Economy/PurchaseFunding');
    context.statsPacket = { wishFocus: network.focus, dormantWishes: network.dormant,
        decisionSeq: network.decisionSeq, activityLeaf: network.activityLeaf,
        money: Funding.packetFor(network, context.hourAdena, base.survivalReserve), stockTargets: stockTargets(base), wishDirty: 0 };
    let cumulative = base.survivalReserve;
    for (const wish of network.queue) { cumulative += cashCharge(wish); cash.watch(cumulative); }
    const watchedWish = network.gap || network.queue.find(wish => wish.key === network.focus?.[0]);
    const belief = beliefs.get(Number(watchedWish?.object?.itemId));
    const moneyError = belief ? knowledgeEnabled
        ? positive(watchedWish.price) * Math.expm1(invoke('GameServer/Bot/Economy/PriceBelief').sigma(belief)) : 0 : -1;
    context.statsPacket.wishSections = Sections.snapshot(state, context, cash.result, moneyError, deps.mode);
    building = false; endTokens();

    if (diagnostic) {
        Diagnostics.count('context', 'build', diagnosticReason);
        Diagnostics.duration('context', performance.now() - started);
        const plan = planHash(network);
        if (shadowEntry) shadowEntry.plan = plan;
        if (previousPlan !== null) countShadowPlan(deps, shadowSame, plan === previousPlan);
    }
    if (diagnostic && Diagnostics.enabled(state.characterId)) Diagnostics.push({ owner: state.characterId,
        caller: deps.caller || 'economy_context', trigger: deps.trigger || diagnosticReason,
        phase: 'wish_context', reason: diagnosticReason, inputHash: fnv1a32(networkKey),
        decisionSeq: network.decisionSeq, activityLeaf: network.activityLeaf,
        revision: state.simulation?.revision, wallet: positive(state.adena), escrow: positive(deps.buyOrderEscrow),
        available: network.available, reserve: base.survivalReserve, wishKey: network.focus?.[0] });
    const plan = planOf(context, base, { key, market, tripHour, projection, knowledgeEnabled, prices });
    plan.quantityBands = choiceBands;
    plan.bagSafety = bagSafety(state, timestamp);
    // Source memo belongs only to the bounded cache owner. A planning view
    // or a group closure must never retain a second copy outside that cap.
    const retainedSourceMemo = projection.sourceSections;
    projection.sourceSections = null;
    if (deps.rememberContext !== false && planningContexts < 64) {
        if (diagnostic && !cache.has(actorKey) && cache.size >= 64 - planningContexts) {
            Diagnostics.count('context', 'eviction', 'capacity');
            noteRelease(cache.keys().next().value, 'capacity');
        }
        // The main thread keeps the graph nodes as before (its group solve
        // reads them on a hit); the worker keeps the plan only (perf C1).
        // The band-aware structure of this build (as its calculation fence)
        // and its own activity: the later reuse verdict compares the result
        // with them. A hash only; no second full key string is retained.
        remember(cache, actorKey, { key, reads, spotReads, plan, stateRef: new WeakRef(state), gearThreat, sections,
            activity: state.activity, bandHash: fnv1a32(sectionKeys(state, { ...deps, timestamp }, choiceBands).structural),
            sourceSections: retainedSourceMemo, mp: Number(state.vitals?.mp),
            projection: isMainThread ? projection : null }, 64 - planningContexts);
        let retainedSources = 0;
        for (const entry of [...cache.values()].reverse()) if (entry.sourceSections && ++retainedSources > SOURCE_MEMO_LIMIT) entry.sourceSections = null;
    }
    return view(state, plan, deps, { price, kit: base, board, read, spotValue: context.spotValue, trip: context.trip, projection,
        fenceData: { sections, reads, spots: spotReads } });
}
// Plan as data (perf C1). A built context's closures hold the wish network,
// the projection and the whole build scope (~60 KB per bot); what its readers
// act on is a few KB of results. The cache keeps this plan, and every reader,
// the building caller included, gets view(state, plan, deps): the same fields
// and functions, answered from the plan, the state it is given and the kit
// data, without a second wish build.
// Plan nodes keep only what post-build readers walk: the materials of the
// decision card (ColdEconomyDecision.capture), TradeIntent.project and
// npcOwnsPurchase, WishProviders.personalCraftPlan. Shared nodes stay shared.
// A requirement row without its plan is looked up by key in network.plans
// (personalCraftPlan); `unresolved` collects those keys for the kept map.
const NODE_FIELDS = ['kind', 'sourceType', 'quoted', 'executable', 'recipeId', 'missingAmount', 'improvement', 'batches'];
const NO_REQUIREMENTS = Object.freeze([]);
function planTrimmer(unresolved = new Set()) {
    const seen = new Map();
    const trim = plan => {
        if (!plan || typeof plan !== 'object') return plan;
        if (seen.has(plan)) return seen.get(plan);
        // Absent fields stay absent and an empty requirement list is one
        // shared frozen array: a bot keeps ~20 nodes, most of them buys.
        const out = {};
        for (const field of NODE_FIELDS) if (plan[field] !== undefined) out[field] = plan[field];
        if (plan.workshop) out.workshop = { characterId: plan.workshop.characterId, price: plan.workshop.price,
            loc: plan.workshop.loc, townName: plan.workshop.townName };
        seen.set(plan, out);
        if (plan.grossRequirements) out.grossRequirements = plan.grossRequirements.map(row => ({ key: row.key,
            amount: row.amount, ...(row.once ? { once: true } : {}) }));
        if (plan.intentionPath !== undefined) out.intentionPath = trim(plan.intentionPath);
        if (plan.execution) out.execution = { ...trim(plan.execution), availableUnits: plan.execution.availableUnits };
        if (plan.requirements) out.requirements = !plan.requirements.length ? NO_REQUIREMENTS : plan.requirements.map(row => {
            if (!row.plan) unresolved.add(row.key);
            return { key: row.key, amount: row.amount, plan: trim(row.plan) };
        });
        return out;
    };
    return trim;
}
// Queue rows keep the fields read after the build (funding, the money packet
// ratio, the card, trade intents, gear and companion choices). network.plans
// keeps the item plans (TradeIntent.npcOwnsPurchase asks by `item:<id>`) and
// the plans of requirement rows that have none, not every graph node.
function compactNetwork(network) {
    const unresolved = new Set(), trim = planTrimmer(unresolved);
    const row = wish => ({ key: wish.key, need: wish.need, object: wish.object, price: wish.price, reserved: wish.reserved,
        valueHours: wish.valueHours, ratio: wish.ratio, funded: wish.funded,
        supported: wish.supported, resolved: wish.resolved, progressionPriority: wish.progressionPriority,
        plan: trim(wish.plan) });
    const queue = (network.queue || []).map(row);
    const at = network.gap ? (network.queue || []).indexOf(network.gap) : -1;
    const leaf = network.activity;
    const activity = !leaf ? leaf : { ...leaf,
        ...(leaf.requirements ? { requirements: leaf.requirements.map(item => ({ ...item, plan: trim(item.plan) })) } : {}),
        ...(leaf.intentionPath ? { intentionPath: trim(leaf.intentionPath) } : {}) };
    const all = network.plans || new Map(), plans = new Map();
    for (const [key, plan] of all) if (key.startsWith('item:')) plans.set(key, trim(plan));
    for (const key of unresolved) if (!plans.has(key) && all.has(key)) plans.set(key, trim(all.get(key)));
    return { ...network, queue, gap: !network.gap ? network.gap : at >= 0 ? queue[at] : row(network.gap), activity, plans };
}
// The build's prices of what the plan's own numbers were made from (the
// kit, the queue, the watch list): a later view starts from them, so its
// stock rows and kit costs agree with the plan's reserve and money packet.
// Other items are priced by the view (~8 of ~140 prices per bot are kept).
function planPrices(prices, kit, context) {
    const ids = [736, kit.shots.itemId, kit.potions.itemId,
        ...(context.network?.queue || []).map(row => row.object?.itemId), ...(context.watchList || []).map(row => row.itemId)];
    const kept = new Map();
    for (const id of ids) if (prices.has(Number(id))) kept.set(Number(id), prices.get(Number(id)));
    return kept;
}
function planOf(context, base, { key, market, tripHour, projection = null, knowledgeEnabled, prices }) {
    const stockRoots = new Map();
    for (const node of projection?.nodes || [])
        if (node.key.startsWith('stock:') && !stockRoots.has(node.key)) stockRoots.set(node.key, node.object?.itemId);
    return { pending: !projection, key, market, actorKey: context.actorKey, timestamp: context.timestamp,
        gearThreatMask: context.gearThreatMask, persona: context.persona, hunt: context.hunt, calibration: context.calibration,
        riskWeight: context.riskWeight, bestSpotId: context.bestSpotId, deathHours: context.deathHours,
        lostGearHours: context.lostGearHours, karmaHours: context.karmaHours, expectedDeathHours: context.expectedDeathHours,
        survivalReserve: context.survivalReserve, kit: base.kit, hourAdena: context.hourAdena, workshop: context.workshop,
        routeKey: context.routeKey, routeRows: context.routeRows, routePending: context.routePending, tripHour,
        network: compactNetwork(context.network), moneyPrice: context.moneyPrice, gapHorizonHours: context.gapHorizonHours,
        watchList: context.watchList, intentPending: context.intentPending, statsPacket: context.statsPacket,
        wallet: context.wallet, horizonHours: context.horizonHours, values: projection?.values, stockRoots, knowledgeEnabled,
        prices: planPrices(prices, base.kit, context), gearPlanMemo: undefined };
}
// What a review's stock reader, usefulness, worth and purchase budget read:
// one copy for the build and every later view of its plan.
function stockReader(state, rootItem) {
    const reserved = invoke('GameServer/Bot/AI/PersonalGearProgression').preparedAmounts(state);
    return (id, rootKey) => ({ owned: rootKey.startsWith('stock:') && rootItem(rootKey) === id
        ? positive(state.inventory?.[id]?.amount) : invoke('GameServer/Bot/Economy/WealthCraftDecision').freeAmount(state, state.inventory?.[id] || {}, reserved),
    incoming: positive(state.acceptedIncoming?.[id]) });
}
function valueReaders(state, network, values, persona, knowledgeEnabled, kitCost, money) {
    const itemUsefulness = id => invoke('GameServer/Bot/Population/ColdEconomyDecision').personalUsefulness(
        network.demands.get(`item:${id}`) || values.get(Number(id)) || 0,
        state, persona.understanding, knowledgeEnabled, id);
    const Funding = invoke('GameServer/Bot/Economy/PurchaseFunding');
    return { itemUsefulness,
        worth: id => network.moneyPrice > 0 ? itemUsefulness(id) / network.moneyPrice : null,
        purchaseBudget: id => {
            const wish = network.queue.find(row => Number(row.object?.itemId) === Number(id));
            return Funding.spendable({ ...state, stats: { ...state.stats, money: money() } }, 0,
                Funding.stockTerms(wish, id, kitCost(id)));
        } };
}
// Spot values are read inside a build (providers); a later view makes its
// reader only when asked.
function lazySpotValue(state, plan, deps) {
    let reader;
    return (...args) => (reader ||= invoke('GameServer/Bot/Economy/SpotEconomics').create(state,
        { ...deps, timestamp: plan.timestamp, persona: plan.persona, deathHours: plan.deathHours }))(...args);
}
const buyback = id => invoke('GameServer/Items/NpcSellRules')
    .npcBuyPrice(Number(ItemIndex.find(invoke('GameServer/DataCache').items, id)?.template?.price || 0));
// One reader's context over a plan. `built` carries the building call's own
// readers (prices with their memo, kit, spot value, trip, the projection);
// a later view makes its own from the plan. The state is the caller's, held
// only by this view. Functions read the plan, never a build scope.
function view(state, plan, deps, built = {}) {
    // A later view starts from the build's prices of the plan's own items.
    const price = built.price || pricing(state, plan.persona, built.board, plan.timestamp, deps, built.read, new Map(plan.prices)).price;
    const { stock, kitCost } = built.kit || kitReader(plan.kit, price,
        () => plan.kit.scrollHours ??= scrollHoursFor(state, deps.spots, plan.bestSpotId));
    // Reprice funding against this physical wallet. Reuse of benefit/source
    // calculations is never a retained permission to spend an old balance.
    const funding = moneyQueue(plan.network.queue, positive(state.adena) + positive(deps.buyOrderEscrow),
        plan.survivalReserve, plan.hourAdena > 0 ? 1 / plan.hourAdena : 0);
    const network = { ...plan.network, ...funding };
    const statsPacket = plan.pending ? plan.statsPacket : { ...plan.statsPacket,
        money: invoke('GameServer/Bot/Economy/PurchaseFunding').packetFor(network, plan.hourAdena, plan.survivalReserve) };
    const context = { inputKey: plan.market === null ? plan.key : `${plan.key}#${plan.market}`, actorKey: plan.actorKey, state,
        timestamp: plan.timestamp, gearThreatMask: plan.gearThreatMask, persona: plan.persona, board: built.board, hunt: plan.hunt,
        price, buyback, calibration: plan.calibration, riskWeight: plan.riskWeight, bestSpotId: plan.bestSpotId,
        deathHours: plan.deathHours, lostGearHours: plan.lostGearHours, karmaHours: plan.karmaHours,
        expectedDeathHours: plan.expectedDeathHours, stock, survivalReserve: plan.survivalReserve, kitCost,
        hourAdena: plan.hourAdena, workshop: plan.workshop, routeKey: plan.routeKey, routeRows: plan.routeRows,
        routePending: plan.routePending,
        trip: built.trip || deps.tripCost || Trip.preparedReader(plan.routeRows || [], { hourAdena: plan.tripHour }),
        spotValue: built.spotValue || lazySpotValue(state, plan, deps),
        network, moneyPrice: network.moneyPrice, gapHorizonHours: plan.gapHorizonHours, watchList: plan.watchList,
        intentPending: plan.intentPending, statsPacket };
    // The plan is the identity of one decision for memos kept beside it
    // (a refused trip, the gear plan choice), not this view object.
    Object.defineProperty(context, 'plan', { value: plan });
    let fence;
    Object.defineProperty(context, 'calculationFence', { get: () => fence === undefined
        ? (fence = built.fenceData ? calculationFence(state, built.fenceData.sections, built.fenceData.reads, built.fenceData.spots, deps,
            plan.quantityBands, plan.bagSafety) : null) : fence });
    Object.defineProperty(context, 'gearPlanMemo', { get: () => plan.gearPlanMemo, set: memo => { plan.gearPlanMemo = memo; } });
    if (plan.pending) {
        context.itemUsefulness = () => 0; context.worth = price; context.purchaseBudget = () => 0;
        return context;
    }
    context.wallet = positive(state.adena) + positive(deps.buyOrderEscrow);
    context.stockFor = stockReader(state, rootKey => plan.stockRoots.get(rootKey));
    // A later view has the usefulness values only; a group solve that needs
    // the members' nodes rebuilds them (forGroup).
    context.projection = built.projection || { values: plan.values };
    context.horizonHours = plan.horizonHours;
    Object.assign(context, valueReaders(state, network, plan.values, plan.persona, plan.knowledgeEnabled,
        kitCost, () => context.statsPacket.money));
    return context;
}
// The plan's own potion and shot targets, published with its money packet
// (L72): the sale list keeps what the plan decided under spot occupancy
// instead of a second earning-spot search. A changed potion or shot item
// (level, weapon) has no published target yet and reads the foundation; so
// do shots risen since the build: without restock their target is capped by
// the stock owned then (the sale list keeps at most what is owned, so a
// fall needs no fresh read).
function stockTargets(base) {
    const potions = base.stock('potions'), shots = base.stock('shots');
    return [potions.itemId, potions.target, shots.itemId, shots.target, shots.current];
}
function keptTargets(state = {}, deps = {}) {
    const row = state.stats?.stockTargets, ShotStock = invoke('GameServer/Inventory/ShotStock'), plan = ShotStock.planForState(state);
    const beginnerCurrent = ShotStock.beginnerAmount(state, plan);
    if (Array.isArray(row) && row.length === 5 && row[0] === invoke('GameServer/Bot/AI/HealingPotionStock').purchasePotionFor(state).selfId
        && row[2] === plan.selfId && positive(state.inventory?.[plan.selfId]?.amount) + beginnerCurrent <= row[4])
        return { potions: row[1], shots: { itemId: row[2], target: row[3], beginnerCurrent } };
    const base = basics(state, deps);
    return { potions: base.stock('potions').target, shots: base.stock('shots') };
}
function survivalReserve(state = {}) {
    return Array.isArray(state.stats?.money) ? positive(state.stats.money[2]) : basics(state).survivalReserve;
}
function forActor(actor, session, deps = {}) { return forState(stateForActor(actor, session), deps); }
function craftIncome(state) {
    // The guarded worker publication is the only production income reader on
    // main. A missing result leaves the independently supported hunt baseline.
    if (isMainThread) {
        const coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
        return coordinator.economyDecisions?.workshopFor?.(state)
            || { recipeId: 0, productId: 0, incomePerHour: NaN, cycleHours: NaN };
    }
    return { recipeId: 0, productId: 0, incomePerHour: NaN, cycleHours: NaN };
}
function forGroup(group, members, deps = {}) {
    const diagnostic = Diagnostics.active();
    if (diagnostic) Diagnostics.count('context_group', 'request');
    const selected = (members || []).slice(0, 9);
    const prepared = deps.memberContexts;
    if (prepared !== undefined && (!Array.isArray(prepared) || prepared.length !== selected.length
        || prepared.some((context, i) => !context?.projection?.nodes || context.state !== selected[i])))
        throw new Error('party_member_context_mismatch');
    const contexts = prepared || selected.map(state => forState(state, { ...deps, caller: 'groupContext' }));
    const first = contexts[0];
    if (!first) {
        if (diagnostic) Diagnostics.count('context_group', 'miss', 'empty_group');
        return null;
    }
    const actorKey = `group:${group.id || group.partyId}`;
    const proposal = deps.rememberGroup === false || String(group.id || group.partyId || '').startsWith('proposal:');
    const wallet = positive(group.adena ?? group.wallet);
    const key = [wallet, ...contexts.map(context => context.inputKey)].join('|');
    const held = proposal ? null : groups.get(actorKey);
    // The key holds every member's network key (its inputs and the market
    // items its review read), so equal keys are equal member plans (perf C1:
    // a member's later view is a new object over the same plan).
    if (held?.key === key) {
        if (diagnostic) Diagnostics.count('context_group', 'hit', 'same_members');
        return remember(groups, actorKey, held, GROUP_LIMIT).context;
    }
    const started = diagnostic ? performance.now() : 0;
    if (diagnostic) Diagnostics.count('context_group', 'miss', proposal ? 'uncached_proposal'
        : !held ? 'not_retained' : 'input_dependency_changed');
    const nodes = [], roots = [];
    // Each member keeps its actual wishes/effects. Namespaced dependencies
    // enter the group's one purse and one engine, never a second evaluator.
    // A worker member's later view keeps only its usefulness values: the
    // same call that made it builds again asking for the nodes (perf C1).
    const sources = contexts.map((context, i) => context.projection?.nodes ? context.projection
        : forState(selected[i], { ...deps, caller: 'groupContext', withNodes: true }).projection);
    for (let i = 0; i < contexts.length; i++) {
        const source = sources[i];
        const prefix = `${i}:`;
        // The group solve has no stock reader: a member's path with gross
        // inputs only (Task 2 readers) orders what the member does not hold
        // for one batch, and pays its held units at their exit value.
        const held = new Map(source.nodes.map(node => [node.key, node]));
        const missing = path => {
            const requirements = [];
            let ownValue = 0;
            for (const row of path.grossRequirements) {
                const id = row.key.startsWith('item:') ? Number(row.key.slice(5)) : 0;
                const stock = id ? contexts[i].stockFor?.(id, '') || {} : {};
                const { toOrder: order, toExecute } = remainingQuantity({ required: row.amount,
                    freePhysical: positive(stock.owned), acceptedIncoming: positive(stock.incoming) });
                const node = held.get(row.key);
                ownValue += (row.amount - toExecute) * positive(Number.isFinite(node?.exitValue) ? node.exitValue : node?.price);
                if (order > 0) requirements.push({ ...row, amount: order });
            }
            return { requirements, ownInputOpportunityValue: positive(path.ownInputOpportunityValue) + ownValue };
        };
        for (const node of source.nodes) nodes.push({ ...node, key: prefix + node.key,
            paths: (node.paths || []).map(path => {
                const own = path.requirements || !path.grossRequirements ? null : missing(path);
                return { ...path, ...own, ...(path.town ? { tripScope: contexts[i].actorKey } : {}),
                requirements: (own?.requirements || path.requirements || [])
                .map(row => ({ ...row, key: prefix + row.key })),
                ...(path.grossRequirements ? { grossRequirements: path.grossRequirements.map(row => ({ ...row, key: prefix + row.key })) } : {}) };
            }) });
        roots.push(...source.roots.map(key => prefix + key));
    }
    const byKey = new Map(nodes.map(node => [node.key, node]));
    roots.sort((a, b) => positive(byKey.get(b).valueHours) / Math.max(1, positive(byKey.get(b).price))
        - positive(byKey.get(a).valueHours) / Math.max(1, positive(byKey.get(a).price)));
    // MVP-6: the same admission as one member's projection; a root whose
    // union does not fit is pending and the smaller ones still proceed.
    const { roots: admitted, kept } = admitRoots(roots, byKey, { label: 'group' });
    const network = engine.build({ actorKey, inputKey: key, remembered: false, nodes: nodes.filter(node => kept.has(node.key)), roots: admitted,
        wallet, playedHours: positive(group.playedHours), persona: group.persona || first.persona,
        previous: { focus: group.wishFocus, dormant: group.dormantWishes },
        hourAdena: contexts.reduce((sum, context) => sum + context.hunt.perHour, 0),
        moneyPaths: sources[0].moneyPaths, riskWeight: first.riskWeight });
    const groupHunt = { ...first.hunt, perHour: contexts.reduce((sum, member) => sum + member.hunt.perHour, 0),
        expPerHour: contexts.reduce((sum, member) => sum + member.hunt.expPerHour, 0) };
    const context = { ...first, actorKey, inputKey: key, network, routePending: contexts.some(member => member.routePending), hunt: groupHunt, groupIncomePerHour: groupHunt.perHour,
        moneyPrice: network.moneyPrice,
        hourAdena: network.hourAdena, statsPacket: { wishFocus: network.focus, dormantWishes: network.dormant } };
    context.itemUsefulness = id => contexts.reduce((sum, member) => sum + member.itemUsefulness(id), 0);
    context.worth = id => network.moneyPrice > 0 ? context.itemUsefulness(id) / network.moneyPrice : null;
    if (diagnostic) {
        Diagnostics.count('context_group', 'build');
        Diagnostics.duration('context_group', performance.now() - started);
    }
    if (!proposal) {
        if (diagnostic && !groups.has(actorKey) && groups.size >= GROUP_LIMIT)
            Diagnostics.count('context_group', 'eviction', 'capacity');
        remember(groups, actorKey, { key, ids: contexts.map(member => Number(member.state.characterId)), context }, GROUP_LIMIT);
    }
    return context;
}
function preparedRouteRows(state) {
    const plan = cache.get(`character:${Number(state.characterId)}`)?.plan;
    return plan?.routeKey === Trip.key(state) ? plan.routeRows : null;
}
function forgetGroup(partyId) {
    if (groups.delete(`group:${partyId}`) && Diagnostics.active()) Diagnostics.count('context_group', 'eviction', 'group_release');
}
function forgetContext(id, reason = 'explicit_invalidation', expectedState = null) {
    id = Number(id);
    const key = `character:${id}`;
    if (expectedState && cache.get(key)?.stateRef.deref() !== expectedState) return;
    // Publication replaces the facts object, not the economic decision. The
    // next reader validates semantic section keys and all watched sources.
    if (reason !== 'state_publication') {
        if (cache.delete(key) && Diagnostics.active()) { Diagnostics.count('context', 'eviction', reason); noteRelease(key, reason); }
        engine.forget(key, reason);
    }
    for (const [groupKey, held] of groups) {
        if (held.ids.includes(id)) {
            groups.delete(groupKey);
            if (Diagnostics.active()) Diagnostics.count('context_group', 'eviction', reason);
        }
    }
}
function forget(id) {
    forgetContext(id);
    invoke('GameServer/Bot/Population/ColdCombatProfile').forgetBuild(id);
}
function reset() {
    if (Diagnostics.active() && cache.size) Diagnostics.count('context', 'eviction', 'reset', cache.size);
    if (Diagnostics.active() && groups.size) Diagnostics.count('context_group', 'eviction', 'reset', groups.size);
    cache.clear(); groups.clear(); engine.clear(); lastKeyHashes.clear(); routeAnchors = new WeakMap();
}
function size() { return { context: cache.size, engine: engine.cache.size, groups: groups.size }; }

module.exports = { FIELD_ACTIVITIES, heldEventsQuiet, structuralSegment, size, setPlanningContexts, forState, forActor, forGroup, forgetGroup, basics, stockFor, keptTargets, stateForActor, routeState, preparedRouteRows, inputKey, sectionKeys, calculationHolds, acceptedActivityHolds, encodeCalculationFence, decodeCalculationFence, FENCE_BYTES, survivalReserve, forgetContext, forget, reset, configure, registerProvider,
    craftIncome, summary: () => ({ mainColdForState: Diagnostics.active() ? Object.fromEntries(mainColdForState || []) : null }),
    resetCounters: () => { mainColdForState = null; } };
