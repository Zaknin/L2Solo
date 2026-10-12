'use strict';
const { createHash } = require('node:crypto');
const Raid = require('./ClanRaidPolicy');
const Capabilities = require('./ClanCandidateCapabilities');
const Rules = require('./ClanRules');
const id = member => Number(member?.characterId ?? member?.id);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

function memberFingerprint(member = {}) {
    const combat = member.stats?.coldCombat || {};
    const objective = member.stats?.clanPartyObjective;
    return hash([id(member), Number(member.classId ?? member.stats?.classId ?? 0), Number(member.level), Number(member.clanId ?? member.stats?.clanId ?? 0),
        member.phase, member.simulationOwner || member.simulation?.ownerId || 'legacy_main', member.partyId || member.party?.partyId || null,
        member.activity, member.spotId, !!(member.recruitmentReserved || member.stats?.tradeMeeting),
        !!member.stats?.playerPartyTakeover, member.stats?.clanHuntBackoffs || [],
        objective ? [objective.reason, objective.sourceKind, objective.raidBoss, objective.controlledBy, objective.clanId] : null,
        Object.values(member.inventory || {}).filter(item => item.equipped).map(item => [item.selfId, item.slot, item.enchant || 0,
            item.equippedCount || 1, item.equippedSlots || [], (item.instances || []).filter(row => row.equipped).map(row => [row.slot, row.enchant || 0])]).sort(),
        combat.classId, combat.base || null, combat.henna || null, combat.equipment || null, member.stats?.hennas || [],
        combat.effects || [],
        ['tree', 'unresolved'].includes(combat.skillSource) ? [] : (combat.skills || []).map(skill => [skill.selfId, skill.level, !!skill.passive, skill.power]).sort()]);
}
function ownFingerprint(clan) {
    return hash([clan.id, clan.level, clan.state?.mode, clan.physicalMemberCount ?? clan.members.length,
        clan.members.map(member => [id(member), memberFingerprint(member)]).sort((a, b) => a[0] - b[0])]);
}
function ownerSection(clan, requested) {
    if (requested === 'productionGoal') return requested;
    const goal = clan.state?.goal;
    return goal && goal.type !== 'equipment' && goal.status !== 'completed' ? 'productionGoal' : 'goal';
}
function sourceFingerprint(spot) {
    return hash([spot.id, spot.avgLevel, spot.raidBossTemplateId, spot.raidInstanceId || null,
        spot.raidAuthorityRevision || 0, spot.raidWorldAvailable !== false]);
}
function goalFingerprint(goal) {
    return hash(goal ? [goal.goalKey, goal.type, goal.status, goal.controlledBy || null, goal.target,
        goal.plan?.kind, goal.plan?.sourceId, goal.assignedMemberIds || []] : null);
}
function scanKey(clan, spots, previousGoal, section) {
    return scanKeyForSources(clan, hash(spots.map(sourceFingerprint)), previousGoal, section);
}
function scanKeyForSources(clan, sources, previousGoal, section, own = ownFingerprint(clan)) {
    return hash([own, section, previousGoal?.target?.memberId || null, previousGoal?.target?.itemId || null, sources]);
}
function neededKinds(assessment) {
    const deficits = assessment.deficits || {};
    const kinds = [];
    if (deficits.healing?.healers || deficits.healing?.healingBuffers) kinds.push('healer', 'healingBuffer');
    if (deficits.mainBuffers) kinds.push('mainBuffer');
    if (deficits.tanks || assessment.reason === 'raid_tank_power_low') kinds.push('tank');
    if (!kinds.length && (deficits.members || deficits.damage || deficits.coreMembers || deficits.power)) kinds.push('damage');
    return kinds;
}
function proofRow(member) {
    return [id(member), Number(member.simulationRevision ?? member.simulation?.revision ?? 0),
        Number(member.classId ?? member.stats?.classId ?? 0), Number(member.level), memberFingerprint(member)];
}

// Called in the existing planning worker. RaidPolicy owns every composition,
// gear and power decision; the second assessment enforces physical free slots.
function prepare(clan, spots, prospects = [], previousGoal = null, readinessCache = new Map()) {
    if (clan.members.length > 40) return { raids: [], teams: {}, requests: [], retainedProspects: [] };
    const ownIds = new Set(clan.members.map(id));
    const free = Math.max(0, Rules.memberLimit(clan.level) - Number(clan.physicalMemberCount ?? clan.members.length));
    const pool = [...new Map(prospects.slice(0, 64).filter(member => !Number(member.clanId ?? member.stats?.clanId)
        && ['tank', 'damage', 'healer', 'mainBuffer', 'healingBuffer'].some(kind => Capabilities.contextualCapability(member, kind)))
        .map(member => [id(member), member])).values()];
    const teams = {}, raids = [], requests = new Map();
    const availableClan = { ...clan, members: clan.members.filter(member => !member.recruitmentReserved
        && !member.stats?.tradeMeeting && !member.stats?.playerPartyTakeover) };
    let retained = [], bestSize = -1;
    for (const spot of spots) {
        if (!spot.raidBoss || spot.raidWorldAvailable === false) continue;
        const options = { desiredMembers: 9, readinessCache, preferredMemberIds: [...ownIds] };
        const actual = Raid.assessment(availableClan, spot, previousGoal, options);
        if (actual.ready && actual.eligible.length === 9) {
            raids.push({ ...spot, raidRosterSize: 9, raidEstimate: actual.raidEstimate });
            teams[spot.id] = { source: { id: spot.id, npcId: Number(spot.raidBossTemplateId), avgLevel: Number(spot.avgLevel),
                raidInstanceId: spot.raidInstanceId || null, fingerprint: sourceFingerprint(spot) }, memberIds: actual.eligible.map(id),
                rows: actual.eligible.map(proofRow), prospectiveIds: [], ownFingerprint: ownFingerprint(clan), actualReady: true,
                deficits: actual.deficits, requirements: actual.requirements, neededKinds: [], reason: 'raid_ready' };
            continue;
        }
        let future = free ? Raid.assessment({ ...clan, members: [...availableClan.members, ...pool] }, spot, previousGoal, options) : actual;
        const selectedProspects = future.eligible.filter(member => !ownIds.has(id(member))).slice(0, free);
        if (selectedProspects.length || future.eligible.some(member => !ownIds.has(id(member)))) {
            future = Raid.assessment({ ...clan, members: [...availableClan.members, ...selectedProspects] }, spot, previousGoal, options);
        }
        const prospectiveIds = future.eligible.filter(member => !ownIds.has(id(member))).map(id);
        if (future.eligible.length > bestSize) { retained = prospectiveIds; bestSize = future.eligible.length; }
        if (future.ready && future.eligible.length === 9) {
            raids.push({ ...spot, raidRosterSize: 9, raidEstimate: future.raidEstimate });
            teams[spot.id] = { source: { id: spot.id, npcId: Number(spot.raidBossTemplateId), avgLevel: Number(spot.avgLevel),
                raidInstanceId: spot.raidInstanceId || null, fingerprint: sourceFingerprint(spot) },
                memberIds: future.eligible.map(id), rows: future.eligible.map(proofRow), prospectiveIds,
                ownFingerprint: ownFingerprint(clan), actualReady: actual.ready && actual.eligible.length === 9,
                deficits: actual.deficits, requirements: actual.requirements, neededKinds: neededKinds(actual),
                reason: actual.ready ? 'raid_ready' : actual.reason };
        } else if (free > 0) {
            const kinds = neededKinds(future);
            const kind = kinds.includes('healer') ? 'healing' : kinds.includes('mainBuffer') ? 'mainBuffer' : kinds.includes('tank') ? 'tank' : 'damage';
            const entry = requests.get(kind) || { kind, kinds, minLevel: Infinity, maxLevel: 0 };
            entry.minLevel = Math.min(entry.minLevel, Math.max(1, spot.avgLevel - Raid.MAX_LEVEL_BELOW_BOSS));
            entry.maxLevel = Math.max(entry.maxLevel, spot.avgLevel + Raid.MAX_LEVEL_ABOVE_BOSS);
            requests.set(kind, entry);
        }
    }
    return { raids, teams, retainedProspects: retained.slice(0, 9),
        requests: ['healing', 'mainBuffer', 'tank', 'damage'].flatMap(kind => requests.has(kind) ? [requests.get(kind)] : []) };
}

function buildDemand(clan, goal, team, section) {
    const kinds = [...new Set([...team.neededKinds, ...team.rows.filter(row => team.prospectiveIds.includes(row[0]))
        .map(row => Raid.raidRole({ classId: row[2], level: row[3] }) === 'buffer' ? 'mainBuffer' : Raid.raidRole({ classId: row[2], level: row[3] }))])];
    const generation = hash([clan.id, section, goal.goalKey, team.source.fingerprint,
        team.rows.map(row => [row[0], row[2], row[3], row[4]]).sort((a, b) => a[0] - b[0]), team.requirements]);
    return { clanId: clan.id, ownerSection: section, goalKey: goal.goalKey, generation, desiredMembers: 9,
        source: team.source, minLevel: Math.max(1, team.source.avgLevel - Raid.MAX_LEVEL_BELOW_BOSS),
        maxLevel: team.source.avgLevel + Raid.MAX_LEVEL_ABOVE_BOSS, neededKinds: kinds,
        classIds: Capabilities.classIdsForRequirements(kinds), requirements: team.requirements, deficits: team.deficits,
        newMemberIds: team.prospectiveIds, proof: { ownFingerprint: team.ownFingerprint, rows: team.rows },
        reason: team.reason, status: 'waiting' };
}
function fullRoster(clan, goal, team, section) {
    const demand = buildDemand(clan, goal, team, section);
    return { clanId: clan.id, ownerSection: section, goalKey: goal.goalKey, generation: demand.generation,
        memberIds: team.memberIds, sourceId: team.source.id, npcId: team.source.npcId,
        raidInstanceId: team.source.raidInstanceId, minPartySize: 9, maxPartySize: 9 };
}
function intakeContext(candidate, clan) {
    const demand = clan.state?.recruitmentDemand;
    if (!demand || clan.state?.mode !== 'autonomous') return null;
    const goal = clan.state[demand.ownerSection];
    const ownIds = new Set(clan.members.map(id));
    const remaining = demand.newMemberIds.filter(value => !ownIds.has(value));
    const allowed = goal?.goalKey === demand.goalKey && goal.status !== 'completed' && goal.controlledBy !== 'player'
        && remaining.includes(id(candidate)) && candidate.level >= demand.minLevel && candidate.level <= demand.maxLevel
        && demand.neededKinds.some(kind => Capabilities.contextualCapability(candidate, kind));
    return { contextualAllowed: allowed, roleNeed: allowed, growthNeed: allowed && remaining.length > 0,
        targetMemberCount: Math.min(Rules.memberLimit(clan.level), clan.members.length + remaining.length) };
}

module.exports = { memberFingerprint, ownFingerprint, ownerSection, sourceFingerprint, goalFingerprint, scanKey, scanKeyForSources, hash, neededKinds, proofRow,
    prepare, buildDemand, fullRoster, intakeContext };
