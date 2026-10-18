'use strict';
// The bot's hunting route (docs/architecture.md §2 route): where a far bot
// hunts and the trip there. Two parts:
// - choose: the spot search, the bot's computed value over COMPUTED.route
//   (build, relations, occupation, sources). The worker keeps its result in
//   the bot's kernel record (ColdSimulationWorker planLifecycle) and drops it
//   when the step's mask hits those sections or the step wrote another plan
//   destination; it reads no leaf and no focus (own outputs).
// - record: the trip from where the bot stands now (destinations, travel
//   time, the reason fields), built per read and never kept.
// leafChoice: the spot the step's own decision names, when it may go there.
// Callers: the worker's trip start (planLifecycle), the party run (the
// worker's partyRoute, ColdSimulationKernel), the competition retreat on main
// (ColdSimulationCoordinator retreatRoute). Worker-safe: every spot lookup
// reads the catalog the caller passes (`spots`, the spot profile array: the
// worker's planning catalog, SpotProfiles.ensure() on main).
const SpotIndex = invoke('GameServer/Bot/AI/SpotIndex');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const LevelingRoutes = invoke('GameServer/Bot/AI/LevelingRoutes');
const BotTargetMatchup = invoke('GameServer/Bot/AI/BotTargetMatchup');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const SpotRiskPolicy = invoke('GameServer/Bot/Population/SpotRiskPolicy');
const PartyWaitFallback = invoke('GameServer/Bot/Population/PartyWaitFallback');
const PartyComposition = invoke('GameServer/Bot/Population/BackgroundPartyComposition');
const ClanPartyDuty = invoke('GameServer/Bot/Population/ClanPartyDuty');
const BotCrystallization = invoke('GameServer/Bot/Economy/BotCrystallization');
const EquipmentIncomeRoute = invoke('GameServer/Bot/Economy/EquipmentIncomeRoute');
const PartySpotRiskPolicy = require('./PartySpotRiskPolicy');
const PartyHuntingAssembly = require('./PartyHuntingAssembly');
const CraftMaterialParty = require('./CraftMaterialParty');
const CraftMaterialPartyRoute = require('./CraftMaterialPartyRoute');
const ColdTrip = require('./ColdTrip');

// The gates: a bot that may be routed now. Checked by choose and again by
// record at every read (activity, travel and the duties move step by step).
function routable(state, party, partyMembers) {
    if (!state || state.phase !== 'cold' || state.stats?.travel) return false;
    if (!party && ClanPartyDuty.waiting(state)) return false;
    if (!(state.activity === 'hunting' || (party && state.activity === 'grouped'))) return false;
    if (!party && BotCrystallization.ready(state)) return false;
    return !(party && partyMembers.some((member) => ['resting', 'traveling', 'dead'].includes(member.activity)));
}

// The spot the bot stands on now. Virtual raid profiles share the ordinary
// world grid with their surrounding field. Once the party has arrived, its
// persisted raid spot is the semantic destination; preferring the grid id
// here would schedule another 25-second trip to the same coordinates forever.
function currentSpotId(state, currentSpot, party, spots) {
    let physical = null;
    try { physical = SpotService.findCurrentSpot(state.loc, spots); } catch (_) { physical = null; }
    const declaredSpotId = party?.spotId || state.spotId || null;
    const declaredSpot = declaredSpotId ? SpotIndex.spotById(spots, declaredSpotId) : null;
    return declaredSpot?.raidBoss === true ? declaredSpot.id : physical?.id || currentSpot?.id || declaredSpotId;
}

// Match the combat resolver: an indexed coordinate sector only describes the
// current ground when it agrees with the persisted spot. Legacy dungeon
// sectors can keep their qualified id/name after the rebuilt spawn index
// exposes the same grid as an ordinary field.
function groundOf(state, currentSpot) {
    if (currentSpot && (!state.spotId || String(state.spotId) === String(currentSpot.id))) return currentSpot;
    return (state.spotId || state.currentRegion) ? {
        id: state.spotId || null,
        name: state.currentRegion || null,
        area: state.area || state.stats?.area || null
    } : currentSpot;
}

// The search options of one routed bot or party at this timestamp. Solo
// checks judge this bot, as the only capacity state; its combat profiles
// depend on the bot, not the spot: built once per call (solo()).
function frameFor(state, party, partyMembers, timestamp) {
    const partyRoute = !!party;
    const routedMembers = partyRoute ? partyMembers : [state];
    const excludedSpotIds = partyRoute ? PartySpotRiskPolicy.excludedSpotIds(party, timestamp)
        : SpotRiskPolicy.excludedSpotIdsForStates(routedMembers, timestamp);
    const role = partyRoute ? PartyComposition.roleForState(state) : null;
    const options = { capacityStates: routedMembers, excludedSpotIds, timestamp,
        ...(partyRoute ? { mode: 'party', role } : {}) };
    let soloProfiles = null;
    const solo = () => {
        soloProfiles = soloProfiles || BotTargetMatchup.stateProfiles(state, { ...options, mode: 'solo' });
        return { ...options, mode: 'solo', matchupProfiles: soloProfiles };
    };
    return { partyRoute, routedMembers, excludedSpotIds, role, options, solo };
}

function unsafeSoloGround(state, currentSpot, frame) {
    const ground = !frame.partyRoute ? groundOf(state, currentSpot) : null;
    return !!ground && !LevelingRoutes.isSpotAllowedForState(ground, state, frame.solo());
}

// The search: { spotId (null: none found), materialRoute, materialSources }
// or null when the bot may not be routed now (nothing to keep). Reads no
// leaf and no focus.
function choose(state, currentSpot, party, partyMembers = [], { spots, timestamp }) {
    if (!routable(state, party, partyMembers)) return null;
    const frame = frameFor(state, party, partyMembers, timestamp);
    const { partyRoute, excludedSpotIds, role, options } = frame;
    const currentId = currentSpotId(state, currentSpot, party, spots);
    let fallbackSpot = null;
    if (!partyRoute && PartyWaitFallback.waiting(state, state.stats?.equipmentPlan, state.stats?.partyRequest)) {
        try {
            fallbackSpot = PartyWaitFallback.spotFor(state, state.stats?.equipmentPlan, spots,
                { excludedSpotIds, timestamp })?.spot || null;
        } catch (_) { fallbackSpot = null; }
    }
    const routeState = partyRoute
        ? {
            ...state,
            spotId: party.spotId || state.spotId,
            party: { ...(state.party || {}), partyId: party.partyId, role },
            stats: { ...(state.stats || {}), routeMode: 'party' }
        }
        : fallbackSpot
            ? { ...state, spotId: null }
            : state;
    const unsafe = unsafeSoloGround(state, currentSpot, frame);
    // The party's objective spot rule: a clan objective's spot, unless excluded.
    const sharedSpot = party?.stats?.objective?.spotId;
    let selected = partyRoute && sharedSpot && !excludedSpotIds.has(String(sharedSpot))
        ? SpotIndex.spotById(spots, sharedSpot) : fallbackSpot;
    let materialRoute = null;
    if (!selected && partyRoute && CraftMaterialParty.isObjective(party.stats?.objective)) {
        materialRoute = CraftMaterialPartyRoute.select(party, partyMembers, spots, options);
        selected = materialRoute?.spot || null;
    }
    try {
        // A party-mode search of a lone member builds no profiles at all.
        if (!selected) selected = SpotProfiles.findForState(routeState, !partyRoute
            && LevelingRoutes.modeForState(routeState, options) !== 'party'
            ? { ...options, profiles: spots, matchupProfiles: frame.solo().matchupProfiles }
            : { ...options, profiles: spots });
    } catch (_) { selected = null; }
    if (unsafe && selected) {
        const repeatsCurrentGround = String(selected.id || '') === String(currentId || '');
        if (repeatsCurrentGround || !LevelingRoutes.isSpotAllowedForState(selected, state, frame.solo())) selected = null;
    }
    if (!selected && unsafe) selected = evacuationSpot(state, currentId, spots, frame);
    return { spotId: selected ? selected.id : null,
        ...(materialRoute ? { materialRoute: true, materialSources: materialRoute.sources } : {}) };
}

// No suitable field: a detached party member must not poll a blocked dungeon
// forever. Only for this rare safety evacuation, choose the least-bad allowed
// field near its level; the room there is checked at arrival, which lets it
// exceed a full spot by one (ARCH-08-a).
function evacuationSpot(state, currentId, spots, frame) {
    const level = Number(state.level || 1);
    const emergencyOptions = frame.solo();
    const nearLevel = spots
        .filter((profile) => profile.raidBoss !== true)
        .filter((profile) => String(profile.id) !== String(currentId || ''))
        .filter((profile) => !frame.excludedSpotIds.has(String(profile.id)))
        .filter((profile) => (
            Number(profile.minLevel || 1) <= level + 4
            && Number(profile.maxLevel || profile.minLevel || 1) >= level - 4
        ));
    const emergencyCandidates = nearLevel.filter((profile) => (
        LevelingRoutes.isSpotAllowedForState(profile, state, emergencyOptions)
    ));
    const suitable = emergencyCandidates.filter((profile) => SpotService.isSuitable(profile, level, frame.options));
    return emergencyCandidates.length ? LevelingRoutes.bestSpot(
        suitable.length ? suitable : emergencyCandidates, state, emergencyOptions)?.spot || null : null;
}

// The spot a solo bot's own hunting leaf names, as a choice for record, when
// the bot may hunt there: not a raid profile, not excluded, allowed for its
// kit, and fitting its level (or an economic hunt within 15 levels). The
// room is checked at arrival. Null: the kept route decides.
function leafChoice(state, leaf, { spots, timestamp }) {
    if (leaf?.activity !== 'hunting' || !leaf.spotId || !routable(state, null, [])) return null;
    const wished = SpotIndex.spotById(spots, leaf.spotId);
    if (!wished || wished.raidBoss === true) return null;
    const frame = frameFor(state, null, [], timestamp);
    if (frame.excludedSpotIds.has(String(wished.id))) return null;
    const level = Number(state.level || 1);
    const fits = LevelingRoutes.isSpotAllowedForState(wished, state, frame.solo())
        && (SpotService.isSuitable(wished, level, frame.options)
            || EquipmentIncomeRoute.economicHunt(state) && Number(wished.avgLevel || wished.minLevel || 1) >= level - 15);
    return fits ? { spotId: wished.id } : null;
}

// The trip to a chosen spot from where the bot stands now, in the shape
// beginHuntingTrip reads, or null: not routable now, the spot left the
// catalog, the bot is already there, or no arrival point. The reason fields
// are read here, at the trip's start: a kept choice is read later, from
// another place (its death pressure and its ground are those of the start).
function record(state, chosen, party, partyMembers = [], { spots, currentSpot = null, timestamp }) {
    if (!chosen?.spotId || !routable(state, party, partyMembers)) return null;
    const selected = SpotIndex.spotById(spots, chosen.spotId);
    if (!selected) return null;
    const partyRoute = !!party;
    const currentId = currentSpotId(state, currentSpot, party, spots);
    const repairingPartyPosition = partyRoute && String(selected.id) === String(party.spotId || '')
        && partyMembers.every(member => member.phase === 'cold' && member.vitals?.hp > 0
            && !member.stats?.pvpEncounter && !member.stats?.travel)
        && (!PartyHuntingAssembly.nearby(partyMembers)
            || partyMembers.some(member => !SpotService.containsLocation(selected, member.loc)));
    const sharedSpot = party?.stats?.objective?.spotId;
    const materialEvacuation = partyRoute && !chosen.materialRoute
        && CraftMaterialParty.isObjective(party.stats?.objective) && String(selected.id) !== String(sharedSpot);
    if (String(selected.id) === String(currentId || '') && !repairingPartyPosition
        && !chosen.materialRoute && !materialEvacuation
        && (!partyRoute || String(party.spotId || '') === String(selected.id))) return null;

    const members = partyRoute ? partyMembers : [state];
    const destinations = partyRoute ? SpotService.arrivalPointsForParty(members, selected) : {};
    if (!destinations) return null;
    for (const member of partyRoute ? [] : members) {
        let destination = null;
        try { destination = SpotService.arrivalPointForState(member, selected); } catch (_) { destination = null; }
        if (!destination) return null;
        destinations[String(member.characterId)] = destination;
    }
    const frame = frameFor(state, party, partyMembers, timestamp);
    const spotBackoff = partyRoute ? PartySpotRiskPolicy.backoff(party, currentId, timestamp)
        : SpotRiskPolicy.backoffForStates(frame.routedMembers, currentId, timestamp);
    const unsafe = unsafeSoloGround(state, currentSpot, frame);
    const activeEquipmentPlan = state.stats?.equipmentPlan?.status === 'active';
    return {
        needed: true,
        mode: partyRoute ? 'party' : 'solo',
        currentSpotId: currentId,
        spotId: selected.id,
        regionName: selected.name || state.currentRegion || 'Hunting Ground',
        // The routed bot's trip time; a party's members all take it.
        travelMs: ColdTrip.spotTripMs(state, destinations[String(state.characterId)] || selected.center),
        reason: partyRoute
            ? 'party_spot_replan'
            : unsafe ? 'unsafe_ground_evacuation'
                : spotBackoff ? 'death_pressure_replan'
                    : activeEquipmentPlan ? 'equipment_source_replan' : 'level_replan',
        ...(spotBackoff ? { cause: 'death_pressure', spotBackoff }
            : repairingPartyPosition ? { cause: 'position_mismatch' } : {}),
        to: destinations[String(state.characterId)] || null,
        destinations,
        ...(chosen.materialRoute ? { materialSources: chosen.materialSources }
            : materialEvacuation ? { materialEvacuation: true } : {})
    };
}

// One search and its trip, nothing kept: the party run and the retreat.
function route(state, currentSpot, party, partyMembers, { spots, timestamp }) {
    return record(state, choose(state, currentSpot, party, partyMembers, { spots, timestamp }), party, partyMembers,
        { spots, currentSpot, timestamp });
}

module.exports = { choose, record, leafChoice, route };
