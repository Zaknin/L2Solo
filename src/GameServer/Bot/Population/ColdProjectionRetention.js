'use strict';

function stateStamp(state) {
    const simulation = state.simulation || {};
    const timing = state.timing || {};
    const loc = state.loc || {};
    const vitals = state.vitals || {};
    return [state.phase, state.activity, state.updatedAt, state.spotId, state.currentRegion, state.homeRegion,
        state.level, state.exp, state.sp, state.adena, state.levelBand, state.stats?.karma,
        simulation.ownerId, simulation.revision, simulation.leaseId, simulation.leaseUntil,
        timing.activityStartedAt, timing.nextResolveAt, timing.lastResolvedAt, timing.lastHotAt,
        vitals.hp, vitals.maxHp, vitals.mp, vitals.maxMp,
        loc.locX, loc.locY, loc.locZ, state.inventory, state.stats, state.vitals, state.party];
}

function same(left, right) {
    return left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}

// Party, memory, pressure, goal and escrow are worker tables, not context:
// a replayed entry carries none of them, so none is checked here.
function contextStamp(context) {
    return [context.spot, context.clanHallServices, context.targetNpcId];
}

// Replay only a producer's existing intent. The provider reads current local
// dependencies; it never plans, hydrates or obtains global context views.
class ColdProjectionRetention {
    constructor({ stateFor, dependencies, epoch }) {
        this.stateFor = stateFor;
        this.dependencies = dependencies;
        this.epoch = epoch;
        this.reset();
    }

    reset() {
        // One projection per character. Keyed by the state object, a replaced
        // party member stayed alive through its partner's projection, and kept
        // its own projection, with the partner's older state, alive in turn.
        this.entries = new Map();
        this.prepared = new WeakMap();
        this.dirty = new WeakMap();
    }

    invalidate(state) {
        if (state && typeof state === 'object') this.dirty.set(state, (this.dirty.get(state) || 0) + 1);
    }

    prepare(state, context) {
        if (this.stateFor(state?.characterId) !== state || !context) return;
        this.prepared.set(context, {
            state, context, epoch: this.epoch(), stamp: this.dependencies(state, context),
            contextStamp: contextStamp(context),
            own: stateStamp(state), sequence: this.dirty.get(state) || 0
        });
    }

    remember(entry) {
        const prepared = this.prepared.get(entry?.context);
        if (!prepared || prepared.state !== entry.state || this.stateFor(entry.state.characterId) !== entry.state) return false;
        this.entries.set(Number(entry.state.characterId), { ...prepared, entry });
        return true;
    }

    get(characterId) {
        const unavailable = reason => ({ ok: false, reason });
        if (!Number.isSafeInteger(characterId) || characterId <= 0) return unavailable('invalid_character');
        const state = this.stateFor(characterId);
        if (!state) {
            this.entries.delete(characterId);
            return unavailable('missing_state');
        }
        const record = this.entries.get(characterId);
        if (!record || record.state !== state) return unavailable('missing_projection');
        if (!record.epoch || record.epoch !== this.epoch()) return unavailable('projection_epoch_changed');
        if (state.phase !== 'cold' || !same(record.own, stateStamp(state))) return unavailable('projection_state_changed');
        if (record.sequence !== (this.dirty.get(state) || 0)) return unavailable('projection_dirty');
        const context = record.context;
        if (!same(record.contextStamp, contextStamp(context))) return unavailable('projection_context_changed');
        if (context.spot?.raidBoss) return unavailable('dynamic_raid_context');
        const current = this.dependencies(state, context);
        if (current.clanId || context.clanHallServices) return unavailable('dynamic_clan_hall_context');
        if (record.stamp.catalog !== current.catalog || record.stamp.physicalCatalog !== current.physicalCatalog) {
            return unavailable('spot_catalog_changed');
        }
        if (context.targetNpcId !== current.targetNpcId) return unavailable('target_changed');
        return { ok: true, entry: record.entry };
    }
}

module.exports = { ColdProjectionRetention };
