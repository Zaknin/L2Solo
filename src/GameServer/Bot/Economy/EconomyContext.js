'use strict';
const ClassProgression = invoke('GameServer/ClassProgression');
const DataCache = invoke('GameServer/DataCache');
const Roles = require('../AI/BotRoles');
const Knowledge = require('../AI/KnowledgeLearning');
const Crystallization = require('./BotCrystallization');
const Floor = require('../Population/SurvivalFloor');
const InventoryLimits = require('../../Inventory/InventoryLimits');

const GearThreat = require('./GearThreat');
const Improvement = require('./BotImprovementPolicy');

const ItemIndex = require('../../Item/ItemTemplateIndex');
const Valuation = require('./EconomicValuation');
const Providers = require('./WishProviders');
const Sections = require('./DecisionSections');
const Funding = require('./PurchaseFunding');
const SpotRiskPolicy = require('../Population/SpotRiskPolicy');
const ColdEconomyDecision = require('../Population/ColdEconomyDecision');
const Network = require('./WishNetwork');
const { WishNetwork, remember, admitRoots, remainingQuantity, moneyQueue, cashCharge,
    createQuantityInputs, quantityInputsHold, eachQuantityRow } = Network;
const { isMainThread } = require('node:worker_threads');
const { createHash } = require('node:crypto');
const RecomputeGeneration = require('../Population/RecomputeGeneration');
const Warehouse = require('./PersonalWarehouseIndex');
const ClanSupply = require('../../Clan/ClanSupplyPolicy');
const Recipes = require('../../Items/C4RecipeItems');
const CraftInputReservations = require('./CraftInputReservations');
const ProductionIndex = require('./RecipeProductionIndex');
const Bytes = require('./CompactBytes');
const Diagnostics = require('./EconomyDiagnostics');
const Hold = require('./Hold');
const { fnv1a32 } = require('../Fnv1a');
const engine = new WishNetwork();
const Trip = require('./EconomicTrip');
const IncomeRoute = require('./EquipmentIncomeRoute');
const SpotIndex = invoke('GameServer/Bot/AI/SpotIndex');
const ColdTrip = invoke('GameServer/Bot/Population/ColdTrip');
const TravelRoutes = invoke('GameServer/Bot/Travel/TravelRoutes');
const GearProgression = invoke('GameServer/Bot/AI/PersonalGearProgression');
// The bounds of an event proof's packed and wire forms and of its read lists.
const PROOF_RAW_BYTES = 65536, PROOF_SPOTS = 4096;
const SOURCE_MEMO_LIMIT = 8;
// The cold worker holds one plan per bot (~1,700), apart from the planner's in-flight builds: a
// 64-slot cache shrunk by them dropped a plan within ~2.5 s under a long cold queue, so every
// same-key rebuild found nothing held (L133). A worker entry is the plan only (perf C1); the main
// thread keeps the graph nodes too and stays at 64.
const RETAIN_LIMIT = isMainThread ? 64 : 2048;
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
const sourceHolders = new Set(); // actor keys whose held entry keeps sourceSections, oldest first
// Groups apart, so a party composition that weighs many candidate groups
// never evicts the bots' own reviews: `group:<partyId>` -> { key, ids,
// context }, removed when the party ends (forgetGroup) and bounded besides;
// a proposed composition (`proposal:` party id) is built and not kept.
const groups = new Map();
const GROUP_LIMIT = 256;
const positive = value => Math.max(0, Number(value) || 0);

function stateForActor(actor, session = actor?.session) {
    // lazy: cycle hot decision publication calls this native actor capture.
    const decisionStats = require('../AI/DecisionEvents').decisionStatsFor(session);
    const stored = session?.coldLifeState || {};
    const current = invoke('GameServer/Bot/Population/BotLifeState').cachedState?.(actor.fetchId?.());
    const inventory = {};
    const physicalInventory = actor.backpack?.fetchItems?.() || [];
    for (const item of physicalInventory) {
        const id = Number(item.fetchSelfId?.());
        if (!id) continue;
        const amount = positive(item.fetchAmount?.());
        const equipped = !!item.fetchEquipped?.();
        const stackable = item.fetchStackable?.();
        const previous = inventory[id];
        inventory[id] = { selfId: id, amount: amount + positive(previous?.amount),
            equipped: equipped || previous?.equipped, equippedCount: Number(equipped) + positive(previous?.equippedCount),
            slot: equipped ? Number(item.fetchSlot?.()) : previous?.slot || 0,
            enchant: item.fetchEnchantLevel?.() ?? item.fetchEnchant?.() ?? 0, stackable,
            ...(stackable === true ? {} : { instances: [...(previous?.instances || []), { id: item.fetchId?.(), selfId: id, amount, equipped,
                slot: Number(item.fetchSlot?.() || 0), enchant: item.fetchEnchantLevel?.() ?? item.fetchEnchant?.() ?? 0 }] }) };
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
        stats: { ...decisionStats, coldCombat: hotKit, hennas: [...(session?.hennas || stored.stats?.hennas || [])], soulCrystalQuest: session?.questStates?.get(350)?.isStarted() === true || stored.stats?.soulCrystalQuest, classId: actor.fetchClassId?.(), exp: actor.fetchExp?.(), karma: actor.fetchKarma?.(), pk: actor.fetchPk?.() },
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
// The native loot projection omits a stack's default metadata; DB
// publication restores it. Its actual flags and ownership stay inputs,
// while absent false/zero fields describe the same stack.
function canonicalRow(row) {
    const stackable = row.stackable ?? ItemIndex.find(DataCache.items, Number(row.selfId))?.etc?.stackable;
    return { ...row, equipped: !!row.equipped, equippedCount: Number(row.equippedCount || 0), slot: Number(row.slot || 0),
        enchant: row.enchant === null ? null : Number(row.enchant || 0), stackable };
}
const rowKey = row => [row.selfId, row.amount, row.equippedCount || row.equipped,
    row.slot, row.enchant, row.stackable, row.starterMobLootAmount, row.kind, row.rank,
    row.reservedAmount, row.protectedAmount, row.protected, row.acceptedCustomer, row.assignedClan, row.available,
    (row.instances || []).map(item=>[item.id,item.enchant,item.slot,item.equipped,item.amount].join('/')).join(';')].join(':');
// The economy place of the hold scheme (Hold.js): while it is on, a held
// build whose event verdict (heldBuildVerdict) is quiet is kept, not rebuilt.
// deps.eventReuse is the test override.
function eventReuseEnabled(deps = {}) { return Hold.on('economy', deps) || deps.eventReuse === true; }
const proofDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function activityIdentity(leaf) {
    if (!leaf) return null;
    const value = new ColdEconomyDecision.CompactActivity(leaf);
    // These are the card's derived execution/funding annotations, not a
    // different selected activity. Every native command field stays bound.
    delete value.heldAtDecision; delete value.r; delete value.craftReservations;
    return proofDigest(value);
}
function validProducerScope(value) {
    return Array.isArray(value) && value.length === 2
        && typeof value[0] === 'string' && /^recipe-production:[0-9]$/.test(value[0])
        && typeof value[1] === 'string' && /^[a-f0-9]{64}$/.test(value[1]);
}
function producerScopeHolds(proof, deps) {
    return validProducerScope(proof.producerScope) && validProducerScope(deps.producerScope)
        && proof.producerScope[0] === deps.producerScope[0] && proof.producerScope[1] === deps.producerScope[1];
}
// facts: semanticFacts of the same state when the caller already has them.
// A party as a key input: none is null whatever its representation (an
// empty party record, a null id); a member is its party with the id and role.
function partyInput(state) {
    const stats = state.stats || {}, partyId = Number(state.party?.partyId || state.partyId || 0);
    return partyId ? { ...state.party, partyId, role: state.party?.role || stats.role || Roles.inferRole(stats.classId || 0) } : null;
}
// The key parts in order (diagnostics: context:key_moved:<name> names the
// first part that moved against the held proof while the digest differs,
// context:key_moved_all:<name> every one).
const KEY_PART_NAMES = Object.freeze(['version', 'generation', 'facts', 'instances', 'improvement', 'clan', 'party',
    'visit_every', 'race', 'generated_cold', 'persona', 'craft_station', 'soul_crystal_quest', 'shot_recipe_item',
    'shot_recipe_fresh', 'recipes', 'workshop_recipe', 'workshop_product', 'relations',
    'clan_material_demand', 'warehouse', 'clan_supply', 'clan_warehouse', 'gear_threat', 'role', 'account',
    'trip', 'route_state', 'mode', 'input_key', 'incoming_pending', 'knowledge']);
function eventInputKey(state, deps = {}, timestamp = Date.now(), activity = null, leaf = null, facts = null) {
    return proofDigest(eventInputParts(state, deps, timestamp, activity, leaf, facts));
}
function eventInputParts(state, deps = {}, timestamp = Date.now(), activity = null, leaf = null, facts = null) {
    const current = fieldActivity(state, activity, leaf), stats = current.stats || {}, trip = Trip.frame(current);
    // The occupation is read once, as an event against the baseline (the
    // verdict's sections: the held leaf's own trip and its arrival are its
    // output, Sections.occupationPlanned); the key holds the other facts.
    facts = { ...(facts || Sections.semanticFacts(current)), occupation: null };
    // Position, region, the trip's target point and scroll quantity drift
    // inside one route. Native route and physical-fee checks still run
    // before the held action is permitted.
    delete trip.loc; delete trip.inventory; delete trip.currentRegion;
    if (trip.stats.travel) delete trip.stats.travel.to;
    // Bag rows are no key part: a row the build read is held by its own proof
    // rows (bands, quantity, liquidation), a full bag by the bag safety, the
    // equipped kit by the build fact. Only the physical
    // owners stay: a card never authorizes another object of the same item.
    // The leaf's own item is its progress: its new objects are no event.
    const own = ColdEconomyDecision.ownItem(leaf), instances = [];
    for (const row of Object.values(current.inventory || {})) if (Number(row.selfId) !== own)
        for (const item of row.instances || []) instances.push(`${row.selfId}:${item.id}`);
    instances.sort();
    // Karma enters through the trip (its town-closing flip, EconomicTrip.frame);
    // frustration through the observation baseline (beyond the bot's error);
    // memory as the friend and enemy the review reads, not its revision
    // (their trust and hostility: the observation's bond, beyond the error).
    const { friend, enemy } = Providers.relationTargets(current, deps);
    return ['recompute_event_inputs_v6', RecomputeGeneration.current(), facts, instances, Improvement.targetInputs(current),
        Number(current.clanId ?? stats.clanId ?? 0), partyInput(current) || 0,
        stats.visitEvery, stats.race, stats.generatedCold, stats.persona,
        stats.craftStationId, stats.soulCrystalQuest, stats.shotRecipeDemand?.itemId,
        Number(stats.shotRecipeDemand?.at) + 1800000 > timestamp,
        Providers.recipeIds(current, deps), deps.workshop?.recipeId, deps.workshop?.productId,
        [friend?.targetId ?? null, enemy?.targetId ?? null],
        stats.clanMaterialDemand, Warehouse.contentIdentity(current), ClanSupply.contentIdentity(current), ClanSupply.hasWarehouse(current),
        deps.gearThreatMask ?? GearThreat.maskFor(current, deps),
        stats.role || Roles.inferRole(stats.classId || 0), current.accountName,
        trip, deps.routeRows ? 'route_ready' : deps.tripCost ? 'route_given' : 'route_pending',
        deps.mode || '', deps.inputKey || '', current.incomingPending === true,
        deps.knowledgeEnabled ?? Knowledge.knowledgeEnabled()];
}
// Diagnostics: every key part that differs between the held proof's parts
// and this request's, in key order (empty when only the digest differs).
function movedKeyParts(parts, heldParts) {
    const names = [];
    for (let at = 0; at < parts.length; at++) if (JSON.stringify(parts[at]) !== heldParts[at])
        names.push(...movedFields(KEY_PART_NAMES[at], parts[at], JSON.parse(heldParts[at] || 'null'), 2));
    return names;
}
// An object part (facts, trip) names each moved field: facts.build, trip.stats.travel.
function movedFields(name, part, held, depth) {
    if (depth === 0 || !part || typeof part !== 'object' || Array.isArray(part)) return [name];
    const names = [];
    for (const key of Object.keys(part)) if (JSON.stringify(part[key]) !== JSON.stringify(held?.[key]))
        names.push(...movedFields(`${name}.${key}`, part[key], held?.[key], depth - 1));
    return names.length ? names : [name];
}

// The fields of the section keys (sectionKeys: the source memo and the
// choice inputs), in order.
function inputKeyParts(state, deps = {}) {
    const stats = state.stats || {};
    const items = Object.values(state.inventory || {}).map(rowKey).sort().join(',');
    // A native bag change, own sample or relation revision is an input event.
    // No timing poll, no world-wide counter: the board and the market are
    // inputs only through the items the bot read (see `market` in forState).
    return [state.level, stats.classId, state.craftLevel ?? stats.dwarvenCraftLevel, items, positive(state.adena), stats.decisionSeq, stats.activityLeaf, stats.visitEvery?.[0], stats.visitEvery?.[1],
        deps.workshop?.recipeId, deps.workshop?.productId, deps.workshop?.incomePerHour, deps.workshop?.cycleHours,
        Providers.recipeIds(state, deps).join(','), deps.producerRevision ?? '',
        Number(stats.shotRecipeDemand?.at) + 30 * 60 * 1000 > Number(deps.timestamp || Date.now())
            ? Number(stats.shotRecipeDemand.itemId) : 0,
        Number(state.vitals?.mp), positive(deps.buyOrderEscrow),
        Math.floor(positive(stats.frustration) * 10), stats.karma, Number(state.clanId ?? stats.clanId ?? 0), Number(state.party?.partyId || state.partyId || 0),
        stats.generatedCold, stats.race, stats.marketSellRetryAfter,
        Number(stats.marketSellRetryAfter || 0) > Number(deps.timestamp || Date.now()),
        invoke('GameServer/Bot/Economy/ItemDisposition').reservationInputKey(state), JSON.stringify(stats.clanMaterialDemand || null),
        invoke('GameServer/Bot/Economy/PersonalWarehouseIndex').version(state),
        state.spotId, deps.gearThreatMask ?? GearThreat.maskFor(state, deps), stats.huntEfficiency?.[0]?.at, deps.memory?.revision || stats.memoryRevision || 0,
        deps.inputKey || '', deps.mode || '', state.incomingPending === true, JSON.stringify(state.acceptedIncoming || null), Trip.key(state), deps.routeRows ? 'route_ready' : deps.tripCost ? 'route_given' : 'route_pending', stats.pk, stats.soulCrystalQuest, (stats.hennas || []).join(','),
        Math.floor(positive(stats.exp ?? state.exp) / Math.max(1, positive(state.level) ** 2 * 100)),
        deps.knowledgeEnabled ?? Knowledge.knowledgeEnabled(),
        stats.production?.crafts || 0, positive(state.sp),
        (stats.coldCombat?.skills || state.skills || []).map(row => `${row.selfId}:${row.level}`).join(',')];
}
// Every section keeps only its used inputs. Current combat resources and
// financial facts do not invalidate a sword's benefit or its source graph.
// A caller reads one part: the source memo only its source sections, the
// choice inputs only the structure, so the other key is not built (L73).
function sectionKeys(state, deps = {}, bands = [], part = 'structural') {
    const stats = state.stats || {}, inventory = { ...state.inventory }, party = partyInput(state);
    const role = party?.role || stats.role || Roles.inferRole(stats.classId || 0);
    delete inventory[57];
    for (const [id, low, high, original] of bands) {
        const row = inventory[id], amount = Number(row?.amount);
        if (!row || !(amount >= low) || high !== null && !(amount <= high)) continue;
        inventory[id] = { ...canonicalRow(row), amount: original,
            ...(row.instances ? { instances: row.instances.map(item => ({ ...item,
                amount: Number(item.amount) >= low && (high === null || Number(item.amount) <= high) ? original : item.amount })) } : {}) };
    }
    const plan = stats.equipmentPlan;
    // The planner publishes this known empty result after the wish review.
    // It names no target, reservation or next action. Unknown plan fields
    // keep the exact dependency instead of being treated as an empty plan.
    const calculationPlan = Sections.isEmptyWishPlan(plan) ? null : plan;
    const stable = { ...state, adena: 0, sp: 0, inventory,
        party, partyId: party?.partyId || 0,
        clanId: Number(state.clanId ?? stats.clanId ?? 0),
        vitals: { ...state.vitals, mp: 0 },
        stats: { ...stats, role, clanId: Number(stats.clanId ?? state.clanId ?? 0),
            karma: stats.karma ?? 0, decisionSeq: 0, activityLeaf: 0, exp: 0, huntEfficiency: [] } };
    const build = Sections.kit(state);
    if (part === 'structural') return { build, structural: `${inputKeyParts(stable, deps).join('|')}|${build}|${JSON.stringify([
        calculationPlan, stats.craftStationId, stats.persona, Number(stats.spotRisk?.windowDeaths || 0),
        state.marketTrades, stats.marketTrades, stats.relations,
        stats.production, role, state.accountName])}` };
    const sourceStable = { ...stable, inventory: Object.fromEntries(Object.entries(inventory)
        .filter(([, row]) => row.equipped || row.equippedCount)), stats: { ...stable.stats, memoryRevision: 0 } };
    const sourceParts = inputKeyParts(sourceStable, { ...deps, memory: null });
    const sourceTail = [calculationPlan, stats.craftStationId, stats.persona, state.marketTrades, stats.marketTrades,
        role, state.accountName,
        // Source descriptors include route admission. Reuse only while the
        // native active exclusions are equal at this already scheduled review.
        [...SpotRiskPolicy.excludedSpotIdsForStates([state], deps.timestamp)].sort(),
        stats.huntEfficiency, stats.huntClock, stats.spotRisk,
        stats.money ? [stats.money[0], Number(stats.money[3]) > 0] : stats.wishFocus?.[2],
        stats.exp ?? state.exp,
        Number(state.craftLevel ?? stats.dwarvenCraftLevel) > 0 ? state.vitals?.mp : 0];
    return { build, sources: `${sourceParts.join('|')}|${build}|${Sections.hash(sourceTail)}` };
}
// L70: the bot's own hunting/resting/travelling is not an economic event.
// Only this kind is equalised; the trip record (EconomicTrip.frame: its
// town, spot and arrival activity; the key drops its target point) stays
// exact, so 'to town' never matches 'to a spot', nor one spot another. One trip
// is the plan itself: leaving for the held leaf's own hunting spot or its
// own town (Sections.occupationPlanned). Only that trip record is dropped
// from the comparison; a trip anywhere else stays exact. The arrival is the
// occupation fact, read by the verdict's sections, not by the key.
const FIELD_ACTIVITIES = new Set(['hunting', 'resting', 'traveling']);
function fieldActivity(state, activity, leaf = null) {
    if (!activity || activity === state.activity || !FIELD_ACTIVITIES.has(activity) || !FIELD_ACTIVITIES.has(state.activity)) return state;
    return state.activity === 'traveling' && Sections.occupationPlanned(state, leaf)
        ? { ...state, activity, stats: { ...state.stats, travel: null } } : { ...state, activity };
}
// The held leaf's own purchase item stays exact: its order counts only the
// rise since the decision (remainingToOrder), so use inside a band would buy short.
function bandsHold(state, bands = [], leaf = null) {
    if (!Array.isArray(bands) || bands.length > 128) return false;
    const bought = leaf?.activity === 'shopping' ? Number(leaf.itemId) || 0 : 0;
    for (const band of bands) {
        if (!Array.isArray(band) || band.length !== 4) return false;
        const [id, low, high, original] = band;
        if (!Number.isSafeInteger(id) || id <= 0 || !Number.isFinite(low) || low < 0
            || high !== null && (!Number.isFinite(high) || high < low)
            || !Number.isFinite(original) || original < low || high !== null && original > high) return false;
        const amount = Number(state.inventory?.[id]?.amount);
        if (bought && Number(id) === bought ? amount !== original
            : !(amount >= low) || high !== null && !(amount <= high)) return false;
    }
    return true;
}
// The event part of the one verdict "the held plan is still valid" (L70),
// read by the verdict (heldBuildVerdict), the card (ColdEconomyDecision
// .canReuse) and the worker's transit hold. A raised event (wishDirty) and a
// crafter's MP cut through at once; money is hard below the lower cash
// bound or on a moved funding mark; soft money, observation and horizon
// changes wait for their kind's delay since the last actual decision.
// held: { baseline, mp, expPerHour, persona } of the last actual decision.
// A failing check names itself in `why` (an array or null) and fails.
const miss = (why, reason) => { why?.push(reason); return false; };
// The soft events of the verdict: a money, observation or horizon change
// once its kind's delay since the last actual decision has passed. The name
// of the first one ('money' is also a hard money move), or null when quiet.
// held: as in heldEventsQuiet (its mp is not read).
function softEvent(state, held, timestamp, deps = {}, skipMoney = false) {
    const baseline = held.baseline;
    if (!skipMoney && Sections.moneyEvent(state, baseline, timestamp, deps.buyOrderEscrow)) return 'money';
    // The bond only from a caller that read the memory: a step gate without
    // it (the worker's transit hold) leaves the bond to the verdict.
    const bondNow = Object.hasOwn(deps, 'memory') ? () => Providers.relationBond(state, deps) : null;
    if (Sections.observationEvent(state, baseline, timestamp, deps.mode, bondNow)) return 'observation';
    if (Sections.horizonEvent(state, baseline, held.expPerHour, held.persona, timestamp)) return 'horizon';
    return null;
}
// why: an array that receives the failing event's name (L114 diagnostics).
function heldEventsQuiet(state, held, timestamp, deps = {}, why = null, skipMoney = false) {
    const stats = state.stats || {};
    if (stats.wishDirty) return miss(why, 'wish_dirty');
    if (!held.nativeCraftContinuation && Number(state.craftLevel ?? stats.dwarvenCraftLevel) > 0
        && Number(state.vitals?.mp) !== Number(held.mp)) return miss(why, 'crafter_mp');
    const soft = softEvent(state, held, timestamp, deps, skipMoney);
    return soft ? miss(why, soft) : true;
}
// A quantity proof row (WishNetwork createQuantityInputs layout) of the
// leaf's own progress: a stock row of its own root on its item, or a
// scalar row of its item. Another root's stock row on that item is that
// root's input (a wished material reaching its count).
const ownQuantityRow = (row, rootKey, own) => row[0] === 'stock' || row[0] === 'stockPhysical'
    ? row[1] === rootKey && row[2] === own : row[1] === own;
// The first input a completed build lacks for an event proof, '' if none.
function eventProofMissing(state, deps, plan) {
    if (!plan || plan.pending) return 'pending';
    if (!plan.quantityInputs) return 'quantity_inputs';
    if (!plan.liquidationInputs) return 'liquidation_inputs';
    if (extensions.size) return 'extensions';
    if (deps.nodes?.length) return 'nodes';
    if (state.incomingPending) return 'incoming_pending';
    if (!plan.statsPacket?.wishSections) return 'sections';
    if (!Warehouse.contentIdentity(state)) return 'warehouse';
    if (!ClanSupply.contentIdentity(state)) return 'clan_supply';
    if (!RecomputeGeneration.current()) return 'generation';
    if (!validProducerScope(deps.producerScope)) return 'producer_scope';
    const baseline = plan.statsPacket.wishSections, leaf = plan.network?.activity;
    if (leaf === null ? plan.pending !== false || plan.intentPending !== false || plan.statsPacket.activityLeaf !== 0
        : !leaf?.activity) return 'leaf';
    if (!Number.isFinite(baseline.at) || !Sections.observationBaselineValid(baseline)) return 'baseline';
    return '';
}
// This proof is produced by the completed native build, shared by its cache
// entry and compact execution card. It is never reconstructed from a later
// publication. Market/occupancy reads retain their original soft deadline.
function captureEventProof(state, deps = {}, options = {}) {
    const plan = options.plan, missing = eventProofMissing(state, deps, plan);
    // Diagnostics: per retained build, captured or the first missing input.
    if (Diagnostics.active()) Diagnostics.count('context', 'proof', missing || 'captured');
    if (missing) return null;
    const baseline = plan.statsPacket.wishSections, leaf = plan.network?.activity;
    const actual = { ...state, stats: { ...state.stats, ...plan.statsPacket } };
    return Object.freeze({ version: 2, owner: Number(state.characterId), at: baseline.at,
        generation: RecomputeGeneration.current(),
        decision: Object.freeze([Number(plan.statsPacket.decisionSeq || 0),
            Number(plan.statsPacket.activityLeaf || 0), plan.network.focus?.[0] ?? null]),
        activity: activityIdentity(leaf),
        hard: proofDigest(options.parts || eventInputParts(actual, deps, plan.timestamp, state.activity, leaf, options.facts)),
        quantities: plan.quantityInputs, liquidation: plan.liquidationInputs,
        producerScope: Object.freeze([...deps.producerScope]),
        stockRoots: Object.freeze([...plan.stockRoots]),
        bands: plan.quantityBands || [], safety: [plan.bagFull], hourAdena: plan.hourAdena,
        market: options.reads, spots: options.spots,
        // A restored prefix currently excludes process-local owner versions.
        // Unsupported owners abstain; an empty numeric revision is not proof.
        restartable: !!RecomputeGeneration.current() && typeof deps.memoryIdentity === 'string'
            && deps.sourceReady === true });
}

// The held proof's soft sources still read the same with these resolved
// deps: its producer scope, the market items and the spot crowd it read.
// A failure inside the market delay is soft (the held build may stand).
function softSourcesHold(proof, deps) {
    return producerScopeHolds(proof, deps) && marketHolds(deps.board, proof.market || [], deps) && spotsHold(deps, proof.spots || []);
}
function heldBuildVerdict(state, proof, deps = {}, options = {}) {
    const refuse = (reason, names) => ({ valid: false, reason,
        touchedSections: names ? Sections.sectionMask(names) : 0 });
    if (!proof || proof.version !== 2 || proof.owner !== Number(state.characterId)
        || !Array.isArray(proof.decision) || proof.decision.length !== 3
        || !proof.decision.slice(0, 2).every(value => Number.isSafeInteger(value) && value >= 0)
        || proof.decision[2] !== null && typeof proof.decision[2] !== 'string'
        || !Array.isArray(proof.stockRoots) || proof.stockRoots.length > 40
        || !proof.stockRoots.every(row => Array.isArray(row) && row.length === 2
            && typeof row[0] === 'string' && Number.isSafeInteger(row[1]) && row[1] > 0)
        || typeof proof.hard !== 'string' || !/^[a-f0-9]{64}$/.test(proof.hard)
        || !(proof.activity === null ? options.leaf === null && proof.decision[1] === 0
            : typeof proof.activity === 'string' && !!options.leaf?.activity)
        || !validProducerScope(proof.producerScope)
        || !Array.isArray(proof.bands) || !Array.isArray(proof.liquidation?.rows)
        || proof.liquidation.rows.length > 8 || !proof.liquidation.rows.every(row => Array.isArray(row)
            && row.length === 2 && Number.isSafeInteger(row[0]) && row[0] > 0 && Number.isFinite(row[1]) && row[1] > 0)
        || !options.softPrefix && (typeof proof.market?.[Symbol.iterator] !== 'function'
            || typeof proof.spots?.[Symbol.iterator] !== 'function')
        || !Number.isFinite(proof.hourAdena) || proof.hourAdena < 0) return refuse('unproved');
    const timestamp = Number(options.timestamp ?? deps.timestamp ?? Date.now()), baseline = options.baseline;
    if (!Sections.observationBaselineValid(baseline) || !Number.isFinite(proof.at)) return refuse('baseline');
    // Diagnostics split of one refusal: the held plan's baseline moved under
    // its proof, or the request's clock runs before the proof's.
    if (proof.at !== baseline.at) return refuse('baseline_at');
    if (timestamp < proof.at) return refuse('baseline_clock');
    if (options.softPrefix && (!proof.restartable || !proof.generation
        || !Number.isFinite(Sections.softDeadline(baseline, 'market'))
        || timestamp >= Sections.softDeadline(baseline, 'market'))) return refuse('restart_expired');
    const generation = RecomputeGeneration.current();
    if (!generation || proof.generation !== generation) return refuse('generation', ['build', 'sources']);
    if (activityIdentity(options.leaf) !== proof.activity) return refuse('activity', ['sources']);
    // A raised event (reconcile bumps the sequence with it) is named by its
    // sections before the echo, as the card names it (refused_plan:wish_dirty.<sections>).
    const dirty = Number(state.stats?.wishDirty) || 0;
    if (dirty) return { valid: false, reason: 'wish_dirty', touchedSections: dirty,
        ...(Diagnostics.active() ? { facts: Sections.sectionNames(dirty).join('+') } : {}) };
    const echo = Sections.decisionRefusal(state, ...proof.decision);
    if (echo) return refuse(echo, ['sources']);
    deps = resolved(state, deps);
    if (!Warehouse.contentIdentity(state) || !ClanSupply.contentIdentity(state)
        || options.softPrefix && (typeof deps.memoryIdentity !== 'string' || deps.sourceReady !== true))
        return refuse('unready');
    const current = fieldActivity(state, options.activity, options.leaf);
    // Diagnostics: the facts behind a sections refusal (refused_plan:sections.<fact>).
    const facts = Diagnostics.active() ? [] : null;
    // An occupation move the held leaf ordered (its trip, its arrival) is its own output.
    const changed = Sections.factEvents(name => baseline[name], Sections.semanticFacts(current), false, facts,
        Sections.occupationPlanned(state, options.leaf));
    if (changed.length) return { ...refuse('sections', changed), ...(facts ? { facts: facts.join('+') } : {}) };
    if ((options.currentKey ?? eventInputKey(state, deps, timestamp, options.activity, options.leaf)) !== proof.hard)
        return refuse('event_key', ['sources']);
    const why = [];
    if (!heldEventsQuiet(state, { baseline, mp: options.mp, expPerHour: baseline.expHour,
        nativeCraftContinuation: deps.nativeCraftContinuation === true,
        persona: personaOf(state, deps) }, timestamp, deps, why, options.rebuildBasis === true)) {
        const reason = why[0];
        return refuse(reason, reason === 'observation' ? ['occupation', 'benefits', 'sources']
            : reason === 'horizon' ? ['benefits', 'sources']
                : reason === 'money' ? ['money'] : ['sources']);
    }
    if (!bandsHold(state, proof.bands, options.leaf)) return refuse('bands', ['supply', 'sources']);
    if (!Array.isArray(proof.safety) || proof.safety.length !== 1 || proof.safety[0] !== bagFull(state))
        return refuse('bag', ['supply', 'sources']);
    const roots = new Map(proof.stockRoots);
    const leaf = options.leaf;
    // A held build passes its entry's fields; a card carries them on its leaf.
    const heldUnits = options.heldUnits ?? leaf?.heldAtDecision;
    const craftReservations = options.craftReservations ?? leaf?.craftReservations;
    // A held craft's reserved inputs may only grow before it runs: a stock
    // row holds while its owned+incoming does not fall (its own delivery
    // moves incoming into the bag), a physical row while its count does not.
    // Every root needing the input carries the same physical row: unlike the
    // own item, the tolerance is not scoped to the leaf's root.
    // A loss below what the decision reserved stays a quantity event.
    const reserved = leaf?.activity === 'crafting' && Array.isArray(craftReservations) ? craftReservations : null;
    const isReserved = id => reserved?.some(row => row[0] === id) === true;
    const stockAmount = (kind, key, id, currentOwned, originalOwned) => {
        if (kind === 'stockPhysical' && isReserved(id) && currentOwned >= originalOwned) return originalOwned;
        if (roots.get(key) !== id) return currentOwned;
        const band = proof.bands?.find(row => row[0] === id);
        return band && originalOwned === band[3] && currentOwned >= band[1]
            && (band[2] === null || currentOwned <= band[2]) ? originalOwned : currentOwned;
    };
    // Own outputs are not inputs: the leaf's own item moves with its progress.
    // It holds while the bot keeps what it held at the decision; the order's
    // completion is the activity check below, a loss is a quantity event.
    const own = ColdEconomyDecision.ownItem(leaf) !== null && Number.isFinite(heldUnits) ? leaf.itemId : null;
    if (own !== null && ColdEconomyDecision.heldFor(state, own) < heldUnits) return refuse('quantity', ['sources', 'money']);
    // The proof is held packed and read as a stream: no rows array.
    const ownRow = own === null ? null : row => ownQuantityRow(row, leaf.rootKey, own);
    const stock = stockReader(state, key => roots.get(key));
    // A reserved input's stock row holds while its owned+incoming does not fall.
    const stockFor = !reserved ? stock : (id, rootKey, row) => {
        const current = stock(id, rootKey);
        return isReserved(id) && current.owned + current.incoming >= row[3] + row[4] ? { owned: row[3], incoming: row[4] } : current;
    };
    const moved = [];
    if (!quantityInputsHold(proof.quantities, { ...Providers.quantityReaders(state), stockFor }, stockAmount, ownRow, moved))
        return moved.length ? refuse('quantity', ['sources', 'money']) : refuse('unproved');
    const liquidation = Providers.liquidationInputs(state, proof.liquidation?.basis);
    // The leaf's own item and a craft's reserved inputs are not sales: their
    // count moves with the leaf's progress, held above by the quantity check.
    const sale = own === null && !reserved ? null : row => row[0] !== own && !isReserved(row[0]);
    const originalSales = sale ? proof.liquidation.rows.filter(sale) : proof.liquidation.rows;
    const currentSales = liquidation.proof && (sale ? liquidation.proof.rows.filter(sale) : liquidation.proof.rows);
    let changedLoot = false;
    const sameSales = currentSales && currentSales.length === originalSales.length
        && currentSales.every(([id, count], at) => {
            const original = originalSales[at];
            if (id !== original?.[0]) return false;
            if (count === original[1]) return true;
            changedLoot = true;
            const band = proof.bands?.find(row => row[0] === id);
            const item = ItemIndex.find(DataCache.items, id);
            // Only the existing finite unused-loot error band. Unlimited
            // surplus stock is sale capacity, not economic noise.
            return band && band[2] !== null && /^Other\.(Material|Arrow)/.test(String(item?.template?.kind || ''))
                && count - original[1] === positive(state.inventory?.[id]?.amount) - band[3];
        });
    if (!sameSales || changedLoot && !choiceBagValueHolds(state, proof.bands, baseline, proof.hourAdena))
        return refuse('liquidation', ['sources', 'money']);
    if (!SpotRiskPolicy.activitySpotAllowed(state, options.leaf, timestamp)) return refuse('check_failed', ['occupation', 'sources']);
    if (options.rebuildBasis) {
        // Reusing slow valuation facts is not permission to execute the old
        // activity with the new wallet. Admission and the network run again.
        if (!softSourcesHold(proof, deps)) return refuse('market', ['sources', 'benefits']);
        return { valid: false, reason: 'rebuild_basis', touchedSections: Sections.sectionBit('money'), basisValid: true };
    }
    const leafWhy = heldLeafRefusal(state, leaf, deps, heldUnits, null, { liquidation: liquidation.candidates });
    if (leafWhy) return refuse(leafWhy.reason, leafWhy.sections);
    if (!options.softPrefix && !softSourcesHold(proof, deps)
        && Sections.softDue(baseline, 'market', timestamp)) return refuse('market', ['sources', 'benefits']);
    return { valid: true, reason: '', touchedSections: 0 };
}
function eventProofHolds(state, proof, deps = {}, options = {}) {
    const verdict = heldBuildVerdict(state, proof, deps, options);
    if (options.verdict) Object.assign(options.verdict, verdict);
    if (!verdict.valid) options.why?.push(verdict.reason);
    return verdict.valid;
}
function restartEventProof(proof, accepted) {
    if (proof?.version !== 2 || proof.restartable !== true || !accepted?.card
        || Object.keys(proof).some(key => !['version', 'owner', 'at', 'generation', 'decision', 'activity', 'hard',
            'quantities', 'liquidation', 'producerScope', 'stockRoots', 'bands', 'safety', 'hourAdena', 'market', 'spots', 'restartable'].includes(key))
        || !validProducerScope(proof.producerScope)
        || !RecomputeGeneration.current() || proof.generation !== RecomputeGeneration.current()
        || !/^[a-f0-9]{64}$/.test(proof.generation) || !/^[a-f0-9]{64}$/.test(proof.hard)
        || proof.owner !== accepted.characterId || proof.at !== accepted.baseline?.at
        || !Array.isArray(proof.decision) || proof.decision.length !== 3
        || proof.decision[0] !== accepted.decisionSeq || proof.decision[1] !== accepted.activityLeaf
        || proof.decision[2] !== accepted.focus || proof.activity !== activityIdentity(accepted.card.activity)
        || proof.activity === null && (accepted.card.activity !== null || proof.decision[1] !== 0)) return null;
    const quantities = proof.quantities;
    if (!(quantities instanceof Uint8Array)) return null;
    try {
        // Version, the domain-separated hard digest (it already commits to
        // generation), the soft facts in the shared exact byte form, then the
        // quantity owner's opaque bytes to the end.
        const write = Bytes.writer();
        write.byte(4); write.raw(Buffer.from(proof.hard, 'hex'));
        if (!Providers.packLiquidationInputs(proof.liquidation, write)) return null;
        write.list(proof.stockRoots, row => {
            if (!Array.isArray(row) || row.length !== 2) throw Error('restart stock root');
            write.text(row[0]); write.uint(row[1]);
        });
        write.list(proof.bands, row => {
            if (!Array.isArray(row) || row.length !== 4) throw Error('restart band');
            write.uint(row[0]); write.number(row[1]); write.number(row[2], true); write.number(row[3]);
        });
        write.list(proof.safety, value => write.number(value));
        write.number(proof.hourAdena);
        if (!ProductionIndex.packScopeIdentity(proof.producerScope, write)) return null;
        write.raw(quantities);
        const bytes = write.finish();
        return bytes.byteLength <= PROOF_RAW_BYTES ? bytes : null;
    } catch (_) { return null; }
}
function restoreEventProof(prefix, accepted) {
    const generation = RecomputeGeneration.current();
    // No minimum length: every short read below throws and refuses the whole prefix.
    if (!generation || !(prefix instanceof Uint8Array)
        || prefix.byteLength > PROOF_RAW_BYTES || !accepted?.card) return null;
    try {
        const read = Bytes.reader(prefix);
        if (read.byte() !== 4) return null;
        const hard = read.raw(32).toString('hex'), liquidation = Providers.unpackLiquidationInputs(read);
        const stockRoots = Object.freeze(read.list(() => Object.freeze([read.text(), read.uint()])));
        const bands = Object.freeze(read.list(() => Object.freeze([read.uint(), read.number(), read.number(true), read.number()])));
        const safety = Object.freeze(read.list(() => read.number()));
        const hourAdena = read.number(), producerScope = ProductionIndex.unpackScopeIdentity(read);
        // The packed quantity proof stays packed; a prefix it cannot read is refused here.
        const packed = producerScope ? Uint8Array.from(read.rest()) : null;
        const quantities = packed && eachQuantityRow(packed, () => true) ? packed : null;
        if (!quantities || !Number.isSafeInteger(accepted.characterId)
            || accepted.card.activity === null && accepted.activityLeaf !== 0
            || !Number.isFinite(accepted.baseline?.at)) return null;
        return Object.freeze({ version: 2, restartable: true, owner: accepted.characterId, at: accepted.baseline.at,
            decision: Object.freeze([accepted.decisionSeq, accepted.activityLeaf, accepted.focus]),
            activity: activityIdentity(accepted.card.activity), generation,
            hard, quantities, liquidation, stockRoots, bands, safety, hourAdena, producerScope });
    } catch (_) { return null; }
}
function wireEventProof(proof) {
    if (!proof || proof.version !== 2 || !proof.market || !proof.spots || !validProducerScope(proof.producerScope)
        || (proof.activity === null ? proof.decision?.[1] !== 0 : typeof proof.activity !== 'string')) return null;
    try {
        const market = [...proof.market], spots = [...proof.spots];
        if (market.length > PROOF_SPOTS || spots.length > PROOF_SPOTS) return null;
        if (!(proof.quantities instanceof Uint8Array)) return null;
        // Packed quantities cross as canonical base64 (receiveEventProof), so
        // this JSON size is the wire's.
        const wire = { ...proof, market, spots, quantities: Buffer.from(proof.quantities).toString('base64') };
        return Buffer.byteLength(JSON.stringify(wire)) <= PROOF_RAW_BYTES ? wire : null;
    } catch (_) { return null; }
}
// The proof from its wire form or in process; null when its packed
// quantities are malformed or above their bound.
function receiveEventProof(proof) {
    const value = proof?.quantities, cap = Network.QUANTITY_INPUT_BYTES;
    const quantities = value instanceof Uint8Array ? value.byteLength <= cap ? value : null : Bytes.fromBase64(value, cap);
    return quantities ? { ...proof, quantities } : null;
}
// Sampled proof uses existing numeric fields: item/requested = held hunting
// item/amount, before = the held build's bag+incoming at the decision,
// owned/actual = current bag/incoming, remaining = raw progress gap. This is
// not allocatable craft stock.
function shadowQuantityEvidence(state, held) {
    const leaf = held?.plan.network?.activity;
    if (!ColdEconomyDecision.materialHunt(leaf)) return null;
    return { item: leaf.itemId, requested: leaf.amount, before: held.heldUnits,
        owned: positive(state.inventory?.[leaf.itemId]?.amount), actual: positive(state.acceptedIncoming?.[leaf.itemId]),
        remaining: Number.isFinite(held.heldUnits)
            ? ColdEconomyDecision.remainingToOrder({ ...leaf, heldAtDecision: held.heldUnits }, state) : undefined };
}
const FOCUS_KINDS = new Set(['power', 'stock', 'resale', 'level', 'care', 'scores', 'status', 'book', 'enchant', 'sa', 'henna']);
function focusKind(key) {
    if (key == null || key === '') return 'none';
    if (typeof key !== 'string') return 'other';
    const end = key.indexOf(':');
    const kind = end < 0 ? key : key.slice(0, end);
    return FOCUS_KINDS.has(kind) ? kind : 'other';
}
// Compare funded flags only after both plans see the request's current wallet.
function gatePlanDiff(state, held, fresh, deps, evidence = null) {
    const before = held.plan.network;
    if (before.focus?.[0] !== fresh.network.focus?.[0]) return 'focus';
    if ((before.activity?.key ?? before.activity?.kind ?? null) !== (fresh.network.activity?.key ?? fresh.network.activity?.kind ?? null)) return 'leaf';
    const left = before.queue || [], right = fresh.network.queue || [];
    const reprice = (queue, plan) => moneyQueue(queue, Funding.budget(state, deps.buyOrderEscrow),
        plan.survivalReserve, plan.hourAdena > 0 ? 1 / plan.hourAdena : 0);
    for (let at = 0; at < Math.max(left.length, right.length); at++) {
        if (at >= left.length || at >= right.length || left[at].key !== right[at].key) {
            if (!evidence) return 'queue';
            // Which order readers the held queue would mislead (view() reprices
            // it; TradeIntent reads the top items): none = an order-only miss.
            // A wish born or gone (entered/left) with quiet events is a missing event.
            const heldMoney = reprice(left, held.plan), freshMoney = reprice(right, fresh);
            const heldRows = new Map(left.map(row => [row.key, row])), freshRows = new Map(right.map(row => [row.key, row]));
            const funded = money => money.queue.filter(row => row.funded).map(row => row.key).sort().join();
            const watch = list => (list || []).map(row => `${row.itemId}x${row.amount}`).join();
            const drift = key => heldRows.get(key)?.ratio > 0 && freshRows.get(key)?.ratio > 0
                ? Math.round((freshRows.get(key).ratio / heldRows.get(key).ratio - 1) * 1000) / 1000 : undefined;
            let entered = 0;
            for (const key of freshRows.keys()) if (!heldRows.has(key)) entered++;
            const moved = [watch(held.plan.watchList) !== watch(fresh.watchList) && 'watch',
                heldMoney.gap?.key !== freshMoney.gap?.key && 'gap', funded(heldMoney) !== funded(freshMoney) && 'funded'].filter(Boolean);
            Object.assign(evidence, { queueIndex: at, heldRoot: left[at]?.key, freshRoot: right[at]?.key,
                queueEntered: entered, queueLeft: heldRows.size - freshRows.size + entered, queueMoved: moved.join() || 'order',
                heldRootDrift: drift(left[at]?.key), freshRootDrift: drift(right[at]?.key) });
            return 'queue';
        }
    }
    const current = new Map(reprice(left, held.plan).queue.map(row => [row.key, row.funded])), repriced = reprice(right, fresh).queue;
    for (let at = 0; at < repriced.length; at++) {
        const row = repriced[at], heldFunded = current.get(row.key);
        if (heldFunded !== row.funded) {
            // Flags and index belong to the already-repriced current-wallet
            // queue. Stored flags are never a queue-mismatch witness.
            if (evidence) Object.assign(evidence, { queueIndex: at, heldRoot: row.key, freshRoot: row.key,
                heldFunded: Number(heldFunded), freshFunded: Number(row.funded) });
            return 'funded';
        }
    }
    return 'same';
}
function occupancyToken(deps, id) {
    const row = deps.occupancy?.get?.(id) || deps.occupancy?.[id];
    return `${Number(row?.reservedCount ?? row?.count) || 0}`;
}
function spotsHold(deps, reads = []) {
    if (typeof reads?.[Symbol.iterator] !== 'function') return false;
    for (const row of reads) {
        if (!Array.isArray(row) || row.length !== 2) return false;
        const [id, token] = row;
        if (occupancyToken(deps, id) !== token) return false;
    }
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
        const amount = positive(row.amount), itemId = Number(id), template = ItemIndex.find(DataCache.items, itemId);
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
function choiceBagValue(state, bands, price = buyback) {
    return bands.reduce((value, [id, , high]) => value + (high === null ? 0
        : positive(state.inventory?.[id]?.amount) * positive(price(id))), 0);
}
function choiceBagValueHolds(state, bands, baseline, hourAdena, value = choiceBagValue(state, bands)) {
    return Number.isFinite(baseline?.bagValue)
        && Math.abs(value - baseline.bagValue)
            <= positive(hourAdena) * positive(baseline.incomeError);
}
// The event proof's bag safety: one crossing, the bag full (its slot limit;
// the full-bag sale itself is SurvivalFloor's, read every step). The slot
// count, weight tier and load drift with every loot row: the build reads
// slots only as free hours. Capture and verdict only.
function bagFull(state) {
    return Number(Floor.stateInventory(state, DataCache.items).slots >= InventoryLimits.forState(state));
}
// Each distinct token once, in first-seen order, and per [id, token] pair
// the slot of its token in that list (HeldReads).
function indexTokens(pairs) {
    const tokens = [], slots = [], index = new Map();
    for (const [, token] of pairs) {
        let slot = index.get(token);
        if (slot === undefined) { index.set(token, slot = tokens.length); tokens.push(token); }
        slots.push(slot);
    }
    return { tokens, slots };
}
// A retained leaf is calculation data. Recheck its native source, physical
// resources and funding now; execution still uses the existing command/CAS.
function acceptedActivityHolds(state, leaf, deps = {}, current = null, prepared = null) {
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
        return Funding.spendable(state, deps.buyOrderEscrow, Funding.nativeTerms(leaf, leaf.itemId)) >= remaining * offer.unitPrice + route.fees;
    }
    if (leaf.activity === 'selling' && leaf.kind === 'liquidate' && leaf.funding === true && leaf.items?.length
        && invoke('GameServer/Bot/Population/ColdOccupationSources').hasNpcSellerInTown(leaf.town)) {
        return (prepared?.liquidation || Providers.liquidationCandidates(state, current ? current() : basics(state, deps)))
            .some(row => leaf.items.includes(Number(row.selfId)));
    }
    return false;
}
// The held leaf's own check, one copy for the event verdict, the legacy
// soft-market hold and the legacy card: '' while it holds, else the
// verdict's refusal (frozen: reason and touched section names). heldUnits:
// the own item's bag+incoming at the decision (a held build's entry; a card
// carries it on its leaf); current/prepared as acceptedActivityHolds.
const leafRefused = (reason, ...sections) => Object.freeze({ reason, sections: Object.freeze(sections) });
const LEAF_TRADE = leafRefused('check_failed', 'sources', 'money'), LEAF_SOURCES = leafRefused('check_failed', 'sources');
const LEAF_RELATIONS = leafRefused('check_failed', 'relations'), LEAF_UNSUPPORTED = leafRefused('unsupported_leaf', 'sources');
function heldLeafRefusal(state, leaf, deps, heldUnits, current = null, prepared = null) {
    // A completed native graph may choose no economic action. Execution
    // keeps its ordinary hunt/rest/travel path after every shared check.
    if (!leaf) return '';
    const checked = () => ColdEconomyDecision.ownItem(leaf) !== null && Number.isFinite(heldUnits)
        ? { ...leaf, heldAtDecision: heldUnits } : leaf;
    const kind = leaf.activity;
    if (kind === 'shopping' || kind === 'selling')
        return acceptedActivityHolds(state, checked(), deps, current, prepared) ? '' : LEAF_TRADE;
    if (kind === 'hunting')
        return ColdEconomyDecision.materialHunt(leaf) && ColdEconomyDecision.remainingToOrder(checked(), state) <= 0 ? LEAF_SOURCES : '';
    if (kind === 'pvp' || kind === 'helping')
        return Number.isSafeInteger(leaf.targetId) && leaf.targetId > 0
            && leaf.rootKey === `${kind === 'pvp' ? 'scores' : 'care'}:${leaf.targetId}` ? '' : LEAF_RELATIONS;
    // This retains the chosen intention. The native executor still
    // prepares its actual batch and checks MP, materials and payment.
    if (kind === 'crafting')
        return Number.isSafeInteger(leaf.recipeId) && leaf.recipeId > 0 && Recipes.resolveByRecipeId(leaf.recipeId) ? '' : LEAF_SOURCES;
    if (kind === 'improving')
        return leaf.improvement && typeof leaf.improvement === 'object' && !Array.isArray(leaf.improvement) ? '' : LEAF_SOURCES;
    return kind === 'resting' || kind === 'traveling' ? '' : LEAF_UNSUPPORTED;
}
// The market as an input of one bot: the board lines and the counter of each
// item its review read, as tokens at the time of reading. The context stays
// valid while every token holds; a deal or a line of another item, anywhere
// in the world, rebuilds nobody (design 16.5). Not inputs, by the same rule:
// the all-counter average a counter without its own move falls back to
// (MarketCounters.moveOf) and PriceBelief's hourly demand cache.
function marketToken(board, id, deps = {}) {
    // Reserved negative ids name a whole board-side list (1 sell, 3 buy).
    if (id < 0) return board?.itemIdsFingerprint?.(-id) ?? JSON.stringify([...(board?.itemIds?.(-id) || [])]);
    const Counters = invoke('GameServer/Bot/Economy/MarketCounters');
    return `${board?.itemRevision ? board.itemRevision(id) : '-'}|${Counters.revisionOf(Counters.counterOf(id))}|${deps.workshopRevision?.(id) || 0}`;
}
function marketHolds(board, reads, deps) {
    if (typeof reads?.[Symbol.iterator] !== 'function') return false;
    for (const row of reads) {
        if (!Array.isArray(row) || row.length !== 2) return false;
        const [id, token] = row;
        if (marketToken(board, id, deps) !== token) return false;
    }
    return true;
}
// A held entry's read set (items or spots with their tokens) in the build's
// reading order, read as its Map was (has, set, keys, [id, token] pairs).
// As Maps a bot's ~330 item reads and its spot reads held ~20 KB of the
// ~37 KB entry (L104): here the ids sit in one array (Int32Array when all
// are int32) and each distinct token once, with one index per id (~4 KB for
// both). Reads joined after the store (a late price read of the served plan)
// go to a small Map after them.
class HeldReads {
    constructor(map) {
        const keys = [...map.keys()], { tokens, slots } = indexTokens(map);
        this.ids = keys.every(id => (id | 0) === id) ? Int32Array.from(keys) : keys;
        this.at = keys.length < 0xffff ? Uint16Array.from(slots) : Uint32Array.from(slots);
        this.tokens = tokens;
        this.added = null;
    }
    position(id) {
        const at = this.ids.indexOf(id);
        return at >= 0 || id === id ? at : this.ids.findIndex(key => key !== key); // NaN, as Map finds it
    }
    has(id) { return this.position(id) >= 0 || !!this.added?.has(id); }
    set(id, token) {
        const at = this.position(id);
        if (at < 0) { (this.added ||= new Map()).set(id, token); return this; }
        let slot = this.tokens.indexOf(token);
        if (slot < 0) slot = this.tokens.push(token) - 1;
        if (slot > 0xffff && this.at instanceof Uint16Array) this.at = Uint32Array.from(this.at);
        this.at[at] = slot;
        return this;
    }
    keys() { return this.added ? [...this.ids, ...this.added.keys()].values() : this.ids.values(); }
    *[Symbol.iterator]() {
        for (let i = 0; i < this.ids.length; i++) yield [this.ids[i], this.tokens[this.at[i]]];
        if (this.added) yield* this.added;
    }
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
function watchedBoard(board, watch, watchList) {
    if (!board) return board;
    return Object.assign(Object.create(board), {
        first: (selfId, ...rest) => { watch(selfId); return board.first(selfId, ...rest); },
        list: (selfId, ...rest) => { watch(selfId); return board.list(selfId, ...rest); },
        ...(board.itemIds ? { itemIds: (storeType, ...rest) => { watchList(-Number(storeType)); return board.itemIds(storeType, ...rest); } } : {}),
        ...(board.heads ? { heads: (selfId, ...rest) => { watch(selfId); return board.heads(selfId, ...rest); } } : {})
    });
}
function defaultProducerSource(state, board) {
    const index = invoke('GameServer/Bot/Population/ColdOccupationSources').recipeIndex(board);
    const level = invoke('GameServer/Bot/Economy/CraftEligibility').craftLevelFor(state), scope = index.scopeFor(level);
    return { recipes: index.rowsFor(level), scope, revision: index.revision(scope), identity: index.contentIdentity(scope) };
}
// The deps a full resolve made, with the state it was made for: a check
// inside the same build (heldBuildVerdict, acceptedActivityHolds) is given
// the build's own deps and does not resolve them again (a second producer
// source read and onSourceScope call). An entry dies with its deps object.
const resolvedFor = new WeakMap();
function resolved(state, deps, production = true) {
    if (state && resolvedFor.get(deps) === state) {
        if (Diagnostics.active()) Diagnostics.count('context', 'resolved', 'reused');
        return deps;
    }
    deps = { ...runtime, ...deps };
    if (typeof deps.board === 'function') deps.board = deps.board();
    if (!deps.board && isMainThread) deps.board = invoke('GameServer/AfkTrade/AfkTradeService').boardIndex();
    if (typeof deps.spots === 'function') deps.spots = deps.spots();
    if (typeof deps.memory === 'function') deps.memory = deps.memory(state.characterId);
    if (typeof deps.memoryIdentity === 'function') deps.memoryIdentity = deps.memoryIdentity(state.characterId);
    if (typeof deps.sourceReady === 'function') deps.sourceReady = deps.sourceReady();
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
            deps.producerScope = [source?.scope, source?.identity];
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
        if (isMainThread && !Object.hasOwn(deps, 'buyOrderEscrow')) {
            // lazy: worker native market records live on main; workers receive their existing context mirror.
            deps.buyOrderEscrow = invoke('GameServer/Bot/Economy/BotAfkMarketService').buyOrderEscrow(state.characterId);
        }
        if (typeof deps.buyOrderEscrow === 'function') deps.buyOrderEscrow = deps.buyOrderEscrow(state.characterId);
    }
    if (!deps.spots && isMainThread) deps.spots = invoke('GameServer/Bot/Population/SpotProfiles').ensure();
    if (!deps.npcOffersFor && isMainThread) deps.npcOffersFor = id => {
        const Sources = invoke('GameServer/Bot/Population/ColdOccupationSources');
        Sources.initialise(); return Sources.npcOffersFor(id);
    };
    if (production) resolvedFor.set(deps, state);
    return deps;
}
function personaOf(state, deps) {
    return deps.persona || invoke('GameServer/Bot/AI/BotPersona').of(state) || { traits: {}, understanding: 0.3 };
}
function pricing(state, persona, board, timestamp, deps, read = () => {}, prices = new Map()) {
    const Belief = invoke('GameServer/Bot/Economy/PriceBelief');
    const knowledgeEnabled = deps.knowledgeEnabled ?? Knowledge.knowledgeEnabled();
    const priceCtx = { characterId: state.characterId, understanding: persona.understanding ?? 0.3,
        marketTrades: state.marketTrades, knowledgeEnabled, board, timestamp };
    const beliefs = new Map();
    const beliefFor = id => {
        if (!beliefs.has(Number(id))) beliefs.set(Number(id), Belief.prior(id, priceCtx) || null);
        return beliefs.get(Number(id));
    };
    return { knowledgeEnabled, prices, beliefs, beliefFor, price: id => {
        read(id);
        if (!prices.has(Number(id))) {
            const belief = beliefFor(id);
            prices.set(Number(id), belief ? Math.exp(belief.mu) : 0);
        }
        return prices.get(Number(id));
    } };
}
// Price future carried scroll uses only if a review needs extra stock.
// Resolve the known hunt through the existing catalogue index; a merchant
// location during a town visit is never a future hunting origin.
// Below karma that closes towns the saving reads only the origin, the static
// town and gatekeeper tables and the travel mode (ColdTrip.honest), so a hunt
// spot's answer is kept on its catalogue object per travel mode: the two
// route solves run once per spot, not in every build.
const spotScrollHours = new WeakMap();
function scrollHoursFor(state, spots, bestSpotId) {
    if (invoke('GameServer/Karma').closesTowns(state.stats?.karma)) return 0;
    const spot = SpotIndex.spotById(spots, bestSpotId);
    if (!spot?.center) return scrollSavingHours(state, state.stats?.marketReturn?.loc || (state.activity === 'hunting' ? state.loc : null));
    const honest = ColdTrip.honest();
    const held = spotScrollHours.get(spot);
    if (held?.honest === honest) return held.hours;
    const hours = scrollSavingHours(state, spot.center);
    spotScrollHours.set(spot, { honest, hours });
    return hours;
}
function scrollSavingHours(state, origin) {
    if (!origin || ![origin.locX, origin.locY, origin.locZ].every(Number.isFinite)
        || origin.locX === 0 && origin.locY === 0) return 0;
    const destination = TravelRoutes.landingTown(origin);
    const routeState = { ...state, loc: origin, inventory: { 736: { amount: 0 } } };
    const walking = ColdTrip.townPlan(routeState, destination);
    const recall = ColdTrip.townPlan({ ...routeState, inventory: { 736: { amount: 1 } } }, destination);
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
// ARCH-NOTE: PERF (L120): the income route search (EquipmentIncomeRoute.select)
// is most of a foundation. A cold step often builds basics() and then
// forState() for the same projected state; the second build takes the
// first one's route through deps.preparedIncomeRoute instead of searching
// again. Key: the same state object, timestamp, spots and occupancy objects,
// mode, maxChecks and required gear flag. Select also reads module state
// (SpotRiskPolicy exclusions, SpotValueTable tables, SpotProfiles capacity,
// LevelingRoutes, the ColdCombatProfile kit store), so the reuse is exact only because
// nothing yields or writes between the basics and the build of one step: a
// record must never cross an await or a write to occupancy or reservations.
// The record keeps each price(id) select made, in order, with
// its value: the build replays them through its own price first, so its
// read set, price and belief maps and board watch fill exactly as a fresh
// search would, and a price that came out different searches afresh. The
// record travels only by deps (the cold worker passes its basics' record);
// select returns plain data (no closure over price).
function incomeRouteFor(state, deps, timestamp, price, keep, watchSpot) {
    const required = GearProgression.assess(state).required;
    const prepared = deps.preparedIncomeRoute;
    if (prepared && prepared.state === state && prepared.timestamp === timestamp && prepared.spots === deps.spots
        && prepared.occupancy === deps.occupancy && prepared.mode === deps.mode
        && prepared.maxChecks === deps.maxChecks && prepared.required === required) {
        let same = true;
        for (let i = 0; i < prepared.reads.length; i += 2) {
            if (!Object.is(price(prepared.reads[i]), prepared.reads[i + 1])) same = false;
        }
        if (same) {
            for (const id of prepared.spotIds) watchSpot?.(id);
            keep?.(prepared); return prepared.route;
        }
    }
    const reads = keep ? [] : null, spotIds = keep ? new Set() : null;
    const noteSpot = id => { spotIds?.add(id); watchSpot?.(id); };
    const occupancy = keep || watchSpot ? new Proxy(deps.occupancy || {}, {
        get: (target, id) => {
            if (id === 'get') return key => { noteSpot(key); return target.get?.(key); };
            if (typeof id === 'string') noteSpot(id);
            return Reflect.get(target, id, target);
        }
    }) : deps.occupancy;
    const route = IncomeRoute.select(state, { ...deps, timestamp, required, occupancy,
        price: keep ? id => { const value = price(id); reads.push(id, value); return value; } : price });
    if (Diagnostics.active()) countIncomeRoute(state, deps, timestamp, route);
    keep?.({ state, timestamp, spots: deps.spots, occupancy: deps.occupancy, mode: deps.mode,
        maxChecks: deps.maxChecks, required, reads, spotIds: [...spotIds], route });
    return route;
}
// Shadow (no behaviour): would the held build's income route serve this
// search? The held plan's hunt names the route it was built on (foundation:
// source 'route'); the same spot and charge policy is 'same'. A held plan of
// this request's timestamp is the step's own first build: step_<same|new>.
const routeName = (spotId, useShots) => `${spotId}:${useShots !== false}`;
function countIncomeRoute(state, deps, timestamp, route) {
    const plan = cache.get(deps.actorKey || `character:${Number(state.characterId || 0)}`)?.plan;
    if (!plan) { Diagnostics.count('context', 'income_route', 'no_held'); return; }
    const before = plan.hunt?.source === 'route' ? routeName(plan.hunt.spotId, plan.hunt.useShots) : 'none';
    const now = route ? routeName(route.spot.id, route.row.useShots) : 'none';
    Diagnostics.count('context', 'income_route', `${plan.timestamp === timestamp ? 'step_' : ''}${before === now ? 'same' : 'new'}`);
}
function foundation(state, deps, persona, timestamp, price, keepRoute = null, watchSpot = null) {
    const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
    const Table = invoke('GameServer/Bot/AI/SpotValueTable');
    const role = state.party?.role || state.stats?.role || Roles.inferRole(state.stats?.classId || 0);
    const tableRole = role === 'melee' ? 'dps' : role === 'nuker' ? 'mage' : role === 'crafter' ? 'spoiler' : role;
    let hunt = Hunt.huntIncome(state, timestamp, deps.mode);
    const incomeRoute = incomeRouteFor(state, deps, timestamp, price, keepRoute, watchSpot);
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
        const Data = DataCache;
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
function foundationFromPlan(state, plan, deps, price) {
    const { stock, kitCost } = kitReader(plan.kit, price,
        () => plan.kit.scrollHours ??= scrollHoursFor(state, deps.spots, plan.bestSpotId));
    return { hunt: plan.hunt, hourAdena: plan.hourAdena, survivalReserve: plan.survivalReserve,
        kit: plan.kit, stock, kitCost, lostGearHours: plan.lostGearHours, bestSpotId: plan.bestSpotId,
        deathHours: plan.deathHours, riskWeight: plan.riskWeight,
        expectedDeathHours: plan.expectedDeathHours, karmaHours: plan.karmaHours };
}
function basics(state = {}, deps = {}) {
    deps = resolved(state, deps, false);
    const timestamp = Number(deps.timestamp || Date.now());
    const persona = personaOf(state, deps);
    const board = deps.board || (isMainThread ? invoke('GameServer/AfkTrade/AfkTradeService').boardIndex() : null);
    const { price } = pricing(state, persona, board, timestamp, deps);
    let route = null;
    // The main thread records only on request (deps.keepIncomeRoute): its builds never read a record.
    const keep = !isMainThread || deps.keepIncomeRoute ? record => { route = record; } : null;
    const base = { persona, price, timestamp, ...foundation(state, deps, persona, timestamp, price, keep) };
    // Not enumerable: a view spread over these basics does not carry it (L120).
    Object.defineProperty(base, 'preparedIncomeRoute', { value: route });
    return base;
}
function stockFor(state, kind, deps = {}) { return basics(state, deps).stock(kind); }
function forState(state = {}, deps = {}) {
    const diagnostic = Diagnostics.active();
    const inputSequence = Number(state.stats?.decisionSeq || 0);
    const inputActivityLeaf = Number(state.stats?.activityLeaf || 0);
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
    const held = cache.get(actorKey);
    // A valid completed card survives planner-slot reuse or card eviction;
    // the same route is repriced with the current hour value, never a wallet.
    if (!deps.routeRows && held?.plan.routeKey === Trip.key(state)) deps.routeRows = held.plan.routeRows;
    const gearThreat = GearThreat.prepare(state, deps, held?.gearThreat);
    deps.gearThreatMask = gearThreat.mask;
    // The economy place of the hold scheme (Hold.js): the event key and the
    // one verdict on the held build (heldBuildVerdict). Off, every request
    // builds; diagnostics still ask the verdict for the gate counters.
    const activeEvents = eventReuseEnabled(deps);
    const keyParts = diagnostic && held?.plan.keyParts
        ? eventInputParts(state, deps, timestamp, held.activity, held.plan.network?.activity) : null;
    const key = keyParts ? proofDigest(keyParts) : eventInputKey(state, deps, timestamp, held?.activity, held?.plan.network?.activity);
    let keyMoved = null;
    if (keyParts && key !== held.plan.eventProof?.hard) {
        const moved = movedKeyParts(keyParts, held.plan.keyParts);
        keyMoved = moved[0] || 'none';
        Diagnostics.count('context', 'key_moved', keyMoved);
        // Every moved part: the first-only name masks trip behind facts.
        for (const name of moved) Diagnostics.count('context', 'key_moved_all', name);
    }
    // The held build's market items and spot crowd still read the same: read once per request.
    let readsHeld = null;
    const heldReadsHold = () => readsHeld ??= !held || marketHolds(sourceBoard, held.reads, deps) && spotsHold(deps, held.spotReads);
    const eventVerdict = activeEvents || diagnostic ? heldBuildVerdict(state, held?.plan.eventProof, deps, {
        baseline: held?.plan.statsPacket.wishSections, activity: held?.activity,
        leaf: held?.plan.network?.activity, heldUnits: held?.heldUnits, craftReservations: held?.craftReservations,
        mp: held?.mp, timestamp, currentKey: key }) : { valid: false, reason: 'unproved', touchedSections: 0 };
    // A caller that needs the member's graph nodes (a worker group solve)
    // builds unless the held entry kept them (the main thread keeps them);
    // such a request is no hold answer and is not counted. A market item or
    // spot crowd read after the proof was taken (a late price read of the
    // served plan) is soft as the proof's own reads (L70).
    const holdWhy = !activeEvents ? null : !eventVerdict.valid ? [eventVerdict.reason || 'unproved']
        : deps.withNodes && !held.projection ? null
            : heldReadsHold() || !Sections.softDue(held.plan.statsPacket?.wishSections, 'market', timestamp) ? [] : ['market'];
    if (holdWhy && diagnostic) Hold.check('economy', holdWhy, deps);
    // The step's second request against the build its first one left: both
    // requests of a worker step (pre-round lifecycle, post-round result) carry
    // the step's one timestamp, and every kept request stamps it (askedAt).
    // The prize of a post-round hold: refused = any build of the second
    // request; second_build = one after the first request built (2 -> 1).
    const secondAsk = diagnostic && !isMainThread && held?.askedAt === timestamp;
    const secondBuild = secondAsk && held.plan.timestamp === timestamp;
    if (secondAsk) Hold.count('economy', holdWhy?.length === 0 ? 'post_round:held' : 'post_round:refused');
    if (secondBuild && holdWhy?.length !== 0) Hold.count('economy', 'post_round:second_build');
    if (holdWhy?.length === 0) {
        if (deps.onSourceRead) for (const id of held.reads.keys()) if (id > 0) deps.onSourceRead(id);
        if (diagnostic) {
            Diagnostics.count('context', 'hit', held.key === key ? 'same_inputs' : 'own_result');
            if (deps.advisoryRefusal) Diagnostics.count('advisory', 'refusal_hit', deps.advisoryRefusal);
            // The timeline sees the served request too (tools/timeline).
            if (Diagnostics.enabled(state.characterId)) Diagnostics.push({ owner: state.characterId,
                caller: deps.caller || 'economy_context', trigger: deps.trigger || 'request', phase: 'wish_context',
                reason: held.key === key ? 'hit_same_inputs' : 'hit_own_result', outcome: 'held',
                revision: state.simulation?.revision, wallet: positive(state.adena) });
        }
        if (deps.rememberContext !== false) {
            held.askedAt = timestamp;
            held.gearThreat = gearThreat;
            held.stateRef = new WeakRef(state);
            remember(cache, actorKey, held, RETAIN_LIMIT);
        }
        // A late price read of a held plan joins its inputs, as in its build.
        const late = id => { id = Number(id); if (held.reads.has(id)) return;
            held.reads.set(id, marketToken(sourceBoard, id, deps)); deps.onSourceRead?.(id); };
        return view(state, held.plan, deps, { board: sourceBoard, read: late, projection: held.projection });
    }
    // A lost graph cache still has the bot's accepted execution card. Compare
    // its verdict with the one fresh card the normal publication captures;
    // this transient reference never joins a retained plan or another map.
    const candidate = diagnostic && !held ? deps.eventCandidate : null;
    const eventShadow = candidate ? { accepted: candidate,
        verdict: heldBuildVerdict(state, candidate.eventProof, deps, {
            baseline: candidate.baseline, activity: candidate.activity, leaf: candidate.card?.activity,
            mp: candidate.mp, timestamp, softPrefix: candidate.softPrefix === true }) } : null;
    const basis = activeEvents && eventVerdict.reason === 'money' && heldBuildVerdict(state, held.plan.eventProof, deps, {
        baseline: held.plan.statsPacket.wishSections, activity: held.activity, leaf: held.plan.network?.activity,
        heldUnits: held.heldUnits, craftReservations: held.craftReservations, mp: held.mp, timestamp, currentKey: key,
        rebuildBasis: true }).basisValid ? held.plan : null;
    const sections = sectionKeys(state, { ...deps, timestamp }, [], 'sources');
    const started = diagnostic ? performance.now() : 0;
    // The build's cause, one of a few names (its duration layer): the held
    // build's refusal is named by its verdict (hold:economy:<reason>). An
    // input-key mismatch is named as a dependency change; it does not claim
    // which historical event caused it.
    const diagnosticReason = !diagnostic ? null : !held ? deps.rememberContext === false ? 'unkept_caller' : 'not_retained'
        : held.key !== key ? 'input_dependency_changed'
        : !eventVerdict.valid ? 'held_refused'
        : deps.withNodes && !held.projection ? 'nodes_needed'
        : activeEvents ? 'market' : 'hold_off';
    if (diagnostic) Diagnostics.count('context', 'miss', diagnosticReason);
    let elapsed = 0, gate = null, gateDiff = null, gateSoft = null, gateEvidence = null;
    if (diagnostic) {
        gate = held?.plan.eventProof ? eventVerdict.valid ? 'would_hold' : eventVerdict.reason
            : held ? 'unproved' : 'no_held';
        Diagnostics.count('context', 'gate', gate);
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
    // Once the entry is stored, the read sets it holds: a late read of this
    // build's own view joins them, as it joined the Maps they were made from.
    let heldReads = null, heldSpots = null;
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
        // PERF L128: every write goes to every open scope at once, so a key the innermost scope already holds with this
        // token is held by all outer scopes too and the loop would change nothing (a Map.set on a held key keeps its place).
        const top = nodeScopes[nodeScopes.length - 1];
        if (top) { const held = tokenOf(id); if (held === undefined || top.items.get(id) !== held) for (const local of nodeScopes) local.items.set(id, tokenOf(id)); }
        const into = heldReads || reads;
        if (into.has(id)) return;
        if (scope) { if (!scope.has(id)) scope.set(id, tokenOf(id)); return; }
        into.set(id, tokenOf(id)); deps.onSourceRead?.(id);
    };
    const watch = id => { if (building) read(id); };
    const persona = personaOf(state, deps);
    const cash = Sections.bounds(positive(state.adena));
    const budget = Sections.bounds(Funding.budget(state, deps.buyOrderEscrow));
    const board = watchedBoard(sourceBoard, watch, id => { if (building) reads.set(id, tokenOf(id)); });
    // A price is remembered, so every price read counts, also a late one
    // through context.price: its item joins the review's inputs.
    const { price, prices, beliefs, beliefFor, knowledgeEnabled } = pricing(state, persona, board, timestamp, deps, read,
        basis ? new Map(basis.prices) : new Map());
    // The income route record of this build (its own search or the basics'
    // one): its solo matchup profiles serve the providers' source route reader.
    let incomeRecord = null;
    const base = basis ? foundationFromPlan(state, basis, deps, price)
        : foundation(state, deps, persona, timestamp, price, record => { incomeRecord = record; },
            id => spotReads.set(id, spotTokenOf(id)));
    if (basis) {
        // These facts still belong to the accepted basis. Retain their
        // original tokens; a later read must not renew an untouched input.
        for (const [id, token] of held.reads) { reads.set(id, token); if (id > 0) deps.onSourceRead?.(id); }
        for (const [id, token] of held.spotReads) spotReads.set(id, token);
    }
    const quantityInputs = createQuantityInputs();
    const context = { inputKey: key, actorKey, state, timestamp, gearThreatMask: gearThreat.mask, persona, board, hunt: base.hunt, price, buyback,
        quantityInputs,
        nominationBasis: basis?.nominationBasis ?? Providers.nominationBasis(state),
        ...(basis ? { horizonHours: basis.horizonHours } : {}),
        touchedSections: Number(state.stats?.wishDirty || 0) | Number(deps.eventVerdict?.touchedSections || 0)
            | Number(eventVerdict.touchedSections || 0),
        riskWeight: base.riskWeight, bestSpotId: base.bestSpotId, deathHours: base.deathHours, lostGearHours: base.lostGearHours,
        karmaHours: base.karmaHours, expectedDeathHours: base.expectedDeathHours, stock: base.stock,
        survivalReserve: base.survivalReserve, kitCost: base.kitCost, hourAdena: base.hourAdena,
        walletBoundary: cash.watch,
        budgetBoundary: budget.watch,
        // Every evaluated source participates in admission/ranking, including a losing candidate.
        sourceSpot: id => { const token = spotTokenOf(id);
            (heldSpots || spotReads).set(id, token);
            const top = nodeScopes[nodeScopes.length - 1];
            if (top && (token === undefined || top.spots.get(id) !== token)) for (const local of nodeScopes) local.spots.set(id, token); },
        nodeInputs: { begin: () => { const local = { items: new Map(), spots: new Map(), bag: new Map() }; nodeScopes.push(local); return local; },
            end: () => nodeScopes.pop(),
            bag: id => { if (!(Number(id) > 0) || !nodeScopes.length) return;
                const token = bagTokenOf(id);
                const top = nodeScopes[nodeScopes.length - 1];
                if (token === undefined || top.bag.get(Number(id)) !== token) for (const local of nodeScopes) local.bag.set(Number(id), token); },
            wholeBag: () => { if (!nodeScopes.length) return;
                for (const id of wholeBagIds()) context.nodeInputs.bag(id);
                const token = wholeBagKeys();
                const top = nodeScopes[nodeScopes.length - 1];
                if (token === undefined || top.bag.get(-1) !== token) for (const local of nodeScopes) local.bag.set(-1, token); },
            holds: input => (!deps.workshops || !!deps.workshopRevision || !!deps.inputKey)
                && marketHolds(sourceBoard, input.items || [], deps)
                && input.spots.every(([id, token]) => spotTokenOf(id) === token)
                && (input.bag || []).every(([id, token]) => (id === -1 ? wholeBagKeys() : bagTokenOf(id)) === token),
            keep: input => { for (const [id] of input.items) read(id);
                for (const [id] of input.spots) context.sourceSpot(id);
                for (const [id] of input.bag || []) if (id === -1) context.nodeInputs.wholeBag(); else context.nodeInputs.bag(id); } },
        readScope: { open: () => (scope = new Map()), close: () => { scope = null; },
            keep: kept => { const into = heldReads || reads;
                for (const [id, token] of kept) if (!into.has(id)) { into.set(id, token); deps.onSourceRead?.(id); } } } };
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
        endTokens();
        return view(state, planOf(context, base, { key, market: null, tripHour, prices }), deps, { price, kit: base, board, read, spotValue: context.spotValue, trip: context.trip });
    }
    // One stock reader for the provider's gear witnesses and the network
    // build; the projection is read lazily once it exists (stock roots).
    context.wallet = Funding.budget(state, deps.buyOrderEscrow);
    const nativeStock = stockReader(state, rootKey => context.projection?.nodes.find(node => node.key === rootKey)?.object?.itemId);
    context.stockFor = (id, rootKey) => quantityInputs.stock(id, rootKey, nativeStock(id, rootKey));
    context.completionKey = Crystallization.completionKey(state, quantityInputs);
    const extra = [...extensions.values()].flatMap(provider => provider(state, context) || []);
    const sourceSections = held?.sections?.sources === sections.sources
        ? held.sourceSections : null;
    if (diagnostic) {
        Diagnostics.count('source_memo', sourceSections ? 'hit' : 'miss', sourceSections ? 'held'
            : !held ? 'no_held' : !held.sourceSections ? 'no_memo' : 'key');
        Diagnostics.count('context', 'caller', deps.caller || 'economy_context');
    }
    const projection = Providers.build(state, context, { ...deps, sourceSections, nodes: [...(deps.nodes || []), ...extra],
        soloProfiles: incomeRecord?.route?.matchupProfiles });
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
    const bagValue = choiceBagValue(state, choiceBands, context.buyback);
    const acceptedSections = state.stats?.wishSections;
    context.choiceInputs = Sections.hash([choiceShape.structural,
        [...reads].sort(([a], [b]) => a - b), [...spotReads].sort(([a], [b]) => String(a).localeCompare(String(b)))]);
    const unchangedChoice = Number(acceptedSections?.choices) === context.choiceInputs
        && choiceBagValueHolds(state, choiceBands, acceptedSections, context.hourAdena, bagValue)
        && heldReadsHold();
    context.choiceBagValue = unchangedChoice ? acceptedSections.bagValue : bagValue;
    // An event re-weighs the held focus and step (WishNetwork reconsider): a
    // raised section, or a soft change once its kind's delay since the last
    // decision has passed (money, observation, horizon; the market items and
    // spot crowd the held build read). A rebuild where only noise moved keeps
    // them. A crafter's MP fences its plan (sources), not its goal: no event.
    const dirty = (Number(state.stats?.wishDirty) || 0) | (activeEvents ? context.touchedSections : 0);
    const soft = dirty ? null
        : softEvent(state, { baseline: acceptedSections, expPerHour: acceptedSections?.expHour, persona }, timestamp, deps);
    const reconsider = dirty !== 0 || soft !== null;
    const network = engine.build({ actorKey, inputKey: networkKey, ...projection,
        remembered: deps.rememberContext !== false,
        stockFor: context.stockFor,
        completionKey: context.completionKey,
        characterId: state.characterId, decisionSeq: state.stats?.decisionSeq, activityLeaf: state.stats?.activityLeaf,
        wallet: context.wallet, survivalReserve: base.survivalReserve,
        reconsider,
        // Diagnostics only: the events that re-weigh (network:reconsider), 'quiet' for none.
        reconsiderReasons: !diagnostic ? null : dirty ? Sections.sectionNames(dirty)
            : [soft === null ? 'quiet' : soft === 'money' ? 'soft_money' : soft],
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
    context.statsPacket = { wishFocus: network.focus, dormantWishes: network.dormant,
        decisionSeq: network.decisionSeq, activityLeaf: network.activityLeaf,
        money: Funding.packetFor(network, context.hourAdena, base.survivalReserve), stockTargets: stockTargets(base), wishDirty: 0 };
    let cumulative = base.survivalReserve;
    for (const wish of network.queue) { cumulative += cashCharge(wish); budget.watch(cumulative); }
    const watchedWish = network.gap || network.queue.find(wish => wish.key === network.focus?.[0]);
    const watchedItem = Number(watchedWish?.object?.itemId);
    const belief = beliefs.get(watchedItem) || (basis && watchedItem > 0 ? beliefFor(watchedItem) : null);
    const moneyError = belief ? knowledgeEnabled
        ? positive(watchedWish.price) * Math.expm1(invoke('GameServer/Bot/Economy/PriceBelief').sigma(belief)) : 0 : -1;
    // One read of the build's semantic facts: its observation baseline and its event key.
    const facts = Sections.semanticFacts(state);
    context.statsPacket.wishSections = Sections.snapshot(state, context, cash.result, moneyError, deps.mode,
        { buyOrderEscrow: deps.buyOrderEscrow, budgetBounds: budget.result }, facts, Providers.relationBond(state, deps));
    // The trigger is not the calculation basis. Only the proven money path
    // kept the original valuation inputs; a fresh fallback adopted all of
    // them and must publish matching baselines, including downstream money.
    if (activeEvents) Sections.carrySectionBaseline(acceptedSections, context.statsPacket.wishSections,
        basis ? Sections.sectionBit('money') : Sections.sectionMask(Sections.SECTIONS));
    building = false; endTokens();

    if (diagnostic) {
        Diagnostics.count('context', 'build', diagnosticReason);
        // Per reason too: a wave's builds cost ~3x a calm one's (2026-10-15);
        // the split says whether lost retention or a moved input is the dear one.
        elapsed = performance.now() - started;
        Diagnostics.duration('context', elapsed);
        Diagnostics.duration(`context:${diagnosticReason}`, elapsed);
        if (gate === 'would_hold') {
            gateEvidence = {};
            gateDiff = gatePlanDiff(state, held, context, deps, gateEvidence);
            // A diff while the held proof's own soft sources moved inside their
            // delay is by design (<diff>_soft); the bare <diff> read them intact.
            gateSoft = gateDiff === 'same' ? null : Number(!softSourcesHold(held.plan.eventProof, deps));
            Diagnostics.count('context', 'gate_plan', gateSoft ? `${gateDiff}_soft` : gateDiff);
            if (gateDiff === 'focus') {
                // Each marginal shares the focus denominator; these are not paired transitions.
                Diagnostics.count('context', 'gate_focus_held', focusKind(held.plan.network.focus?.[0]));
                Diagnostics.count('context', 'gate_focus_fresh', focusKind(network.focus?.[0]));
            }
            Diagnostics.count('context', 'gate_ms', 'would_hold', Math.round(elapsed));
        } else if (held && Diagnostics.enabled(state.characterId)) {
            // Sampled owners: did the build the verdict refused change the plan?
            // same per refusal reason is the waste the reason's rule costs.
            gateDiff = gatePlanDiff(state, held, context, deps);
            // An event_key refusal names the moved field, a sections refusal
            // the moved facts, a wish_dirty refusal its raised sections: per
            // field, does the move give another plan (focus or leaf: a real
            // decision change; queue, funded: its order)?
            const refusal = gate === 'event_key' && keyMoved ? `event_key.${keyMoved}`
                : (gate === 'sections' || gate === 'wish_dirty') && eventVerdict.facts ? `${gate}.${eventVerdict.facts}` : gate;
            Diagnostics.count('context', 'refused_plan', `${refusal}:${gateDiff}`);
        }
        // Sampled owners: what the step's second build changed against the first.
        if (secondBuild && gateDiff && Diagnostics.enabled(state.characterId)) Hold.count('economy', `post_round:${gateDiff}`);
    }
    // The build's record carries its cause (tools/timeline): the miss reason and the time it took.
    const mismatch = gateDiff !== null && Diagnostics.isPlanMismatch({ owner: state.characterId, phase: 'wish_context', gate, gateDiff });
    if (mismatch) Diagnostics.push({ owner: state.characterId, phase: 'wish_context', gate, gateDiff,
        baselineAt: held.plan.statsPacket.wishSections.at, sequence: inputSequence, inputActivityLeaf,
        decisionSeq: network.decisionSeq, activityLeaf: network.activityLeaf,
        // A fresh focus/leaf equal to the held one is left out: a queue or
        // funded witness has both equal, and its evidence needs the bytes.
        heldFocus: held.plan.network.focus?.[0], freshFocus: network.focus?.[0] === held.plan.network.focus?.[0] ? undefined : network.focus?.[0],
        heldLeaf: held.plan.network.activity?.key, freshLeaf: network.activity?.key === held.plan.network.activity?.key ? undefined : network.activity?.key,
        reconsidered: Number(reconsider), choiceEvent: dirty ? Sections.sectionNames(dirty).join(',') : soft || 'quiet',
        soft: gateSoft, ...gateEvidence });
    else if (diagnostic && Diagnostics.enabled(state.characterId)) Diagnostics.push({ owner: state.characterId,
        caller: deps.caller || 'economy_context', trigger: deps.trigger || diagnosticReason,
        phase: 'wish_context', reason: diagnosticReason, inputHash: fnv1a32(networkKey),
        durationMs: Math.round(elapsed * 100) / 100,
        sequence: inputSequence, decisionSeq: network.decisionSeq, activityLeaf: network.activityLeaf,
        inputActivityLeaf: gate === 'would_hold' ? inputActivityLeaf : undefined,
        revision: state.simulation?.revision, wallet: positive(state.adena), escrow: positive(deps.buyOrderEscrow),
        available: network.available, reserve: base.survivalReserve, wishKey: network.focus?.[0], gate, gateDiff,
        ...(keyMoved ? { moved: keyMoved } : {}),
        ...(gateDiff ? { outcome: gateDiff === 'same' ? 'same_plan' : 'new_plan' } : {}),
        heldFocus: held?.plan.network.focus?.[0], freshFocus: network.focus?.[0],
        heldLeaf: held?.plan.network.activity?.key, freshLeaf: network.activity?.key,
        ...(['focus', 'leaf'].includes(gateDiff) || gate === 'check_failed' ? shadowQuantityEvidence(state, held) : null) });
    const plan = planOf(context, base, { key, market, tripHour, projection, knowledgeEnabled, prices });
    plan.quantityBands = choiceBands;
    plan.bagFull = bagFull(state);
    // Source memo belongs only to the bounded cache owner. A planning view
    // or a group closure must never retain a second copy outside that cap.
    const retainedSourceMemo = projection.sourceSections;
    projection.sourceSections = null;
    if (deps.rememberContext !== false) {
        if (diagnostic && !cache.has(actorKey) && cache.size >= RETAIN_LIMIT) Diagnostics.count('context', 'eviction', 'capacity');
        // The main thread keeps the graph nodes as before (its group solve
        // reads them on a hit); the worker keeps the plan only (perf C1).
        // Its own activity: the later reuse verdict reads the held build
        // with it. The source sections are read only to reuse the source memo, so
        // they are kept with it and dropped with it (L104).
        heldReads = new HeldReads(reads); heldSpots = new HeldReads(spotReads);
        const parts = diagnostic ? eventInputParts({ ...state, stats: { ...state.stats, ...plan.statsPacket } }, deps,
            plan.timestamp, state.activity, plan.network?.activity, facts) : null;
        plan.eventProof = captureEventProof(state, deps, { plan, reads: heldReads, spots: heldSpots, facts, parts });
        // Diagnostics: the parts behind the proof's digest, for context:key_moved.
        if (parts && plan.eventProof) plan.keyParts = parts.map(part => JSON.stringify(part));
        // What the card stamps on its leaf, read once for the held verdict: the
        // own item's bag+incoming at the decision (heldAtDecision) and a
        // craft's reserved inputs (craftReservations).
        const leaf = plan.network?.activity, own = ColdEconomyDecision.ownItem(leaf);
        remember(cache, actorKey, { key, askedAt: timestamp,
            heldUnits: own === null ? undefined : ColdEconomyDecision.heldFor(state, own),
            craftReservations: leaf?.activity === 'crafting' ? CraftInputReservations.heldCraftRows(state, plan.network.craftNeeds) : undefined,
            reads: heldReads, spotReads: heldSpots, plan, stateRef: new WeakRef(state), gearThreat,
            sections: retainedSourceMemo ? sections : null,
            activity: state.activity,
            sourceSections: retainedSourceMemo, mp: Number(state.vitals?.mp),
            projection: isMainThread ? projection : null }, RETAIN_LIMIT);
        if (retainedSourceMemo) {
            sourceHolders.delete(actorKey); sourceHolders.add(actorKey);
            while (sourceHolders.size > SOURCE_MEMO_LIMIT) {
                const oldest = sourceHolders.keys().next().value; sourceHolders.delete(oldest);
                const entry = cache.get(oldest); if (entry) entry.sourceSections = entry.sections = null;
            }
        }
    }
    return view(state, plan, deps, { price, kit: base, board, read, spotValue: context.spotValue, trip: context.trip, projection,
        eventShadow });
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
const NODE_FIELDS = ['kind', 'sourceType', 'quoted', 'executable', 'recipeId', 'missingAmount', 'improvement', 'unseal', 'batches'];
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
// the plans of requirement rows that have none. A selected crystal operation
// also keeps its one root: owned inputs can remove it from the money queue.
// craftNeeds: the selected craft's inputs, walked once on the full network
// for the card and the held verdict (absent when the root is no craft).
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
    if (leaf?.rootKey?.startsWith('power:') && ['crystallize', 'luxury_exchange', 'mammon_unseal'].includes(leaf.kind)
        && all.has(leaf.rootKey)) plans.set(leaf.rootKey, trim(all.get(leaf.rootKey)));
    for (const key of unresolved) if (!plans.has(key) && all.has(key)) plans.set(key, trim(all.get(key)));
    const craftNeeds = CraftInputReservations.selectedCraftNeeds(network);
    // The network's input key is the plan's key with its market (~2 KB of
    // text per bot, L104): view() gives it back from them, in its place.
    return { ...network, inputKey: undefined, queue, gap: !network.gap ? network.gap : at >= 0 ? queue[at] : row(network.gap), activity, plans,
        ...(craftNeeds.length ? { craftNeeds } : {}) };
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
        gearThreatMask: context.gearThreatMask, persona: context.persona, hunt: context.hunt,
        riskWeight: context.riskWeight, bestSpotId: context.bestSpotId, deathHours: context.deathHours,
        lostGearHours: context.lostGearHours, karmaHours: context.karmaHours, expectedDeathHours: context.expectedDeathHours,
        survivalReserve: context.survivalReserve, kit: base.kit, hourAdena: context.hourAdena, workshop: context.workshop,
        routeKey: context.routeKey, routeRows: context.routeRows, routePending: context.routePending, tripHour,
        network: compactNetwork(context.network), moneyPrice: context.moneyPrice, gapHorizonHours: context.gapHorizonHours,
        watchList: context.watchList, intentPending: context.intentPending, statsPacket: context.statsPacket,
        wallet: context.wallet, horizonHours: context.horizonHours, values: projection?.values, stockRoots, knowledgeEnabled,
        quantityInputs: projection ? context.quantityInputs?.finish() : null, nominationBasis: context.nominationBasis,
        liquidationInputs: context.liquidationInputs,
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
    .npcBuyPrice(Number(ItemIndex.find(DataCache.items, id)?.template?.price || 0));
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
    const funding = moneyQueue(plan.network.queue, Funding.budget(state, deps.buyOrderEscrow),
        plan.survivalReserve, plan.hourAdena > 0 ? 1 / plan.hourAdena : 0);
    const inputKey = plan.market === null ? plan.key : `${plan.key}#${plan.market}`;
    const network = { ...plan.network, inputKey, ...funding };
    const statsPacket = plan.pending ? plan.statsPacket : { ...plan.statsPacket,
        money: Funding.packetFor(network, plan.hourAdena, plan.survivalReserve) };
    const context = { inputKey, actorKey: plan.actorKey, state,
        timestamp: plan.timestamp, gearThreatMask: plan.gearThreatMask, persona: plan.persona, board: built.board, hunt: plan.hunt,
        price, buyback, riskWeight: plan.riskWeight, bestSpotId: plan.bestSpotId,
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
    Object.defineProperty(context, 'eventProof', { value: () => plan.eventProof || null });
    if (built.eventShadow) Object.defineProperty(context, 'eventShadow', { value: built.eventShadow });
    Object.defineProperty(context, 'gearPlanMemo', { get: () => plan.gearPlanMemo, set: memo => { plan.gearPlanMemo = memo; } });
    if (plan.pending) {
        context.itemUsefulness = () => 0; context.worth = price; context.purchaseBudget = () => 0;
        return context;
    }
    context.wallet = Funding.budget(state, deps.buyOrderEscrow);
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
function forActor(actor, session, deps = {}) {
    const state = stateForActor(actor, session);
    if (!isMainThread || !eventReuseEnabled(deps)) return forState(state, deps);
    // lazy: cycle the coordinator publishes hot handoffs through this owner.
    const coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
    const accepted = coordinator.economyDecisions?.advisoryFor(state);
    if (!accepted) return forState(state, deps);
    // The same accepted memory owner serves hot and cold validity. Reading
    // the original advisory is not permission to execute its selected act.
    // lazy: cycle the native memory runtime also calls economic consumers.
    const memory = invoke('GameServer/Social/InteractionMemoryRuntime');
    const input = { ...deps, memory: memory.snapshot(Number(state.characterId)),
        memoryIdentity: memory.contentIdentity(Number(state.characterId)),
        routeRows: deps.routeRows || preparedRouteRows(state) || coordinator.routeRows?.(state) };
    const prepared = {};
    const refreshed = ColdEconomyDecision.refreshAdvisory(state, accepted, input, { prepared });
    return refreshed?.economy || forState(state, { ...input, eventVerdict: prepared.eventVerdict });
}
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
    // Each member's network key (its event inputs and the market items its
    // review read) and its plan's echo (decision sequence, leaf, focus): the
    // event key does not move with a member's own decision, so with the echo
    // equal keys are equal member plans (perf C1: a member's later view is a
    // new object over the same plan).
    const key = [wallet, ...contexts.map(({ inputKey, statsPacket: packet }) =>
        `${inputKey}:${packet?.decisionSeq}:${packet?.activityLeaf}:${packet?.wishFocus?.[0]}`)].join('|');
    const held = proposal ? null : groups.get(actorKey);
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
        sourceHolders.delete(key);
        if (cache.delete(key) && Diagnostics.active()) { Diagnostics.count('context', 'eviction', reason); }
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
    cache.clear(); sourceHolders.clear(); groups.clear(); engine.clear(); routeAnchors = new WeakMap();
}
function size() { return { context: cache.size, engine: engine.cache.size, groups: groups.size }; }

module.exports = { FIELD_ACTIVITIES, eventReuseEnabled, eventInputKey, captureEventProof, heldBuildVerdict, eventProofHolds, restartEventProof, receiveEventProof, restoreEventProof, wireEventProof, heldEventsQuiet, size, forState, forActor, forGroup, forgetGroup, basics, stockFor, keptTargets, stateForActor, routeState, preparedRouteRows, RETAIN_LIMIT, sectionKeys, acceptedActivityHolds, heldLeafRefusal, survivalReserve, forgetContext, forget, reset, configure, registerProvider,
    craftIncome, summary: () => ({ mainColdForState: Diagnostics.active() ? Object.fromEntries(mainColdForState || []) : null }),
    resetCounters: () => { mainColdForState = null; } };
