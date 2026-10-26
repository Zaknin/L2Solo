const Material = require('./CraftMaterialParty');
function activePlanTarget(plan) {
    return plan?.status === 'active' ? Number(plan.next?.npcId || plan.targetNpcId || 0) : 0;
}

// A member's state on the main thread: BotLifeState's cache. The cold worker
// passes its own records as stateOf.
function cachedState(id) {
    // lazy: worker BotLifeState is the main thread's cache; worker callers pass stateOf.
    return invoke('GameServer/Bot/Population/BotLifeState').cachedState(id);
}
// The shared objective wins; an ordinary hunting party follows its leader's
// active plan. A randomly selected encounter representative cannot retarget it.
function npcId(party, leader, stateOf = cachedState) {
    if (Material.isObjective(party?.stats?.objective)) {
        const members = (party.memberIds || []).slice(0, Material.MAX_MEMBERS)
            .map(id => Number(id) === Number(leader?.characterId) ? leader : stateOf(id)).filter(Boolean);
        return Material.target(party, members);
    }
    // A help party agreed to level on its shared spot. The leader's old
    // equipment target may not even spawn there.
    if (party?.stats?.objective?.reason === 'clan_help') {
        return Number(party.stats.objective.npcId || 0);
    }
    return Number(party?.stats?.objective?.npcId || 0)
        || activePlanTarget(party?.stats?.acquisitionGoal)
        || activePlanTarget(leader?.stats?.equipmentPlan);
}
// A cheap representative of ordinary hunting, weighted by the actual spawn
// population. Stable per hunting unit so teammates never invent separate goals.
// This is competition context only; it does not replace the PvE gear target.
// Lazy: loaded on first use (load order), then kept; a require per call was ~1% of the cold worker (perf-map 2026-10-14).
let scorer = null;
function competitionNpcId(party, leader, spot, stateOf = cachedState) {
    const planned = npcId(party, leader, stateOf);
    if (planned) return planned;
    if (!leader) return 0;
    if (!spot) spot = invoke('GameServer/Bot/Population/SpotProfiles').findById(party?.spotId || leader.spotId);
    if (!spot) return 0;
    const level = Number(leader.level || 1);
    const { MIN_LEVEL_GAP, MAX_LEVEL_ADVANTAGE } = scorer ||= require('../AI/BotTargetScorer');
    const entries = (spot.npcEntries || []).filter(e => Number(e.selfId) > 0
        && Number(e.level ?? spot.avgLevel ?? level) >= level + MIN_LEVEL_GAP
        && Number(e.level ?? spot.avgLevel ?? level) <= level + MAX_LEVEL_ADVANTAGE)
        .slice().sort((a, b) => Number(a.selfId) - Number(b.selfId));
    if (!entries.length) return 0;
    let hash = 2166136261;
    for (const c of `${party?.partyId || leader.characterId}:${spot.id}`) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
    const weight = e => Math.max(1, Number(e.count) || 1);
    let roll = (hash >>> 0) / 4294967296 * entries.reduce((sum, e) => sum + weight(e), 0);
    return Number((entries.find(e => (roll -= weight(e)) < 0) || entries.at(-1)).selfId);
}
module.exports = { npcId, competitionNpcId };
