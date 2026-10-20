const SurvivalFloor = require('./SurvivalFloor');
const BotErrands = require('./BotErrands');
// The bag's need to go sell, one rule for the clan break, the solo forced
// cleanup and the cold worker's step: the native slot/weight floor first
// (its bag part only), else the author's cleanup thresholds. { reason, slots, limit } or null.
function cleanupNeed(member, now) {
    const floor = SurvivalFloor.bagFor(member, now);
    if (floor?.action === 'unload') {
        return { ...floor, reason: floor.reason === 'no_slot' ? 'inventory_capacity' : 'inventory_overweight' };
    }
    // lazy: worker ItemDisposition's own links are not loaded with the worker kernel.
    return invoke('GameServer/Bot/Economy/ItemDisposition').inventoryCleanupNeed(member, { now });
}
const CLEANUP_BUSY_FLAGS = ['marketReturn'];
const CLEANUP_BUSY_ACTIVITIES = ['traveling', 'shopping', 'merchant', 'crafting', 'dead', 'pk_hunting'];
// A solo cold bot with no trip or errand under way goes to sell when its bag
// needs it: the worker attaches this need to the step's proposal, main starts the trip.
function forcedCleanupNeed(state, now) {
    if (!state || state.phase !== 'cold' || state.party?.partyId || state.partyId
        || state.stats?.travel || BotErrands.busyWith(state, CLEANUP_BUSY_FLAGS)
        || CLEANUP_BUSY_ACTIVITIES.includes(state.activity)) return null;
    return cleanupNeed(state, now);
}
// A forced cleanup decided over a resolve outranks a trip that resolve
// started (route, karma), as it did when it was decided before the fight;
// the fight's outcome is kept.
function withoutStartedTrip(before, resolved) {
    if (before.activity === 'traveling' || resolved.activity !== 'traveling') return resolved;
    return { ...resolved, activity: before.activity, stats: { ...(resolved.stats || {}), travel: null } };
}
const cleanupGoal = (need) => invoke('GameServer/Bot/Goals/NeedsEvaluator').cleanupGoal(need);

const RESERVATION_MS = 15 * 60 * 1000;
function clanDuty(party) {
    const objective = party?.stats?.objective;
    return objective?.priority === 'required' && !!objective.clanGoalKey;
}
function pending(party, now = Date.now()) {
    return Object.values(party?.stats?.marketAbsences || {}).filter(value => Number(value.until) > now);
}
function sessionReady(party, member, goal, now, config) {
    // The hour engine has already selected this quote over earning/farming.
    // An ordinary party's minimum session must not postpone a payable kit.
    if (!clanDuty(party) && party?.stats?.objective?.sourceKind !== 'raid'
        && goal?.type === 'upgrade_gear' && goal.plan?.sourceType === 'npc') {
        const cost = Number(goal.plan.estimatedCost), Funding = require('../Economy/PurchaseFunding');
        if (cost > 0 && Funding.spendable(member, 0, Funding.goalTerms(goal)) >= cost) {
            const Progression = invoke('GameServer/Bot/AI/PersonalGearProgression');
            const assessment = Progression.assess(member);
            const item = invoke('GameServer/Item/ItemTemplateIndex').find(invoke('GameServer/DataCache').items, goal.target?.itemId);
            const slot = Number(String(goal.plan.wishKey || '').match(/^power:\d+:(\d+)$/)?.[1] || goal.target?.itemSlot);
            if (item && assessment.required && Progression.priority(item, slot, assessment)) return true;
        }
    }
    return now - Number(party.stats?.formedAt || party.startedAt || now) >= config.partyMarketBreakMinSessionMs
        && Number(party.stats?.fightsResolved || 0) >= config.partyMarketBreakMinFights
        && now - Number(party.stats?.lastMarketBreakAt || 0) >= config.partyMarketBreakCooldownMs;
}
// The bag need a clan-duty break reads; null outside a clan duty. A caller
// that already has it passes it on (`need`) so the bag is walked once.
function memberNeed(party, member, now = Date.now()) {
    return clanDuty(party) ? cleanupNeed(member, now) : null;
}
function shotRestock(party, current) {
    const objective = party?.stats?.objective;
    return objective?.sourceKind !== 'raid' && !objective?.raidBoss
        && current?.type === 'buy_craft_material' && current.plan?.wishKey === 'stock:shots'
        && Number(current.target?.amount) > 0
        && invoke('GameServer/Inventory/ShotStock').SHOT_IDS.includes(Number(current.target?.itemId));
}
function allowed(party, member, now = Date.now(), need = undefined, current = null) {
    if (!clanDuty(party)) return true;
    if (pending(party, now).length) return false;
    return ['inventory_capacity', 'inventory_overweight'].includes((need === undefined ? cleanupNeed(member, now) : need)?.reason)
        || shotRestock(party, current);
}
// A clan duty retains its member while unloading or refilling the selected
// shot stock. The native purchase/travel gate still checks its quote and cash.
function goal(party, member, current, now, need = undefined) {
    if (!clanDuty(party)) return current;
    const bag = need === undefined ? cleanupNeed(member, now) : need;
    if (['inventory_capacity', 'inventory_overweight'].includes(bag?.reason)) return { ...cleanupGoal(bag), status: 'active' };
    return shotRestock(party, current) ? current : null;
}
function departure(party, member, travel, now, given = undefined) {
    if (!clanDuty(party)) return travel;
    const need = given === undefined ? cleanupNeed(member, now) : given;
    const token = { partyId: party.partyId, characterId: member.characterId, until: now + RESERVATION_MS,
        objective: { ...party.stats.objective }, startedAt: now, cleanupReason: need?.reason || 'restock_shots',
        slots: need?.slots, limit: need?.limit };
    return { ...travel, stats: { ...travel.stats, partyMarketReturn: token,
        lastPartyMarketBreak: token, clanPartyObjective: token.objective } };
}
function stats(party, departed) {
    const token = departed?.stats?.partyMarketReturn;
    return token ? { marketAbsences: { ...party.stats?.marketAbsences, [departed.characterId]: token } } : {};
}
function ready(state) {
    return !!state?.stats?.partyMarketReturn && !state.party?.partyId && !state.partyId
        && !state.stats?.travel && !state.stats?.marketReturn
        && ['hunting', 'party_wait', 'grouped'].includes(state.activity);
}
module.exports = { cleanupNeed, forcedCleanupNeed, withoutStartedTrip, clanDuty, pending, sessionReady, memberNeed,
    allowed, goal, departure, stats, ready };
