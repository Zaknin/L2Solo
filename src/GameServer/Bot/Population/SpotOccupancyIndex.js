'use strict';

const CharacterLocationIndex = require('../../World/CharacterLocationIndex');
const Risk = require('./SpotRiskPolicy');
const providers = new WeakMap();

// Who stands on each spot and who is heading there, kept up to date at every
// state write. SpotProfiles.indexedOccupancy turns it into the same snapshot
// occupancySnapshot builds from a full state list, rebuilding only the spots
// whose members changed instead of walking the whole population every second.

function stateKey(state = {}) {
    return String(state.characterId || state.name || state.stats?.generatedIndex || '');
}

function occupiedSpotId(state = {}) {
    if (state.activity === 'traveling' && state.stats?.travel?.spotId) return state.stats.travel.spotId;
    if (['merchant', 'shopping', 'crafting', 'traveling'].includes(state.activity)) return null;
    return state.spotId || null;
}

function farmIntentCandidate(state = {}) {
    if (['merchant', 'shopping', 'crafting', 'dead'].includes(state.activity)) return null;
    if ((state.party?.partyId || state.partyId) && state.stats?.backgroundPartySpotId)
        return state.stats.backgroundPartySpotId;
    const clanObjective = state.stats?.clanPartyObjective;
    const request = state.stats?.partyRequest;
    const plan = state.stats?.equipmentPlan;
    if (clanObjective?.spotId && ['open', 'deferred'].includes(String(clanObjective.status || ''))) {
        return clanObjective.spotId;
    }
    if (request?.spotId && ['open', 'deferred'].includes(String(request.status || ''))) return request.spotId;
    if (plan?.status === 'active' && ['direct_drop', 'craft'].includes(plan.strategy) && plan.next?.spotId) {
        return plan.next.spotId;
    }
    return null;
}

// A "was full" mark lives the holder's own steps: it changes only with a new
// state, which every write hands to update(), so no pass refreshes it.
function capacityBackedOff(state, spotId) {
    return (state.stats?.capacityBackoffs || []).some(entry => String(entry.spotId) === String(spotId)
        && Risk.markActive(entry, state));
}

function farmIntentSpotId(state = {}) {
    const spotId = farmIntentCandidate(state);
    return spotId && !capacityBackedOff(state, spotId) ? spotId : null;
}

function addMember(membersBySpot, spotId, key) {
    if (!spotId) return;
    if (!membersBySpot.has(spotId)) membersBySpot.set(spotId, new Set());
    membersBySpot.get(spotId).add(key);
}

function removeMember(membersBySpot, spotId, key) {
    const members = membersBySpot.get(spotId);
    if (!members) return;
    members.delete(key);
    if (!members.size) membersBySpot.delete(spotId);
}

class SpotOccupancyIndex {
    constructor({ locationIndex = null } = {}) {
        if (locationIndex !== null && (!(locationIndex instanceof CharacterLocationIndex)
            || locationIndex.legacyStateCache !== true)) throw new TypeError('invalid_occupancy_source_index');
        const index = locationIndex ?? new CharacterLocationIndex({ legacyStateCache: true });
        providers.set(this, { index, ownsSources: locationIndex === null });
        Object.defineProperty(this, 'locationIndex', { value: index, enumerable: true });
        this.places = new Map();
        this.physical = new Map();
        this.reserved = new Map();
        this.dirty = new Set();
    }

    update(state, options = {}) {
        const key = stateKey(state); // Keep null's inherited error before writes.
        const { index, ownsSources } = providers.get(this);
        if (ownsSources) {
            if (state === undefined) {
                this.remove(key);
                this.places.set(key, { record: null, spotId: null, intentSpotId: null,
                    get state() { return undefined; } });
                return;
            }
            // Standalone planning owns raw records only, never a second grid.
            // Do not read phase/location that the planning policy never used.
            const record = { id: key, source: state, phase: 'hot' };
            index.setSource(key, 'state', record, { indexed: false });
            this.updateRecord(record);
            return;
        }
        const id = Object.prototype.hasOwnProperty.call(options, 'sourceId')
            ? options.sourceId : Number(state?.characterId || 0);
        const record = index.getSource(id, 'state');
        if (!record || !Object.is(record.source, state)) return false;
        return this.updateRecord(record);
    }

    updateRecord(record) {
        const { index } = providers.get(this);
        if (!record || index.getSource(record.id, 'state') !== record) return false;
        const state = record.source;
        const key = stateKey(state);
        const spotId = occupiedSpotId(state);
        const candidate = farmIntentCandidate(state);
        const intentSpotId = candidate && !capacityBackedOff(state, candidate) ? candidate : null;
        this.removePlace(key);
        this.places.set(key, { record, spotId, intentSpotId,
            get state() { return record.source; } });
        addMember(this.physical, spotId, key);
        addMember(this.reserved, spotId, key);
        addMember(this.reserved, intentSpotId, key);
        if (spotId) this.dirty.add(spotId);
        if (intentSpotId) this.dirty.add(intentSpotId);
        return true;
    }

    removePlace(key) {
        const place = this.places.get(key);
        if (!place) return;
        removeMember(this.physical, place.spotId, key);
        removeMember(this.reserved, place.spotId, key);
        removeMember(this.reserved, place.intentSpotId, key);
        if (place.spotId) this.dirty.add(place.spotId);
        if (place.intentSpotId) this.dirty.add(place.intentSpotId);
        this.places.delete(key);
        return place;
    }

    remove(key) {
        const place = this.removePlace(key);
        const { index, ownsSources } = providers.get(this);
        if (ownsSources && place?.record && index.getSource(place.record.id, 'state') === place.record) {
            index.removeSource(place.record.id, 'state', place.record.source);
        }
    }

    removeRecord(record) {
        if (!record) return false;
        const key = stateKey(record.source);
        if (this.places.get(key)?.record !== record) return false;
        const current = providers.get(this).index.getSource(record.id, 'state');
        if (current !== null && current !== record) return false;
        this.remove(key);
        return true;
    }

    *members(spotId, kind) {
        if (kind !== 'physical' && kind !== 'reserved') throw new TypeError('invalid_occupancy_membership');
        const { index } = providers.get(this);
        for (const key of this[kind].get(spotId) || []) {
            const record = this.places.get(key)?.record;
            if (record && index.getSource(record.id, 'state') === record) yield [key, record.source];
        }
    }

    // How many bots the index has on a spot ('physical'): standingOnly leaves
    // out the bots still on their way there (indexed at their destination),
    // excludeKeys the given state keys.
    physicalCount(spotId, { excludeKeys = null, standingOnly = false } = {}) {
        let count = 0;
        for (const [key, state] of this.members(spotId, 'physical')) {
            if (!(standingOnly && state?.activity === 'traveling') && !excludeKeys?.has(key)) count++;
        }
        return count;
    }

    size() { return { owners: this.places.size, physical: this.physical.size, reserved: this.reserved.size }; }

    clear() {
        for (const spotId of [...this.physical.keys(), ...this.reserved.keys()]) this.dirty.add(spotId);
        this.places.clear();
        this.physical.clear();
        this.reserved.clear();
        const { index, ownsSources } = providers.get(this);
        if (ownsSources) index.clearSourceView('state');
    }
}

module.exports = { SpotOccupancyIndex, stateKey, occupiedSpotId, farmIntentSpotId };
