const ItemTemplateIndex = require('../Item/ItemTemplateIndex');
const { DiagnosticMetricMap } = require('../Bot/Population/DiagnosticMetricMap');
const DiagnosticConfig = require('../Bot/Population/PopulationConfig');
const Crafting = require('./ClanCraftingPolicy');
const CraftShops = invoke('GameServer/Bot/Economy/CraftShopService');
const Database = invoke('Database');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const ComponentProgress = invoke('GameServer/Bot/AI/EquipmentAcquisitionProgress');
const ClanCredit = require('./ClanPurchaseCredit');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const Policy = invoke('GameServer/Clan/ClanEquipmentPolicy');
const Config = invoke('GameServer/Clan/ClanSimulationConfig');
const GoalPolicy = invoke('GameServer/Clan/ClanGoalPolicy');
const ClanPolicy = invoke('GameServer/Clan/ClanSimulationPolicy');
const ClanRaidPolicy = require('./ClanRaidPolicy');
const ClanRaidFailurePolicy = require('./ClanRaidFailurePolicy');
const BackgroundPartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');
const DataCache = invoke('GameServer/DataCache');
const { planForMember } = require('./ClanEquipmentPlanner');
const PlanningWorker = require('./ClanPlanningCoordinator');
const RosterDemand = require('./ClanRosterDemand');
const MAX_CAPACITY_TARGET_RETRIES = 5;

const metrics = {
    resolves: 0,
    plans: 0,
    assignments: 0,
    partyAssignments: 0,
    assignmentFailures: 0,
    noDebt: 0,
    reasonCounts: new DiagnosticMetricMap()
};

function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try {
        const parsed = JSON.parse(value || '{}');
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch (_) {
        return fallback;
    }
}

function recordReason(reason) {
    if (reason) DiagnosticConfig.developerDiagnostics && metrics.reasonCounts.set(reason, (metrics.reasonCounts.get(reason) || 0) + 1);
}

function reservationOptionsForClan(clan) {
    return {
        reservationKey: `clan-equipment:${number(clan?.id)}`,
        maxReservationGroups: SpotProfiles.MAX_CLAN_EQUIPMENT_RESERVATIONS_PER_SPOT
    };
}

function reserveGoalCapacity(planning = {}, clan = {}, assignedMemberIds = [], selectedSpot = null) {
    if (!selectedSpot) return { occupancy: planning.occupancy || {}, reserved: true };
    let occupancy = planning.occupancy || {};
    try {
        // Candidate construction may await an LLM decision. Its planning
        // snapshot can therefore be several seconds old by the time the goal
        // is applied. Always rejoin the shared one-second occupancy snapshot
        // here; reserveCapacity mutates that object so later clan actions in
        // the same batch immediately observe this reservation.
        occupancy = SpotProfiles.currentOccupancy(planning.spots || []) || occupancy;
    } catch (_) {
        // Keep deterministic harnesses and startup recovery best-effort when
        // the world spot index is not ready yet.
    }
    return {
        occupancy,
        reserved: SpotProfiles.reserveCapacity(
            occupancy,
            selectedSpot,
            assignedMemberIds.map((characterId) => ({ characterId })),
            reservationOptionsForClan(clan)
        )
    };
}

function planningFingerprint(clan) {
    return JSON.stringify(clan && {
        id: clan.id, level: clan.level, leaderId: clan.leaderId,
        updatedAt: clan.state?.updatedAt, warehouseRevision: clan.state?.warehouseRevision,
        mode: clan.state?.mode, goal: clan.state?.goal, productionGoal: clan.state?.productionGoal,
        rateProfile: GearAcquisitionPlanner.rateProfileSignature(),
        members: (clan.members || []).map((member) => ({
            id: memberId(member), level: member.level, classId: member.classId,
            phase: member.phase, owner: member.simulationOwner, partyId: member.partyId,
            equipment: Object.values(member.inventory || {}).filter((item) => item?.equipped === true)
                .map(({ selfId, slot, equippedSlots, equippedCount, enchant }) => ({ selfId, slot, equippedSlots, equippedCount, enchant }))
        }))
    });
}

function beneficiaryFingerprint(member) {
    return JSON.stringify(member && {
        inventory: member.inventory, adena: member.adena, region: member.currentRegion,
        plan: member.stats?.equipmentPlan
    });
}

function planningDeferred(message) {
    return Object.assign(new Error(message), { code: 'clan_planning_deferred' });
}

async function validatePlanning(clan, planning, selection = null) {
    if (!planning.workerFingerprint) return;
    const current = await invoke('GameServer/Clan/ClanGoalService').clanProjectionById(clan.id);
    const id = memberId(selection?.member);
    const beneficiaryChanged = id && planning.beneficiaryFingerprints?.[id] !== beneficiaryFingerprint(
        current?.members?.find((member) => memberId(member) === id));
    if (planning.workerFingerprint !== planningFingerprint(current) || beneficiaryChanged) {
        recordReason('clan_planning_stale');
        throw planningDeferred('clan planning snapshot changed');
    }
}

function clanPlan(plan, clan, goal) {
    const partyNeed = plan.partyNeed === 'required' ? 'required' : 'preferred';
    return {
        ...plan,
        expectedKillsLimit: Config.equipmentMaxExpectedKills,
        clanGoal: {
            clanId: number(clan.id),
            goalKey: goal.goalKey,
            beneficiaryId: number(goal.target.memberId),
            priority: 'required',
            partyNeed,
            partyPreference: 'clan_first',
            ...(goal.fullRoster ? { fullRoster: goal.fullRoster } : {}),
            ...(goal.orderId ? { orderId: goal.orderId, orderSettings: goal.orderSettings } : {})
        }
    };
}

function samePlanTarget(left, right) {
    return number(left?.target?.selfId) > 0
        && number(left?.target?.selfId) === number(right?.target?.selfId)
        && number(left?.target?.slot) === number(right?.target?.slot);
}

function samePlanRoute(left, right) {
    return String(left?.next?.spotId || '') === String(right?.next?.spotId || '')
        && number(left?.next?.npcId) === number(right?.next?.npcId)
        && number(left?.next?.itemId) === number(right?.next?.itemId);
}

function memberId(member) {
    return number(member?.characterId ?? member?.id);
}

function activeRaidPartyForClan(clanId) {
    const id = number(clanId);
    if (!id) return null;
    const partyPolicy = require('../Bot/Population/ClanEquipmentPartyPolicy');
    return BackgroundPartyState.active().find((party) => {
        const objective = party?.stats?.objective;
        const started = ['preparing', 'ready'].includes(party?.stats?.raidPreparation?.status)
            || party?.stats?.raidEncounter?.status === 'active';
        const minPartySize = Math.max(2, number(objective?.minPartySize, ClanRaidPolicy.MIN_MEMBERS));
        const viableRoster = (party?.memberIds || []).length >= minPartySize;
        return party?.status !== 'dissolved'
            && number(objective?.clanId) === id
            && (objective?.sourceKind === 'raid' || objective?.raidBoss === true)
            && started
            && viableRoster
            && !partyPolicy.abandonedRaid(party)
            && !['defeated', 'failed'].includes(party?.stats?.raidEncounter?.status);
    }) || null;
}

function planningMemberOrder(members = [], previousMemberId = 0, previousFulfilled = false) {
    const eligible = members
        .filter((member) => member?.phase === 'cold'
            && (!member?.partyId || memberId(member) === number(previousMemberId)))
        .sort((left, right) => memberId(left) - memberId(right));
    const previousIndex = eligible.findIndex((member) => memberId(member) === number(previousMemberId));
    if (previousIndex < 0) return eligible;
    if (!previousFulfilled) {
        return [eligible[previousIndex], ...eligible.filter((_, index) => index !== previousIndex)];
    }
    return [
        ...eligible.slice(previousIndex + 1),
        ...eligible.slice(0, previousIndex + 1)
    ];
}

function equipmentRoster(clan, beneficiary, previousGoal = null, plan = null) {
    const beneficiaryId = memberId(beneficiary);
    if (plan && (!plan.next?.spotId || ['ready_to_craft', 'component_ready'].includes(plan.status))) return [beneficiaryId];
    if (plan?.next?.sourceKind === 'raid' || plan?.next?.raidBoss === true) {
        const profile = invoke('GameServer/RaidBoss/RaidBossSourceCatalog').findById(plan.next.spotId);
        return profile ? ClanRaidPolicy.roster(clan, profile, beneficiary, previousGoal) : [];
    }
    const safety = require('../Bot/Population/ClanEquipmentPartyPolicy');
    const objective = { ...plan?.next, clanOperation: 'equipment', clanId: clan.id };
    const eligible = (clan?.members || []).filter(member => safety.allowed(member, objective));
    const memberIds = new Set(eligible.map(memberId).filter(Boolean));
    const previousBeneficiaryId = number(previousGoal?.target?.memberId);
    const retained = (previousGoal?.assignedMemberIds || []).map(number)
        .filter((id) => memberIds.has(id));
    const requiresSpoiler = String(plan?.next?.kind || '') === 'spoil';
    const spoilerFor = member => ClanPolicy.rosterRole(member) === 'spoiler' || RosterDemand.ownedSpoilCapability(clan, member, plan);
    const retainedHasSpoiler = retained.some((id) => (
        spoilerFor((clan?.members || []).find((member) => memberId(member) === id))
    ));
    if (beneficiaryId && beneficiaryId === previousBeneficiaryId
        && retained.length >= Math.max(2, number(Config.operationMinMembers, 5))
        && (!requiresSpoiler || retainedHasSpoiler)) return retained;
    const maxMembers = Math.max(2, Math.min(9, number(Config.operationMaxMembers, 9)));
    const selected = GoalPolicy.operationMembers(eligible, maxMembers);
    if (beneficiaryId && memberIds.has(beneficiaryId) && !selected.includes(beneficiaryId)) {
        if (selected.length >= maxMembers) selected.pop();
        selected.unshift(beneficiaryId);
    }
    if (requiresSpoiler && !selected.some((id) => (
        spoilerFor((clan?.members || []).find((member) => memberId(member) === id))
    ))) {
        const spoiler = eligible.find((member) => (
            member?.phase === 'cold' && !member?.partyId && spoilerFor(member)
        ));
        const spoilerId = memberId(spoiler);
        if (spoilerId) {
            if (selected.length >= maxMembers) selected.pop();
            selected.push(spoilerId);
        }
    }
    return [...new Set(selected.map(number).filter(Boolean))];
}

function clanPartyObjective(plan, goal, priority = 'preferred', clanId = 0) {
    // A craft plan with missing components still has a farming route in
    // `next`; a ready-to-craft plan has no route and therefore needs no party.
    if (['ready_to_craft', 'component_ready'].includes(plan?.status)
        || !['farm', 'craft'].includes(String(goal?.plan?.kind || '')) || !plan?.next?.spotId) return null;
    const strategy = String(plan.strategy || 'direct_drop');
    const targetItemId = number(plan.next.itemId || plan.target?.selfId);
    const npcId = number(plan.next.npcId);
    const objectiveKey = npcId > 0
        ? [strategy, plan.next.spotId, npcId].join(':')
        : [strategy, plan.next.spotId, npcId, targetItemId].join(':');
    const rosterSize = Math.max(1, (goal?.assignedMemberIds || []).length);
    const maxPartySize = Math.max(2, Math.min(9, rosterSize));
    const raid = plan.next?.sourceKind === 'raid' || plan.next?.raidBoss === true;
    const minPartySize = goal.fullRoster ? 9 : raid
        ? Math.max(2, Math.min(maxPartySize, ClanRaidPolicy.MIN_MEMBERS))
        : Math.max(2, Math.min(maxPartySize, number(Config.operationMinMembers, 5)));
    return {
        status: 'open',
        priority,
        objectiveKey,
        reason: 'clan_equipment',
        partyNeedReason: 'clan_equipment',
        strategy,
        sourceKind: raid ? 'raid' : String(plan.next.kind || 'drop'),
        rewardKind: String(plan.next.kind || 'drop'),
        raidBoss: raid,
        sharedEncounter: raid,
        raidBossTemplateId: raid ? number(plan.next.raidBossTemplateId || plan.next.npcId) : null,
        spotId: plan.next.spotId,
        npcId: npcId || null,
        itemId: targetItemId || null,
        targetId: number(plan.target?.selfId) || null,
        beneficiaryId: number(goal.target?.memberId),
        targetName: plan.target?.name || null,
        clanId: number(clanId) || null,
        clanGoalKey: goal.goalKey || null,
        partyPreference: 'clan_first',
        clanOperation: 'equipment',
        maxPartySize: goal.fullRoster ? 9 : maxPartySize,
        minPartySize,
        ...(goal.fullRoster ? { fullRoster: goal.fullRoster } : {}),
        levelRange: 99,
        requestedAt: Date.now(),
        reviewAt: Date.now() + 300000,
        attempts: 0,
        lastMatchedAt: null
    };
}

function fullRosterIdentity(marker) {
    return marker ? [marker.clanId, marker.ownerSection, marker.goalKey, marker.generation,
        [...(marker.memberIds || [])].map(number).sort((a, b) => a - b), marker.sourceId, marker.npcId, marker.raidInstanceId] : null;
}
function sameRosterRequirement(left, right) {
    return number(left?.minPartySize) === number(right?.minPartySize)
        && number(left?.maxPartySize) === number(right?.maxPartySize)
        && JSON.stringify(fullRosterIdentity(left?.fullRoster)) === JSON.stringify(fullRosterIdentity(right?.fullRoster));
}
function startedRaidParty(party) {
    return !!party && require('./ClanMembershipPolicy').activeRaidGoalKeys([party]).size > 0;
}
function stateHasSameClanObjective(state, objective) {
    return String(state?.stats?.clanPartyObjective?.clanGoalKey || '') === String(objective?.clanGoalKey || '')
        && String(state?.stats?.clanPartyObjective?.objectiveKey || '') === String(objective?.objectiveKey || '')
        && sameRosterRequirement(state?.stats?.clanPartyObjective, objective)
        && sameRosterRequirement(state?.stats?.partyRequest, objective)
        && state?.stats?.partyRequest?.status === 'open'
        && state.stats.partyRequest.priority === objective.priority;
}

async function releasePreviousBeneficiary(clan, previousGoal, nextGoal) {
    const previousMemberId = number(previousGoal?.target?.memberId);
    if (!previousMemberId || previousMemberId === number(nextGoal?.target?.memberId)) {
        return { changed: false, releasedMembers: 0 };
    }
    const previousGoalKey = String(previousGoal?.goalKey || '');
    const parties = BackgroundPartyState.active().filter((party) => (
        String(party?.stats?.objective?.clanGoalKey || '') === previousGoalKey
    ));
    let releasedMembers = 0;
    for (const party of parties) {
        const dissolved = await BackgroundPartyState.setStatus(party.partyId, 'dissolved');
        if (dissolved) {
            releasedMembers += number(await LifeState.releaseDissolvedPartyMembers(
                party.partyId,
                'clan_equipment_goal_rotated'
            ));
        }
    }

    const current = await LifeState.findByCharacterId(previousMemberId);
    const currentPlan = current?.stats?.equipmentPlan;
    if (!current || String(currentPlan?.clanGoal?.goalKey || '') !== previousGoalKey) {
        return { changed: parties.length > 0, releasedMembers };
    }
    const stats = { ...(current.stats || {}) };
    stats.equipmentPlan = { ...currentPlan };
    delete stats.equipmentPlan.clanGoal;
    if (String(stats.clanPartyObjective?.clanGoalKey || '') === previousGoalKey) delete stats.clanPartyObjective;
    delete stats.clanMaterialDemand;
    if (String(stats.partyRequest?.clanGoalKey || '') === previousGoalKey) delete stats.partyRequest;
    const saved = await LifeState.upsertState({ ...current, stats }, 'clan_equipment_beneficiary_rotated');
    return { changed: !!saved || parties.length > 0, releasedMembers };
}

async function releaseConflictingRosterParties(assignedMemberIds, goal, expectedObjective = null, options = {}) {
    const roster = new Set((assignedMemberIds || []).map(number).filter(Boolean));
    if (!roster.size) return { parties: 0, releasedMembers: 0 };
    const goalKey = String(goal?.goalKey || '');
    const parties = BackgroundPartyState.active().filter((party) => {
        if (startedRaidParty(party)) return false;
        if (options.partyIds && !options.partyIds.includes(party.partyId)) return false;
        const memberIds = (party.memberIds || []).map(number).filter(Boolean);
        if (!memberIds.some((id) => roster.has(id))) return false;
        const partyObjective = party?.stats?.objective || null;
        const partyGoalKey = String(partyObjective?.clanGoalKey || '');
        const sameRoute = !!expectedObjective && (
            String(party.spotId || '') === String(expectedObjective.spotId || '')
            && String(partyObjective?.objectiveKey || '') === String(expectedObjective.objectiveKey || '')
            && number(partyObjective?.npcId) === number(expectedObjective.npcId)
            && sameRosterRequirement(partyObjective, expectedObjective)
        );
        return partyGoalKey !== goalKey
            || !sameRoute
            || memberIds.some((id) => !roster.has(id));
    });
    let releasedMembers = 0;
    for (const party of parties) {
        const dissolved = await BackgroundPartyState.setStatus(party.partyId, 'dissolved');
        if (!dissolved) continue;
        releasedMembers += number(await LifeState.releaseDissolvedPartyMembers(
            party.partyId,
            'clan_equipment_party_reformed'
        ));
    }
    return { parties: parties.length, releasedMembers };
}

async function suspendWaitingAssignments(clan, goal, previousGoal) {
    const Policy = require('./ClanMembershipPolicy');
    const key = String(goal.goalKey);
    const priorKey = String(previousGoal?.goalKey || key);
    const ownedKeys = new Set([key, priorKey]);
    const oldParties = BackgroundPartyState.active().filter(party => !startedRaidParty(party)
        && number(party.stats?.objective?.clanId) === number(clan.id)
        && ownedKeys.has(String(party.stats?.objective?.clanGoalKey || '')));
    const ids = [...new Set([...(clan.members || []).map(memberId), ...(previousGoal?.assignedMemberIds || [])])].slice(0, 40);
    const reformed = await releaseConflictingRosterParties(ids, goal, null, { partyIds: oldParties.map(party => party.partyId) });
    const protectedKeys = Policy.activeRaidGoalKeys(BackgroundPartyState.admitted());
    let cleared = 0;
    // The character row owns membership; cached life JSON may still precede
    // an accepted join. Rehydrate only these bounded owner IDs before repair.
    for (const current of await LifeState.statesByIds(ids)) {
        if (number(current.clanId) !== number(clan.id)) continue;
        const stats = current.stats || {};
        const keys = new Set([stats.equipmentPlan?.clanGoal?.goalKey, stats.clanPartyObjective?.clanGoalKey,
            stats.partyRequest?.clanGoalKey].filter(value => value && !ownedKeys.has(String(value))));
        for (const value of protectedKeys) keys.add(value);
        const repaired = Policy.reconcileGoals(current, keys);
        if (repaired === current) continue;
        repaired.stats.clanGoalInvalidationVersion = Math.max(Date.now(), number(stats.clanGoalInvalidationVersion) + 1);
        // This committed goal owner is allowed to replace a locked clan plan;
        // a generic lifecycle save would preserve the superseded plan.
        if (await LifeState.upsertState(repaired, 'clan_equipment_goal')) cleared++;
    }
    return { ...reformed, cleared };
}

async function handoffWarehouseMaterials(current, plan, clan, goal) {
    const materials = (plan?.warehouseMaterials || [])
        .map((entry) => ({ selfId: number(entry.selfId), amount: Math.floor(number(entry.amount)) }))
        .filter((entry) => entry.selfId > 0 && entry.amount > 0);
    if (!materials.length) return { state: current, results: [] };

    let state = current;
    const results = [];
    for (const material of materials) {
        const result = await (LifeState.applyClanMaterialTransfer ? (request) => LifeState.applyClanMaterialTransfer(request, true) : Database.transferClanWarehouseToMember)({
            clanId: clan.id,
            characterId: current.characterId,
            selfId: material.selfId,
            amount: material.amount,
            goalKey: `${goal.goalKey}:warehouse:${material.selfId}:${number(state.simulation?.revision ?? state.simulationRevision)}`,
            ...(goal.orderId ? { clanOrder: { orderId: goal.orderId, settings: goal.orderSettings } } : {}),
            expectedSimulationRevision: number(state.simulation?.revision ?? state.simulationRevision)
        });
        results.push(result);
        if (!result.ok) {
            recordReason(result.code || 'warehouse_handoff_failed');
            continue;
        }
        invoke('GameServer/Bot/AI/BotClanChat').onWithdrawal(state, result);
        if (result.state) { state = result.state; continue; }
        state = {
            ...state,
            simulationRevision: number(result.simulationRevision, number(state.simulation?.revision ?? state.simulationRevision)),
            inventory: { ...(state.inventory || {}) }
        };
        state = await LifeState.refreshInventory(state, { equip: true });
        state = {
            ...state,
            simulationRevision: number(result.simulationRevision, number(state.simulation?.revision ?? state.simulationRevision))
        };
    }
    return { state, results };
}

// Where and at what price a plan buys. The reserve moves with the member's
// wallet and does not make a goal a different one.
function marketWithoutReserve(plan) {
    return plan?.market ? { ...plan.market, reserve: undefined } : plan?.market;
}

// A clan goal purchase that did not happen, with its reason counted.
function goalPurchaseFailed(code, result = {}) {
    recordReason(`clan_goal_${code}`);
    return { ...result, ok: false, code };
}

// The clan buys a market goal item for its beneficiary on the one purchase
// path of a cold bot (б5, ColdMarketService.acquire, as ClanMarketService
// buys): the clan credits the member the price above its free money, and the
// member buys in the seller's town, at once when it stands there, else on a
// clan errand it goes on and buys on arrival (a real NPC sells only to a bot in
// its town). A purchase that neither happens nor leaves returns the clan's part.
// Only a free cold member the main thread owns (not in a party, hunting or
// resting) and not already on its errand for this item; others wait for the
// next review.
async function buyGoalCopy(memberId, plan, clan, amount = 1) {
    let state = await LifeState.findByCharacterId(memberId);
    if (!state || state.phase !== 'cold' || state.partyId || state.party?.partyId
        || String(state.simulation?.ownerId || 'legacy_main') !== 'legacy_main'
        || !['hunting', 'resting'].includes(state.activity)) return { ok: false, code: 'member_busy' };
    const selfId = number(plan.target?.selfId);
    if (ClanCredit.hasClanErrand(state, clan.id, selfId)) {
        recordReason('clan_goal_market_buyer_traveling');
        return { ok: false, code: 'market_buyer_traveling', traveling: true };
    }
    // The offer the plan was priced on: the planner's own search over every
    // town (a hunting member's region is its hunting ground, not a town), at
    // no more than the planned price.
    const offer = GearAcquisitionPlanner.marketOfferForTarget(plan.target, state, { maxMarketPrice: number(plan.market?.price) });
    if (!offer) return goalPurchaseFailed('market_no_offer');
    const blocker = LifeState.marketPurchaseBlocker(state,
        { ...offer, buyerCharacterId: memberId, equipSlot: number(plan.target?.slot) || undefined }, amount);
    if (blocker) return goalPurchaseFailed(blocker);
    const price = Math.ceil(number(offer.price)) * amount;
    const funded = await ClanCredit.fund(clan.id, state, price, 'clan_goal_purchase');
    if (!funded.ok) return goalPurchaseFailed(funded.code, funded.paid);
    state = funded.state;
    const clanPart = funded.clanPart;
    const placed = { price: number(offer.price), sourceType: offer.sourceType, sourceId: offer.sourceId, town: offer.town };
    const purchase = await invoke('GameServer/Bot/Economy/ColdMarketService').acquire(state, selfId, amount, {
        towns: offer.town ? [offer.town] : null, maxPrice: number(offer.price), npc: offer.sourceType === 'npc',
        purpose: 'clan', money: price, free: true, clanPart, tag: { clanId: number(clan.id), offer: placed, clanPart }
    });
    // A kept errand (waiting for its party or town visit) carries the credit.
    const { code: settled } = await ClanCredit.settle(clan.id, memberId, clanPart, purchase, 'clan_goal_purchase_refund');
    if (settled.startsWith('bought')) {
        if (settled !== 'bought') recordReason(`clan_goal_${settled}`);
        return { ok: true, purchase };
    }
    if (settled === 'kept') {
        recordReason('clan_goal_market_buyer_traveling');
        return { ok: true, traveling: true, purchase };
    }
    const code = purchase.reason || 'clan_goal_purchase_failed';
    recordReason(code);
    if (settled !== 'refunded') recordReason(`clan_goal_${settled}`);
    return { ok: false, code };
}

// A goal combined from several copies of one item (the blades of a dual sword)
// is bought whole on one errand: the clan funded the whole combination, and a
// first blade worn in the weapon slot already reads as a fulfilled goal.
async function buyGoalItem(memberId, plan, clan) {
    const copies = ComponentProgress.componentRequirement(plan)?.amount || 1;
    if (copies === 1) return buyGoalCopy(memberId, plan, clan);
    const state = await LifeState.findByCharacterId(memberId);
    const owned = number(state?.inventory?.[String(plan.target?.selfId)]?.amount);
    return buyGoalCopy(memberId, plan, clan, Math.max(1, copies - owned));
}

async function assignPartyObjective(member, clan, goal, plan, priority = 'preferred') {
    const id = number(member.characterId ?? member.id);
    const objective = clanPartyObjective(plan, goal, priority, clan.id);
    await LifeState.init();
    let current = await LifeState.findByCharacterId(id);
    if (!current) return { ok: false, code: 'member_state_missing', memberId: id };
    const currentPartyId = current.partyId || current.party?.partyId || null;
    if (objective && currentPartyId) {
        const sameGoal = String(current.stats?.clanPartyObjective?.clanGoalKey || '') === String(goal?.goalKey || '');
        const party = BackgroundPartyState.find(currentPartyId);
        if (!sameGoal || startedRaidParty(party) || stateHasSameClanObjective(current, objective)) {
            return { ok: sameGoal, changed: false, memberId: id, code: sameGoal ? null : 'member_party_conflict' };
        }
        await releaseConflictingRosterParties(goal.assignedMemberIds || [id], goal, objective, { partyIds: [currentPartyId] });
        current = await LifeState.findByCharacterId(id);
        if (current.partyId || current.party?.partyId) return { ok: false, code: 'member_party_conflict', memberId: id };
    }
    if (!objective) {
        const old = current.stats?.clanPartyObjective;
        if (!old || number(old.clanId) !== number(clan.id)) return { ok: true, changed: false, memberId: id };
        const stats = { ...(current.stats || {}) };
        delete stats.clanPartyObjective;
        delete stats.clanMaterialDemand;
        if (stats.partyRequest?.clanGoalKey === old.clanGoalKey) delete stats.partyRequest;
        const saved = await LifeState.upsertState({ ...current, stats }, 'clan_equipment_party_clear');
        return { ok: !!saved, changed: !!saved, memberId: id };
    }
    if (stateHasSameClanObjective(current, objective)) return { ok: true, changed: false, memberId: id };
    const nextObjective = { ...objective, clanId: number(clan.id) };
    const partyRequest = nextObjective;
    const saved = await LifeState.upsertState({
        ...current,
        activity: current.phase === 'cold' && current.activity === 'hunting' ? 'party_wait' : current.activity,
        stats: {
            ...(current.stats || {}),
            clanId: number(clan.id),
            clanMaterialDemand: Object.fromEntries(Crafting.requirements(Crafting.resolveRecipe(plan?.recipeId), {}, null, 1, plan?.craftProviders, plan?.componentRecipes)),
            clanPartyObjective: nextObjective,
            partyRequest
        }
    }, 'clan_equipment_party_objective');
    if (!saved) return { ok: false, code: 'member_state_write_failed', memberId: id };
    DiagnosticConfig.developerDiagnostics && (metrics.partyAssignments += 1);
    return { ok: true, changed: true, memberId: id };
}

async function assignPlan(member, plan, clan, goal) {
    const id = number(member.characterId ?? member.id);
    if (!id) return { ok: false, code: 'member_missing' };
    await LifeState.init();
    const current = await LifeState.findByCharacterId(id);
    if (!current) return { ok: false, code: 'member_state_missing', memberId: id };

    const handoff = await handoffWarehouseMaterials(current, plan, clan, goal);
    const currentState = handoff.state || current;
    if (handoff.results.some(result => !result.ok)) return { ok: false, code: 'warehouse_handoff_deferred', handoff };
    plan = { ...plan, clanMaterialDemand: Object.fromEntries(Crafting.requirements(Crafting.resolveRecipe(plan.recipeId), {}, null, 1, plan.craftProviders, plan.componentRecipes)) };

    const currentPlan = currentState.stats?.equipmentPlan;
    if (currentPlan?.clanGoal?.clanId
        && number(currentPlan.clanGoal.clanId) !== number(clan.id)
        && !samePlanTarget(currentPlan, plan)) {
        return { ok: false, code: 'member_equipment_plan_conflict', memberId: id, handoff };
    }
    if (samePlanTarget(currentPlan, plan)
        && number(currentPlan.clanGoal?.clanId) === number(clan.id)
        && String(currentPlan.clanGoal?.goalKey || '') === String(goal.goalKey)
        && (!goal.fullRoster || stateHasSameClanObjective(currentState, clanPartyObjective(plan, goal, 'required', clan.id)))
        && samePlanRoute(currentPlan, plan)
        && ['status', 'strategy', 'recipeId', 'materials', 'craftProviders', 'componentRecipes', 'next'].every(key => (
            JSON.stringify(currentPlan[key]) === JSON.stringify(plan[key])
        ))
        && JSON.stringify(marketWithoutReserve(currentPlan)) === JSON.stringify(marketWithoutReserve(plan))) {
        const purchase = plan.strategy === 'market' ? await buyGoalItem(id, plan, clan) : null;
        return { ok: true, changed: false, memberId: id, handoff, purchase };
    }

    const nextState = {
        ...currentState,
        stats: {
            ...(currentState.stats || {}),
            clanId: number(clan.id),
            equipmentPlan: clanPlan(plan, clan, goal),
            clanMaterialDemand: plan.clanMaterialDemand,
            clanPartyObjective: clanPartyObjective(plan, goal, 'required', clan.id),
            // A stale personal request must not hide the new clan objective.
            partyRequest: clanPartyObjective(plan, goal, 'required', clan.id)
        }
    };
    const saved = await LifeState.upsertState(nextState, 'clan_equipment_goal');
    if (!saved) return { ok: false, code: 'member_state_write_failed', memberId: id, handoff };
    DiagnosticConfig.developerDiagnostics && (metrics.assignments += 1);
    const purchase = plan.strategy === 'market' ? await buyGoalItem(id, plan, clan) : null;
    return { ok: true, changed: true, memberId: id, handoff, purchase };
}

async function craftingOptions(clan) {
    const all = CraftShops.availableRecipes(CraftShops.STATION_CRAFTER);
    const published = CraftShops.publishedRecipeIndex();
    const providers = {};
    const crafters = (clan.members || []).filter(member => member.phase === 'cold'
        && !member.recruitmentReserved && !member.stats?.tradeMeeting && !member.stats?.playerPartyTakeover
        && (!member.partyId || Number(member.stats?.clanPartyObjective?.clanId) === Number(clan.id))
        && !['dead', 'respawning'].includes(member.activity)
        && CraftShops.isServiceCrafter(member));
    if (!crafters.length) return { craftRecipes: [...published.values()], allowedRecipeIds: [...published.keys()], craftProviders: providers };
    const rows = await Database.execute([`SELECT recipes.characterId, recipes.recipeId FROM character_recipes recipes
        JOIN characters members ON members.id = recipes.characterId WHERE members.clanId = ?`, [clan.id]], 'clan-craft:recipes');
    const knownByMember = new Map();
    for (const row of rows) {
        const id = Number(row.characterId);
        if (!knownByMember.has(id)) knownByMember.set(id, new Set());
        knownByMember.get(id).add(Number(row.recipeId));
    }
    for (const recipe of all) {
        const eligible = crafters.filter(member => CraftShops.canCraft(member, recipe));
        const crafter = eligible.find(member => knownByMember.get(memberId(member))?.has(Number(recipe.recipeId))) || eligible[0];
        if (!crafter) continue;
        const known = knownByMember.get(memberId(crafter))?.has(Number(recipe.recipeId)) || false;
        // Prefer a public service over teaching an unknown recipe unnecessarily.
        if (!known && published.has(Number(recipe.recipeId))) continue;
        providers[recipe.recipeId] = { characterId: memberId(crafter), known,
            recipeItemId: Number(recipe.recipeItemId), loc: crafter.loc || { locX: 83400, locY: 148600, locZ: -3400 } };
        published.set(Number(recipe.recipeId), recipe);
    }
    return { craftRecipes: [...published.values()], allowedRecipeIds: [...published.keys()], craftProviders: providers };
}

async function prepareRecruitment(clan, profiles, previousGoal, options) {
    const ownIds = clan.members.map(memberId).slice(0, 40);
    if (ownIds.length) {
        const reserved = await Database.execute([`SELECT characterId FROM clan_operation_members WHERE status='active'
            AND characterId IN (${ownIds.map(() => '?').join(',')}) UNION SELECT characterId FROM board_trade_participants
            WHERE meetingId IS NOT NULL AND characterId IN (${ownIds.map(() => '?').join(',')})`, [...ownIds, ...ownIds]]);
        const reservedIds = new Set(reserved.map(row => Number(row.characterId)));
        clan = { ...clan, members: clan.members.map(member => ({ ...member, recruitmentReserved: reservedIds.has(memberId(member)) })) };
    }
    const retained = new Set(previousGoal?.assignedMemberIds || []);
    profiles = profiles.filter(profile => clan.members.some(member => ClanRaidPolicy.availableMember(member, profile, retained)));
    const section = RosterDemand.ownerSection(clan, options.ownerSection);
    const key = RosterDemand.scanKey(clan, profiles, previousGoal, section);
    const previousScan = clan.state?.recruitmentScan;
    const restarted = (options.reviewCauses || []).includes('recruitment_input');
    const scan = !restarted && previousScan?.key === key ? { ...previousScan } : { key, refused: [] };
    const held = !restarted && clan.state?.recruitmentDemand && clan.state.recruitmentDemand.goalKey === previousGoal?.goalKey
        ? clan.state.recruitmentDemand.newMemberIds || [] : [];
    const retainedIds = [...new Set([...(scan.prospects || []), ...held])].filter(value => !(scan.refused || []).includes(value)).slice(0, 9);
    let prospects = [];
    if (retainedIds.length) {
        const eligible = await Database.execute([`SELECT characterId FROM bot_party_candidate_projection p
            WHERE characterId IN (${retainedIds.map(() => '?').join(',')}) AND joinAvailability=1 AND clanId=0
            AND NOT EXISTS(SELECT 1 FROM clan_operation_members r WHERE r.characterId=p.characterId AND r.status='active')
            AND NOT EXISTS(SELECT 1 FROM board_trade_participants t WHERE t.characterId=p.characterId AND t.meetingId IS NOT NULL)`, retainedIds]);
        prospects = await LifeState.statesByIds(eligible.map(row => row.characterId), { ownerId: 'legacy_main', unassigned: true });
    }
    let remaining = 64 - retainedIds.length;
    const prepare = pool => options.jobKey ? PlanningWorker.prepareRaids({ jobKey: options.jobKey, deadlineAt: options.planningDeadline, context: options.workerContext,
        clan, spots: profiles, prospects: pool, previousGoal, economicRequirements: scan.requirements }) : Promise.resolve({
            ...RosterDemand.prepare(clan, profiles, pool, previousGoal),
            economicProspects: RosterDemand.retainedEconomicProspects(pool, scan.requirements) });
    let prepared = await prepare(prospects);
    while (!prepared.raids.length && remaining > 0 && !scan.done && prepared.requests.length) {
        const request = prepared.requests.find(row => !(scan.exhausted || []).includes(row.kind));
        if (!request) { scan.done = true; break; }
        if (scan.kind !== request.kind) { scan.kind = request.kind; scan.cursor = null; }
        if (Date.now() >= options.planningDeadline) throw planningDeferred('clan planning deadline');
        const pageLimit = remaining;
        const page = await LifeState.clanOperationCandidates({ targetClanId: clan.id, unclanned: true,
            excludeTradeMeetings: true,
            classIds: require('./ClanCandidateCapabilities').classIdsForRequirements(request.kinds),
            minLevel: request.minLevel, maxLevel: request.maxLevel, cursor: scan.cursor, limit: remaining });
        remaining -= page.length;
        prospects = [...new Map([...prospects, ...page.filter(member => !(scan.refused || []).includes(memberId(member)))]
            .map(member => [memberId(member), member])).values()];
        scan.cursor = page.at(-1)?.candidateCursor || scan.cursor;
        if (page.length < pageLimit) scan.exhausted = [...new Set([...(scan.exhausted || []), request.kind])];
        prepared = await prepare(prospects);
        if (!page.length && (scan.exhausted || []).length >= prepared.requests.length) scan.done = true;
    }
    scan.prospects = [...new Set([...prepared.retainedProspects, ...(prepared.economicProspects || [])])].slice(0, 9);
    scan.ownerSection = section;
    scan.ownFingerprint = RosterDemand.ownFingerprint(clan);
    scan.goalKey = previousGoal?.goalKey || null;
    scan.sources = RosterDemand.hash(profiles.map(RosterDemand.sourceFingerprint));
    const watchRequests = prepared.requests;
    scan.classIds = require('./ClanCandidateCapabilities').classIdsForRequirements([...new Set(watchRequests.flatMap(row => row.kinds))]);
    scan.minLevel = watchRequests.length ? Math.min(...watchRequests.map(row => row.minLevel)) : 1;
    scan.maxLevel = watchRequests.length ? Math.max(...watchRequests.map(row => row.maxLevel)) : 100;
    return { ...prepared, scan, ownerSection: section, prospects, remaining, clan, profiles, previousGoal,
        continuation: !prepared.raids.length && !scan.done && prepared.requests.length > 0 };
}

async function prepareEconomic(recruitment, requirements, options) {
    const { scan } = recruitment;
    const requests = requirements.map(RosterDemand.economicRequest);
    const key = RosterDemand.hash(requirements);
    if (scan.economic?.key !== key) scan.economic = { key, exhausted: [] };
    const economic = scan.economic;
    // One logical native chain, one finite cursor; unrelated money/SP does not
    // restart it. The allowance is the remainder of this same admitted raid job.
    for (const request of requests) {
        if (economic.exhausted.includes(request.key)) continue;
        if (!(recruitment.remaining > 0)) break;
        if (economic.kind !== request.key) { economic.kind = request.key; economic.cursor = null; }
        if (Date.now() >= options.planningDeadline) throw planningDeferred('clan planning deadline');
        const limit = recruitment.remaining;
        const page = await LifeState.clanOperationCandidates({ targetClanId: recruitment.clan.id, unclanned: true,
            excludeTradeMeetings: true, classIds: request.classIds, minLevel: request.minLevel, maxLevel: request.maxLevel,
            cursor: economic.cursor, limit });
        recruitment.remaining -= page.length;
        recruitment.prospects = [...new Map([...recruitment.prospects,
            ...page.filter(member => !(scan.refused || []).includes(memberId(member)))].map(member => [memberId(member), member])).values()];
        economic.cursor = page.at(-1)?.candidateCursor || economic.cursor;
        if (page.length < limit) economic.exhausted.push(request.key);
    }
    const recipeIds = requirements.filter(row => row.kind === 'craft').map(row => row.recipeId);
    const ids = recruitment.prospects.map(memberId);
    const knowledge = ids.length && recipeIds.length ? await Database.execute([`SELECT characterId,recipeId FROM character_recipes
        WHERE characterId IN (${ids.map(() => '?').join(',')}) AND recipeId IN (${recipeIds.map(() => '?').join(',')})`, [...ids, ...recipeIds]]) : [];
    const partial = options.jobKey ? await PlanningWorker.prepareRaids({ jobKey: options.jobKey, deadlineAt: options.planningDeadline,
        clan: recruitment.clan, spots: recruitment.profiles, prospects: recruitment.prospects, previousGoal: recruitment.previousGoal,
        economicRequirements: requirements }) : { economicProspects: RosterDemand.retainedEconomicProspects(recruitment.prospects, requirements, scan.prospects) };
    scan.prospects = [...new Set([...scan.prospects, ...(partial.economicProspects || [])])].slice(0, 9);
    // Scalar watches only. Recipe knowledge changes use the same after-COMMIT
    // addressed review input as ability/class/availability changes.
    scan.classIds = [...new Set([...scan.classIds, ...requests.flatMap(row => row.classIds)])];
    scan.minLevel = Math.min(scan.minLevel, ...requests.map(row => row.minLevel));
    scan.maxLevel = Math.max(scan.maxLevel, ...requests.map(row => row.maxLevel));
    scan.requirements = requirements;
    recruitment.continuation ||= requests.some(row => !economic.exhausted.includes(row.key));
    return knowledge.map(row => [Number(row.characterId), Number(row.recipeId)]);
}

async function planningForClan(clan, previousGoal = null, options = {}) {
    const planningDeadline = number(options.planningDeadline) || Date.now() + Math.min(45000, Math.max(1000, Config.actionLeaseMs - 5000));
    if (PlanningWorker.enabled() && clan.state?.mode === 'autonomous' && !options.jobKey) {
        try { return await PlanningWorker.withJob(planningDeadline,
            jobKey => planningForClanAdmitted(clan, previousGoal, { ...options, jobKey, planningDeadline })); }
        catch (error) { throw planningDeferred(error.message); }
    }
    return planningForClanAdmitted(clan, previousGoal, { ...options, planningDeadline });
}

async function planningForClanAdmitted(clan, previousGoal = null, options = {}) {
    if (options.jobKey) options.workerContext = await PlanningWorker.context();
    // A planning pass compares the same clan snapshot against many raid bosses.
    // Readiness only depends on the member snapshot, so calculate it once per
    // member instead of rebuilding equipped-item projections for every boss.
    const raidReadinessCache = new Map();
    let candidateSpots = options.spots || (() => {
        try {
            const profiles = SpotProfiles.ensure();
            const liveRaidIds = invoke('GameServer/RaidBoss/RaidBossSourceCatalog').liveTemplateIds();
            return profiles.flatMap((profile) => {
                if (profile.raidBoss !== true) return [profile];
                if (!liveRaidIds.has(number(profile.raidBossTemplateId))) return [];
                if (clan.state?.mode === 'autonomous') return [require('../RaidBoss/RaidEncounterScope').projectSource(profile)];
                const assessment = ClanRaidPolicy.assessment(
                    clan,
                    profile,
                    previousGoal,
                    { readinessCache: raidReadinessCache }
                );
                if (!assessment.ready) return [];
                const raidRosterSize = assessment.eligible.length;
                return [{ ...profile, raidRosterSize, raidEstimate: assessment.raidEstimate }];
            });
        } catch (error) {
            recordReason('spot_index_unavailable');
            return [];
        }
    })();
    const blockedRaidSpots = ClanRaidFailurePolicy.blockedSpotIds(previousGoal);
    candidateSpots = candidateSpots.filter((profile) => !blockedRaidSpots.has(String(profile.id)));
    const recruitment = clan.state?.mode === 'autonomous' && !activeRaidPartyForClan(clan.id)
        ? await prepareRecruitment(clan, candidateSpots.filter(profile => profile.raidBoss), previousGoal, options) : null;
    const spots = recruitment ? [...candidateSpots.filter(profile => !profile.raidBoss), ...recruitment.raids] : candidateSpots;
    const occupancy = options.occupancy || (() => {
        try {
            return SpotProfiles.currentOccupancy(spots) || {};
        } catch (_) {
            return {};
        }
    })();
    const previousMember = (clan.members || []).find((member) => (
        number(member.characterId ?? member.id) === number(previousGoal?.target?.memberId)
    ));
    const previousFulfilled = previousMember
        ? Policy.targetFulfilled(
            previousMember,
            previousGoal,
            GearAcquisitionPlanner.equippedSlotsFor,
            (selfId) => ItemTemplateIndex.findFinite(DataCache.items, selfId) || null
        )
        : false;
    const warehouseRows = await Database.fetchClanWarehouseItems(clan.id);
    const craftOptions = await craftingOptions(recruitment?.clan || clan);
    const previousMemberId = number(previousGoal?.target?.memberId);
    const reservationOptions = reservationOptionsForClan(clan);
    // The clan pays what a member lacks for its goal from its free money (above
    // the clan hall's protected reserve).
    const clanShare = invoke('GameServer/ClanHall/Policy').freeAdena(warehouseRows, clan, clan.state?.mode, clan.state?.goal);
    const previousAssigned = new Set((previousGoal?.assignedMemberIds || []).map(number).filter(Boolean));
    const spoilCapable = (clan.members || []).some((member) => (
        member?.phase === 'cold'
        && (!member?.partyId || previousAssigned.has(memberId(member)))
        && String(member?.simulationOwner || 'legacy_main') === 'legacy_main'
        && (ClanPolicy.rosterRole(member) === 'spoiler' || RosterDemand.ownedSpoilCapability(clan, member))
    ));
    const members = planningMemberOrder(
        clan.members || [],
        previousMemberId,
        previousFulfilled
    );
    const planningWindow = Math.max(1, number(Config.operationMinMembers, 5));
    const plans = new Map();
    const workerFingerprint = PlanningWorker.enabled() ? planningFingerprint(clan) : null;
    // Unrelated clan members continue earning loot while the worker calculates.
    // Validate their roster/equipment, but fence consumable inventory and adena
    // only for the beneficiary selected for application, avoiding retry starvation.
    const beneficiaryFingerprints = workerFingerprint
        ? Object.fromEntries(members.map((member) => [memberId(member), beneficiaryFingerprint(member)]))
        : null;
    let workerContext;
    let economicAttempted = false;
    const planningDeadline = number(options.planningDeadline)
        || Date.now() + Math.min(45000, Math.max(1000, Config.actionLeaseMs - 5000));
    if (workerFingerprint && members.length) {
        try { workerContext = options.workerContext || await PlanningWorker.context(); }
        catch (error) { throw planningDeferred(error.message); }
    }
    for (let index = 0; index < members.length; index++) {
        if (workerFingerprint && Date.now() >= planningDeadline) throw planningDeferred('clan planning deadline');
        const member = members[index];
        const id = number(member.characterId ?? member.id);
        const capacityUnits = equipmentRoster(clan, member, previousGoal).length;
        const memberSpots = spots.filter((spot) => spot.raidBoss !== true
            || (!recruitment || recruitment.teams[spot.id]?.memberIds.includes(id)) && ClanRaidPolicy.availableMember(member, spot,
                new Set((previousGoal?.assignedMemberIds || []).map(number).filter(Boolean))));
        const memberOptions = {
            ...craftOptions,
            economicCraftAllowed: require('../Bot/Economy/ProductionPolicy').buyersDisabled() === false,
            ignoreExistingPlan: previousFulfilled && id === previousMemberId,
            occupancy,
            capacityUnits,
            spoilCapable,
            allowRaidSources: memberSpots.some((spot) => spot.raidBoss === true),
            maxExpectedKills: Config.equipmentMaxExpectedKills,
            clanShare,
            ...reservationOptions,
            excludedTargetIds: options.excludedTargetIds || []
        };
        const nativePlan = async extra => {
            const requestOptions = { ...memberOptions, ...extra };
            if (workerFingerprint) return PlanningWorker.plan({ member, spots: memberSpots, warehouseRows, options: requestOptions,
                context: workerContext, deadlineAt: planningDeadline, jobKey: options.jobKey });
            return requestOptions.economicMode ? RosterDemand.economicPlan(planForMember, {
                clan: recruitment.clan, prospects: recruitment.prospects, prepared: recruitment }, member, memberSpots, warehouseRows, requestOptions)
                : planForMember(member, memberSpots, warehouseRows, requestOptions);
        };
        let plan;
        if (workerFingerprint) {
            try {
                plan = await nativePlan();
                if (Date.now() >= planningDeadline) throw planningDeferred('clan planning deadline');
            } catch (error) {
                recordReason('clan_planning_worker_unavailable');
                throw planningDeferred(error.message);
            }
        } else {
            // Synchronous harnesses use the identical pure planner. Runtime enables
            // the worker at startup and never falls back here after a worker failure.
            plan = await nativePlan();
        }
        const economicEnabled = recruitment && !economicAttempted
            && require('./ClanRules').memberLimit(clan.level) > Number(clan.physicalMemberCount ?? clan.members.length);
        if (economicEnabled) {
            const discovered = await nativePlan({ economicMode: 'discovery' });
            const requirements = discovered.economicRequirements;
            if (requirements?.length) {
                economicAttempted = true;
                const recipeKnowledge = await prepareEconomic(recruitment, requirements, options);
                plan = await nativePlan({ economicMode: 'conditional', economicRequirements: requirements, recipeKnowledge });
                if (plan.economicTeam) {
                    recruitment.scan.prospects = [...new Set([...plan.economicTeam.retainedProspects, ...recruitment.scan.prospects])].slice(0, 9);
                    recruitment.continuation = false;
                }
            }
        }
        plans.set(id, plan);
        // Equipment planning is CPU-only and may inspect several nearby item
        // batches. Keep one clan action from monopolizing the game loop while
        // still completing the same bounded roster projection.
        if ((index + 1) % 2 === 0 && index + 1 < members.length) {
            await new Promise((resolve) => setImmediate(resolve));
        }
        const windowComplete = (index + 1) % planningWindow === 0 || index + 1 === members.length;
        if (windowComplete && [...plans.values()].some(Policy.isAcquisitionPlan)) break;
    }
    let selection = Policy.selectTargetMember(clan.members, plans, previousGoal, {
        previousFulfilled,
        roleFor: ClanPolicy.rosterRole
    });
    const economy = require('./ClanEconomyContext').forClan(clan, { warehouse: warehouseRows,
        halls: await Database.fetchClanHallAuctions(),
        equipment: [...plans].filter(([, plan]) => Policy.isAcquisitionPlan(plan))
            .map(([memberId, plan]) => ({ memberId, plan })) });
    const moneyWish = economy.network.queue.find(wish => wish.object.kind === 'equipment' && wish.funded);
    const freeWish = economy.network.plans.get(economy.network.focus?.[0]);
    const desired = moneyWish || (freeWish?.price === 0 && economy.focusObject?.kind === 'equipment'
        ? { object: economy.focusObject, valueHours: 0 } : null);
    if (desired) {
        const member = members.find(row => memberId(row) === desired.object.memberId);
        const plan = plans.get(desired.object.memberId);
        if (member && plan) selection = { member, plan, priority: desired.valueHours, selectedBy: 'clan_wish_network' };
    } else if (selection?.plan?.strategy === 'market' && economy.network.queue.some(wish => wish.object.kind === 'equipment')) {
        selection = null;
    }
    return {
        spots,
        occupancy,
        warehouseRows,
        plans,
        economy,
        selection,
        previousFulfilled,
        workerFingerprint,
        beneficiaryFingerprints,
        planningDeadline,
        recruitment
    };
}

async function recordRaidFailure(party, timestamp = Date.now()) {
    const objective = party?.stats?.objective;
    const encounter = party?.stats?.raidEncounter;
    const clanId = number(objective?.clanId);
    const goalKey = String(objective?.clanGoalKey || '');
    if (!clanId || !goalKey || encounter?.status !== 'failed') {
        return { ok: false, skipped: true, code: 'raid_failure_context_missing' };
    }

    for (let attempt = 0; attempt < 2; attempt++) {
        const clan = await invoke('GameServer/Clan/ClanGoalService').clanProjectionById(clanId);
        // A raid may belong to the production goal a young clan runs beside
        // its main goal; the failure is recorded on the goal that owns it.
        const ownerSection = ['goal', 'productionGoal'].find(section => (
            String(clan?.state?.[section]?.goalKey || '') === goalKey));
        const current = ownerSection ? clan.state[ownerSection] : null;
        if (!current) {
            return { ok: true, skipped: true, code: 'raid_goal_changed' };
        }
        if (String(current.controlledBy || '') === 'player') {
            return { ok: true, skipped: true, code: 'player_order_controls_replan' };
        }
        if (String(current.raidFailure?.partyId || '') === String(party.partyId)
            && number(current.raidFailure?.failedAt) === number(encounter.failedAt, timestamp)) {
            return { ok: true, skipped: true, code: 'raid_failure_already_recorded', goal: current };
        }

        const failure = ClanRaidFailurePolicy.decision(current.raidFailure, encounter);
        const next = {
            ...current,
            raidFailure: {
                ...failure,
                failedAt: number(encounter.failedAt, timestamp),
                partyId: party.partyId,
                failureReason: String(encounter.failureReason || 'party_death')
            },
            partyId: null,
            catastrophicFailures: number(current.catastrophicFailures) + 1,
            status: 'executing',
            reasonCodes: [...new Set([...(current.reasonCodes || []), failure.reasonCode])],
            updatedAt: timestamp
        };
        const saved = await Database.updateAutonomousClanGoal({
            clanId,
            goal: next,
            ownerSection,
            expectedUpdatedAt: number(clan.state?.updatedAt) || null,
            eventType: 'equipment_raid_failed',
            reasonCode: failure.reasonCode
        });
        if (saved.ok) {
            await Database.enqueueClanAction({
                clanId,
                actionKey: `clan:${clanId}:raid-failed:${failure.bossTemplateId}:${number(encounter.failedAt, timestamp)}`,
                // Below level 3 the production action plans the production
                // goal; from level 3 the main planner adopts it as previous.
                actionType: ownerSection === 'productionGoal' && number(clan.level) < 3 ? 'production' : 'goal_plan',
                priority: 90,
                availableAt: timestamp,
                payload: {
                    reason: 'equipment_raid_failed',
                    goalKey,
                    bossTemplateId: failure.bossTemplateId,
                    retryAllowed: failure.retryAllowed
                }
            });
            recordReason(failure.reasonCode);
            return { ...saved, failure };
        }
        if (saved.code !== 'ownership_conflict') return { ...saved, failure };
    }
    return { ok: false, code: 'ownership_conflict' };
}

function selectedPlanningTarget(clan, previousGoal, planning, selectedCandidate = null, candidateIds = []) {
    const memberIdValue = number(selectedCandidate?.memberId);
    const itemId = number(selectedCandidate?.itemId);
    const slot = number(selectedCandidate?.slot);
    if (!memberIdValue || (planning.economy && !candidateIds.includes(selectedCandidate?.id))) return planning.selection;
    const member = (clan.members || []).find((entry) => memberId(entry) === memberIdValue);
    const plan = planning.plans.get(memberIdValue);
    if (!member || !Policy.isAcquisitionPlan(plan)) return planning.selection;
    if (itemId && number(plan.target?.selfId) !== itemId) return planning.selection;
    if (slot && number(plan.target?.slot) !== slot) return planning.selection;
    return {
        member,
        plan,
        priority: Policy.equipmentPriority(member, plan, { roleFor: ClanPolicy.rosterRole }),
        selectedBy: 'clan_brain',
        previousMemberId: number(previousGoal?.target?.memberId) || null
    };
}

async function resolveClan(clan, previousGoal = null, options = {}) {
    DiagnosticConfig.developerDiagnostics && (metrics.resolves += 1);
    if (!clan || !number(clan.id)) {
        return { ok: true, skipped: true, reason: 'equipment_level_unavailable' };
    }
    const activeRaidParty = activeRaidPartyForClan(clan.id);
    if (activeRaidParty) {
        recordReason('raid_in_progress');
        return {
            ok: true,
            skipped: true,
            reason: 'raid_in_progress',
            goal: previousGoal,
            partyId: activeRaidParty.partyId
        };
    }
    const planning = options.planning || await planningForClan(clan, previousGoal, options);
    const { plans, previousFulfilled } = planning;
    const selection = selectedPlanningTarget(clan, previousGoal, planning, options.selectedCandidate, options.candidateIds);
    await validatePlanning(clan, planning, selection);
    const raidPartyAfterPlanning = activeRaidPartyForClan(clan.id);
    if (raidPartyAfterPlanning) {
        recordReason('raid_in_progress');
        return {
            ok: true,
            skipped: true,
            reason: 'raid_in_progress',
            goal: previousGoal,
            partyId: raidPartyAfterPlanning.partyId
        };
    }
    if (!selection) {
        DiagnosticConfig.developerDiagnostics && (metrics.noDebt += 1);
        recordReason('no_equipment_debt');
        // The beneficiary has its item and no member needs anything next: the
        // goal is closed, not left executing until the next debt appears.
        if (previousFulfilled && previousGoal && previousGoal.status !== 'completed') {
            return {
                ok: true,
                skipped: true,
                completed: true,
                reason: 'no_equipment_debt',
                plans,
                previousFulfilled,
                goal: { ...previousGoal, status: 'completed', updatedAt: Date.now() },
                expectedUpdatedAt: number(clan.state?.updatedAt) || null,
                ownerSection: planning.recruitment?.ownerSection, recruitmentDemand: null, recruitmentScan: null
            };
        }
        return { ok: true, skipped: true, reason: 'no_equipment_debt', plans,
            recruitmentScan: planning.recruitment?.scan || null, recruitmentDemand: null,
            ownerSection: planning.recruitment?.ownerSection, continuation: !!planning.recruitment?.continuation };
    }
    if (planning.workerFingerprint && selection.plan?.strategy === 'market') {
        const currentOffer = invoke('GameServer/Bot/Economy/MarketOpportunity').bestOffer(selection.plan.target.selfId, {
            town: selection.plan.market?.town,
            buyerCharacterId: memberId(selection.member)
        });
        if (!currentOffer || Number(currentOffer.price) !== Number(selection.plan.market?.price)
            || currentOffer.sourceType !== selection.plan.market?.sourceType) {
            throw planningDeferred('clan planning market offer changed');
        }
    }

    const team = selection.plan?.economicTeam || planning.recruitment?.teams?.[selection.plan?.next?.spotId];
    const section = RosterDemand.ownerSection(clan, options.ownerSection);
    // A main-section save of a goal adopted from the production section
    // replaces that copy (ClanGoalService passes the production goal itself).
    const supersededProductionGoalKey = section === 'goal' && previousGoal && previousGoal === clan.state?.productionGoal
        ? previousGoal.goalKey : null;
    const scan = planning.recruitment?.scan || null;
    if (team && !team.actualReady) {
        const goal = Policy.buildGoal(clan, selection, previousGoal, Date.now(), { assignedMemberIds: [], roleFor: ClanPolicy.rosterRole });
        goal.assignedMemberIds = [];
        goal.status = 'preparing';
        goal.reasonCodes = ['clan_recruitment_wait'];
        if (team.economic) goal.plan.economicRequirements = team.requirements;
        if (scan) { scan.key = RosterDemand.scanKeyForSources(clan, scan.sources, goal, section, scan.ownFingerprint); scan.goalKey = goal.goalKey; }
        const demand = RosterDemand.buildDemand(clan, goal, team, section);
        const saved = await Database.updateAutonomousClanGoal({ clanId: clan.id, goal, ownerSection: section,
            expectedUpdatedAt: number(clan.state?.updatedAt), recruitmentDemand: demand, recruitmentScan: scan, supersededProductionGoalKey,
            rosterProof: { ...demand.proof, source: team.source, ownerSection: section,
                ownerGoal: RosterDemand.goalFingerprint(clan.state?.[section]) }, eventType: 'equipment_recruitment_wait', reasonCode: 'clan_recruitment_wait' });
        if (!saved.ok) return saved;
        const suspension = await suspendWaitingAssignments(clan, goal, previousGoal);
        const joined = await invoke('GameServer/Clan/ClanSimulationService').recruitForDemand({ ...clan, state: saved.state }, demand);
        const [row] = await Database.execute(['SELECT stateJson FROM clan_simulation_clans WHERE clanId=?', [clan.id]]);
        const latest = parseJson(row.stateJson);
        if (scan && joined.refused.length && latest.recruitmentDemand?.generation === demand.generation) {
            scan.refused = [...new Set([...(scan.refused || []), ...joined.refused])].slice(-9);
            scan.prospects = (scan.prospects || []).filter(value => !scan.refused.includes(value));
            await Database.updateAutonomousClanGoal({ clanId: clan.id, goal: latest[section], ownerSection: section,
                expectedUpdatedAt: number(latest.updatedAt), recruitmentDemand: latest.recruitmentDemand, recruitmentScan: scan,
                eventType: null });
        }
        return { ok: true, goal: latest[section] || goal, persistedGoal: true, ownerSection: section, joined,
            recruitmentDemand: demand, recruitmentScan: scan, suspension, retryable: true, reason: 'clan_planning_deferred', selection, plans };
    }
    const assignedMemberIds = team?.actualReady ? team.memberIds : equipmentRoster(clan, selection.member, previousGoal, selection.plan);
    const selectedSpot = selection.plan?.next?.spotId
        ? planning.spots.find((spot) => String(spot.id) === String(selection.plan.next.spotId))
        : null;
    const capacityReservation = reserveGoalCapacity(planning, clan, assignedMemberIds, selectedSpot);
    if (!capacityReservation.reserved) {
        recordReason('equipment_source_capacity_changed');
        const retryCount = Math.max(0, number(options.capacityRetry));
        // This is a rare post-planning race, not the normal clan planning
        // path. Walk a few more nearby equipment targets before yielding the
        // action; the ordinary cold flow still performs only one planning pass.
        if (retryCount < MAX_CAPACITY_TARGET_RETRIES) {
            const excludedTargetIds = [...new Set([
                ...(options.excludedTargetIds || []).map(number).filter(Boolean),
                number(selection.plan?.target?.selfId)
            ].filter(Boolean))];
            const retryPlanning = await planningForClan(clan, previousGoal, {
                ...options,
                spots: planning.spots,
                occupancy: capacityReservation.occupancy,
                planningDeadline: planning.planningDeadline,
                excludedTargetIds
            });
            return resolveClan(clan, previousGoal, {
                ...options,
                planning: retryPlanning,
                selectedCandidate: null,
                excludedTargetIds,
                capacityRetry: retryCount + 1
            });
        }
        return { ok: true, skipped: true, reason: 'equipment_sources_exhausted', plans };
    }
    const goal = Policy.buildGoal(clan, selection, previousGoal, Date.now(), {
        assignedMemberIds,
        roleFor: ClanPolicy.rosterRole
    });
    if (selection.plan.economicOwnedRequirements) goal.plan.economicRequirements = selection.plan.economicOwnedRequirements;
    else if (previousGoal?.plan?.economicRequirements && goal.goalKey === previousGoal.goalKey)
        goal.plan.economicRequirements = previousGoal.plan.economicRequirements;
    if (scan) { scan.key = RosterDemand.scanKeyForSources(clan, scan.sources, goal, section, scan.ownFingerprint); scan.goalKey = goal.goalKey; }
    let persistedGoal = false;
    if (team?.actualReady) {
        goal.fullRoster = RosterDemand.fullRoster(clan, goal, team, section);
        const saved = await Database.updateAutonomousClanGoal({ clanId: clan.id, goal, ownerSection: section,
            expectedUpdatedAt: number(clan.state?.updatedAt), recruitmentDemand: null, recruitmentScan: null, supersededProductionGoalKey,
            rosterProof: { ownFingerprint: team.ownFingerprint, rows: team.rows, source: team.source,
                ownerSection: section, ownerGoal: RosterDemand.goalFingerprint(clan.state?.[section]) },
            eventType: 'equipment_full_roster_ready', reasonCode: 'clan_full_roster_ready' });
        if (!saved.ok) return saved;
        persistedGoal = true;
    }
    const rotation = await releasePreviousBeneficiary(clan, previousGoal, goal);
    const expectedObjective = clanPartyObjective(selection.plan, goal, 'required', clan.id);
    const craftReady = ['ready_to_craft', 'component_ready'].includes(selection.plan?.status);
    const craftMembers = craftReady ? Object.values(selection.plan.craftProviders || {}).map(provider => number(provider.characterId)) : [];
    const partyReform = await releaseConflictingRosterParties([...new Set([...assignedMemberIds, ...craftMembers])], goal, expectedObjective);
    const assignment = await assignPlan(selection.member, selection.plan, clan, goal);
    if (!assignment.ok) {
        DiagnosticConfig.developerDiagnostics && (metrics.assignmentFailures += 1);
        recordReason(assignment.code);
        return { ...assignment, goal, plans, selection };
    }
    const roster = new Set(assignedMemberIds);
    const partyAssignments = await (clan.members || [])
        .filter((member) => member?.phase === 'cold')
        .reduce((chain, member) => chain.then(async (results) => {
            const result = roster.has(memberId(member))
                ? await assignPartyObjective(member, clan, goal, selection.plan, 'required')
                : await assignPartyObjective(member, clan, goal, null);
            if (!result.ok) recordReason(result.code);
            results.push(result);
            return results;
        }), Promise.resolve([]));
    const [latestStateRow] = await Database.execute([
        'SELECT stateJson FROM clan_simulation_clans WHERE clanId = ?',
        [number(clan.id)]
    ]);
    const latestState = parseJson(latestStateRow?.stateJson, clan.state || {});
    DiagnosticConfig.developerDiagnostics && (metrics.plans += 1);
    recordReason(goal.plan.reasonCode);
    return {
        ok: true,
        goal,
        plans,
        selection,
        assignment,
        rotation,
        partyReform,
        partyAssignments,
        previousFulfilled,
        expectedUpdatedAt: number(latestState.updatedAt) || null,
        persistedGoal,
        ownerSection: section,
        recruitmentDemand: null,
        recruitmentScan: team?.actualReady ? null : scan,
        continuation: !!planning.recruitment?.continuation
    };
}

const ClanEquipmentService = {
    assignPlan,
    selectedPlanningTarget,
    resolveClan,
    planningForClan,
    craftingOptions,
    planForMember,
    planningFingerprint,
    validatePlanning,
    equipmentRoster,
    activeRaidPartyForClan,
    recordRaidFailure,
    reserveGoalCapacity,
    releaseConflictingRosterParties,
    metrics() {
        if (!DiagnosticConfig.developerDiagnostics) return { enabled: false };
        return {
            resolves: metrics.resolves,
            plans: metrics.plans,
            assignments: metrics.assignments,
            partyAssignments: metrics.partyAssignments,
            assignmentFailures: metrics.assignmentFailures,
            noDebt: metrics.noDebt,
            worker: PlanningWorker.metrics(),
            reasonCounts: Object.fromEntries(metrics.reasonCounts.entries())
        };
    },
    resetMetrics() {
        Object.keys(metrics).forEach((key) => {
            if (metrics[key] instanceof Map) metrics[key].clear();
            else metrics[key] = 0;
        });
    }
};

module.exports = ClanEquipmentService;
