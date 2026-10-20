const Validation = require('./ColdCompetitionValidation');
const InventorySummary = require('./InventorySummary');
const Episode = require('./ColdCompetitionEpisode');
const Risk = require('./SpotRiskPolicy');
const PartyRisk = require('./PartySpotRiskPolicy');
// Voluntary decisions affect the actor's whole hunting unit, without blame.
// The avoided spot stays excluded for ten of the holder's own steps.
const AVOID_STEPS = 10;

async function apply({ event, life, owner, memory, parties, participantAllowed, contestContextAllowed,
    retreatRoute, onState, now, waitMs }) {
    const at = now(), sides = [];
    for (const participant of [event.actor, event.peer]) {
        const principal = life.cachedState(participant.id);
        const validation = { retreat: true, at, memory, participantAllowed, contestContextAllowed };
        const principalFailure = Validation.principal(principal, participant, memory);
        if (principalFailure) return principalFailure;
        const party = participant.partyId ? parties?.find(participant.partyId) : null;
        const partyFailure = Validation.party(party, participant, event, { ...validation,
            leader: party ? life.cachedState(party.leaderId) : null });
        if (partyFailure) return partyFailure;
        const memberIds = party ? party.memberIds : [participant.id];
        const members = memberIds.map(id => life.cachedState(id));
        for (let i = 0; i < members.length; i++) {
            const failure = Validation.member(members[i], memberIds[i], participant, event, { ...validation, party });
            if (failure) return failure;
        }
        sides.push({ principal, party, members });
    }
    const states = sides.flatMap(s => s.members);
    if (states.length > 18 || new Set(states.map(s => s.characterId)).size !== states.length) return { ok: false, reason: 'overlapping_sides' };
    const avoiding = event.action === 'avoid';
    // One avoid per holder, on its own counter: each member's far steps, the
    // party's rounds for the party copy.
    const avoidFor = counter => ({ spotId: event.spotId, untilStep: counter + AVOID_STEPS });
    const actorMembers = sides[0].members.map(s => avoiding ? { ...s, stats: { ...s.stats,
        coldCompetition: { ...s.stats?.coldCompetition, avoid: avoidFor(Risk.stepCount(s)) } } } : s);
    const route = avoiding ? retreatRoute(actorMembers, sides[0].party, event, at) : null;
    if (avoiding && (!route?.needed || !route.spotId || route.spotId === event.spotId)) return { ok: false, reason: 'no_retreat_route' };
    const { beginHuntingTrip } = require('./HuntingTravel');
    const travelling = avoiding ? actorMembers.map(s => beginHuntingTrip(s, route, at)) : [];
    if (avoiding && travelling.some(s => !s)) return { ok: false, reason: 'invalid_retreat_route' };
    const preparedParties = sides.map((side, i) => {
        if (!side.party) return null;
        const travel = avoiding && i === 0 ? { reason: 'party_spot_replan', cause: 'competition_avoid',
            regionName: route.regionName, spotId: route.spotId, startedAt: at, arrivalAt: travelling[0].timing.nextResolveAt } : null;
        const prepared = parties.prepareCommit({ ...side.party,
            spotId: travel ? route.spotId : side.party.spotId,
            nextResolveAt: i === 0 ? travel?.arrivalAt || Math.max(at, Number(side.party.nextResolveAt || 0)) + waitMs : side.party.nextResolveAt,
            stats: { ...side.party.stats, ...(travel ? { travel } : {}), coldCompetition: Episode.begin(side.party.stats?.coldCompetition, {
                outcome: event.action, key: event.key, at, action: event.action, peerId: sides[1 - i].principal.characterId,
                ...(i === 0 ? avoiding ? { avoid: avoidFor(PartyRisk.rounds(side.party)) } : { wait: { start: at, until: at + waitMs } } : {})
            }) } });
        prepared.row.updatedAt = Math.max(prepared.row.updatedAt, side.party.updatedAt + 1);
        return prepared;
    });
    const next = sides.flatMap((side, i) => side.members.map((s, j) => {
        const result = avoiding && i === 0 ? travelling[j] : s;
        return { ...result, stats: { ...result.stats, coldCompetition: Episode.begin(result.stats?.coldCompetition, {
            outcome: event.action, key: event.key, at, action: event.action, peerId: sides[1 - i].principal.characterId,
            ...(i === 0 && !avoiding ? { wait: { start: at, until: at + waitMs } } : {}) }) },
        timing: i === 0 ? { ...result.timing,
            nextResolveAt: preparedParties[i]?.row.nextResolveAt || (avoiding ? result.timing.nextResolveAt : Math.max(at, Number(s.timing?.nextResolveAt || 0)) + waitMs) } : s.timing };
    }));
    const group = { id: event.key, memberIds: states.map(s => s.characterId),
        partyChanges: preparedParties.flatMap((p, i) => p ? [{ partyId: p.row.partyId,
            expectedPartyRevision: sides[i].party.revision, memberIds: sides[i].party.memberIds,
            spotId: p.row.spotId, nextResolveAt: p.row.nextResolveAt, statsJson: p.row.statsJson, updatedAt: p.row.updatedAt }] : []) };
    // Each member commits on its cached revision: a write since then refuses
    // the group whole.
    const results = await owner.commitBatch(next.map((s, i) => ({
        revision: Number(states[i].simulation?.revision || 0), nextState: s, atomicGroup: group,
        options: { allowParty: true, allowLifecycle: true }, proposal: InventorySummary.bagChange(states[i].inventory, s.inventory)
    })), { timestamp: now(), journalReason: 'retreat' });
    if (results.length !== states.length || results.some(r => !r.ok)) return { ok: false, reason: 'commit_rejected' };
    // Each side caches its own committed row (Database commitBatch, partyRow).
    preparedParties.filter(Boolean).forEach(p => parties.acceptRow(results.find(r => r.partyRow?.partyId === p.row.partyId).partyRow));
    states.forEach(s => onState(s.characterId));
    return { ok: true, affectedIds: sides[0].members.map(s => s.characterId), memoryEvents: 0,
        matchup: sides.map(s => s.party ? 'party' : 'solo').join('_vs_'),
        ...(avoiding ? { destinationSpotId: route.spotId, arrivalAt: travelling[0].timing.nextResolveAt, avoidSteps: AVOID_STEPS }
            : { waitUntil: at + waitMs }) };
}
module.exports = { apply, AVOID_STEPS };
