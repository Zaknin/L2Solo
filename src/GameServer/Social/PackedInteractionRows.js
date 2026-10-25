'use strict';
const { createHash } = require('node:crypto');
const Help = require('./CombatHelpPolicy');
const { TRAIT_KEYS: TRAITS } = require('./RelationshipLayers');

// Private storage only. Exported snapshots and policy results remain ordinary
// objects. Float64 keeps every accepted JS number, including clocks and ids.
const NUMBERS = ['targetId', 'at', 'order', 'affinity', 'trust', 'hostility', 'fear', 'familiarity',
    'lastHuntAt', 'lastAidAt', 'abandonedAt', 'gameAt', 'grudge', 'gratitude'];
const COLUMNS = Object.fromEntries(NUMBERS.map((field, index) => [field, index]));
const KINDS = ['character', 'clan', 'alliance'];
const EVENTS = ['hunted_together', 'helped_in_combat', 'healed', 'resurrected', 'resources_received',
    'mob_contested', 'attacked', 'killed', 'aided_opponent', 'invite_attempt', 'party_formed',
    'party_refused', 'party_dismissed', 'party_kicked', 'party_wiped', 'chat', 'supported_party',
    'trade_completed', 'gave_useful_loot', 'ignored_loot_request', 'insulted', 'crafted_for',
    'buff_service', 'gift', 'loot_taken'];
const EVENT_IDS = new Map(EVENTS.map((type, index) => [type, index]));
// Help clocks (one column per Help.TYPES entry; the meta order code says which
// exist and in what key order) and the event traits {loyalty, resilience}
// (Policy.event's normalized shape) are columns too, not per-row objects.
const HELP = NUMBERS.length;
// The order code keeps 2 bits per key (index + 1, 0 = none): at most 3 types.
if (Help.TYPES.length > 3) throw new Error('PackedInteractionRows: the help-clock order code holds at most 3 Help.TYPES');
const TRAIT = HELP + Help.TYPES.length;
const REASON = TRAIT + TRAITS.length;
const REASONS = 3;
const STRIDE = REASON + REASONS;
const META_STRIDE = 4 + REASONS; // kind, flags, count, help-clock order, type codes
// meta flags: bits 0-2 reason key order, then:
const PLAYER = 8, TRAIT_COLUMNS = 16, TRAIT_EMPTY = 32;
const NO_IDS = Object.freeze([]);
// Common key layouts contain no owner data. A bounded cache shares them across
// owners without keeping arbitrary future metadata keys after their last owner.
const layoutCache = new Map();

function layoutFor(keys) {
    const key = JSON.stringify(keys);
    let layout = layoutCache.get(key);
    if (layout) { layoutCache.delete(key); layoutCache.set(key, layout); return layout; }
    layout = Object.freeze({ keys: Object.freeze(keys), columns: Object.freeze(keys.map(field =>
        Object.hasOwn(COLUMNS, field) ? COLUMNS[field] : field === 'kind' ? -1
            : field === 'reasons' ? -2 : field === 'player' ? -3 : field === 'lastHelpAt' ? -5
                : field === 'traits' ? -6 : -4)) });
    if (layoutCache.size >= 128) layoutCache.delete(layoutCache.keys().next().value);
    layoutCache.set(key, layout);
    return layout;
}

function plainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function helpClocks(clocks) {
    return plainObject(clocks) && Object.keys(clocks).every(type =>
        Help.TYPES.includes(type) && typeof clocks[type] === 'number' && Number.isFinite(clocks[type]));
}

function traitColumns(traits) {
    if (!plainObject(traits)) return false;
    const keys = Object.keys(traits);
    return keys.length === TRAITS.length && keys.every((key, index) => key === TRAITS[index]
        && typeof traits[key] === 'number' && Number.isFinite(traits[key]));
}

function supported(row) {
    if (!row || !KINDS.includes(row.kind) || !Array.isArray(row.reasons) || row.reasons.length > REASONS) return false;
    for (const field of NUMBERS) {
        if (Object.hasOwn(row, field) && (typeof row[field] !== 'number' || !Number.isFinite(row[field]))) return false;
    }
    if (Object.hasOwn(row, 'player') && typeof row.player !== 'boolean') return false;
    if (Object.hasOwn(row, 'lastHelpAt') && !helpClocks(row.lastHelpAt)) return false;
    return row.reasons.every(reason => {
        if (!reason || typeof reason !== 'object' || Array.isArray(reason)
            || !EVENT_IDS.has(reason.type) || typeof reason.at !== 'number' || !Number.isFinite(reason.at)) return false;
        const keys = Object.keys(reason);
        return keys.length === 2 && keys.includes('type') && keys.includes('at');
    });
}

class PackedInteractionRows {
    // keepSocial false (the worker's copy): the per-type `social` counts are
    // dropped; their only reader is main's InteractionMemory.socialCounts.
    constructor(snapshot, { keepSocial = true } = {}) {
        this.version = snapshot.version;
        this.ownerId = snapshot.ownerId;
        this.revision = snapshot.revision;
        this.replayFloor = snapshot.replayFloor;
        this.length = snapshot.relations.length;
        this.values = new Float64Array(this.length * STRIDE);
        this.meta = new Uint8Array(this.length * META_STRIDE);
        this.layoutIds = new Uint16Array(this.length);
        this.layouts = [null];
        this.indexes = new Map();
        this.extras = null;
        this.fallback = null;
        const layouts = new Map();
        const content = createHash('sha256').update('interaction-memory:1\n');
        for (let ordinal = 0; ordinal < this.length; ordinal++) {
            // Preserve the old JSON-clone normalization and isolate caller
            // mutations, while only one transient plain row exists at a time.
            const encoded = JSON.stringify(snapshot.relations[ordinal]);
            const row = JSON.parse(encoded);
            content.update(encoded).update('\n');
            if (!keepSocial) delete row.social;
            if (!this.indexes.has(row.kind)) this.indexes.set(row.kind, new Map());
            this.indexes.get(row.kind).set(row.targetId, ordinal);
            const keys = Object.keys(row), key = JSON.stringify(keys);
            let layoutId = layouts.get(key);
            if (!supported(row) || (layoutId === undefined && this.layouts.length > 65535)) {
                if (!this.fallback) this.fallback = new Map();
                this.fallback.set(ordinal, row);
                continue;
            }
            if (layoutId === undefined) {
                layoutId = this.layouts.length;
                layouts.set(key, layoutId);
                this.layouts.push(layoutFor(keys));
            }
            this.layoutIds[ordinal] = layoutId;
            const base = ordinal * STRIDE, metadata = ordinal * META_STRIDE;
            this.meta[metadata] = KINDS.indexOf(row.kind);
            let flags = row.player === true ? PLAYER : 0;
            this.meta[metadata + 2] = row.reasons.length;
            for (let column = 0; column < NUMBERS.length; column++) {
                this.values[base + column] = row[NUMBERS[column]] ?? 0;
            }
            if (row.lastHelpAt) {
                let order = 0, shift = 0;
                for (const type of Object.keys(row.lastHelpAt)) {
                    const index = Help.TYPES.indexOf(type);
                    this.values[base + HELP + index] = row.lastHelpAt[type];
                    order |= (index + 1) << shift;
                    shift += 2;
                }
                this.meta[metadata + 3] = order;
            }
            if (Object.hasOwn(row, 'traits')) {
                if (traitColumns(row.traits)) {
                    flags |= TRAIT_COLUMNS;
                    for (let index = 0; index < TRAITS.length; index++) this.values[base + TRAIT + index] = row.traits[TRAITS[index]];
                } else if (plainObject(row.traits) && !Object.keys(row.traits).length) flags |= TRAIT_EMPTY;
            }
            for (let slot = 0; slot < row.reasons.length; slot++) {
                const reason = row.reasons[slot];
                this.values[base + REASON + slot] = reason.at;
                this.meta[metadata + 4 + slot] = EVENT_IDS.get(reason.type);
                if (Object.keys(reason)[0] === 'at') flags |= 1 << slot;
            }
            this.meta[metadata + 1] = flags;
            const extra = keys.filter(field => !Object.hasOwn(COLUMNS, field)
                && !['kind', 'reasons', 'player', 'lastHelpAt'].includes(field)
                && (field !== 'traits' || !(flags & (TRAIT_COLUMNS | TRAIT_EMPTY))));
            if (extra.length) {
                if (!this.extras) this.extras = new Map();
                this.extras.set(ordinal, Object.fromEntries(extra.map(field => [field, row[field]])));
            }
        }
        this.contentIdentity = content.digest('hex');
    }

    decode(ordinal) {
        if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= this.length) return null;
        const layout = this.layouts[this.layoutIds[ordinal]];
        if (!layout) return this.fallback.get(ordinal);
        const base = ordinal * STRIDE, metadata = ordinal * META_STRIDE, row = {};
        for (let index = 0; index < layout.keys.length; index++) {
            const field = layout.keys[index], column = layout.columns[index];
            let value;
            if (column >= 0) value = this.values[base + column];
            else if (column === -1) value = KINDS[this.meta[metadata]];
            else if (column === -3) value = !!(this.meta[metadata + 1] & PLAYER);
            else if (column === -2) {
                value = [];
                for (let slot = 0; slot < this.meta[metadata + 2]; slot++) {
                    const type = EVENTS[this.meta[metadata + 4 + slot]], at = this.values[base + REASON + slot];
                    value.push(this.meta[metadata + 1] & (1 << slot) ? { at, type } : { type, at });
                }
            } else if (column === -5) {
                value = {};
                for (let order = this.meta[metadata + 3]; order; order >>= 2) {
                    const index = (order & 3) - 1;
                    value[Help.TYPES[index]] = this.values[base + HELP + index];
                }
            } else if (column === -6 && this.meta[metadata + 1] & TRAIT_COLUMNS) {
                value = {};
                for (let index = 0; index < TRAITS.length; index++) value[TRAITS[index]] = this.values[base + TRAIT + index];
            } else if (column === -6 && this.meta[metadata + 1] & TRAIT_EMPTY) value = {};
            else value = this.extras.get(ordinal)[field];
            if (field === '__proto__') Object.defineProperty(row, field, { value, enumerable: true, writable: true, configurable: true });
            else row[field] = value;
        }
        return row;
    }

    row(kind, targetId) {
        if (typeof kind !== 'string' || typeof targetId !== 'number') {
            // The public view historically formed a string key. Preserve its
            // coercion for diagnostic callers without retaining string keys.
            const key = `${kind}:${targetId}`, split = key.indexOf(':');
            kind = key.slice(0, split);
            const text = key.slice(split + 1);
            targetId = Number(text);
            if (`${targetId}` !== text) return null;
        }
        const ordinal = this.indexes.get(kind)?.get(targetId);
        return ordinal === undefined ? null : this.decode(ordinal);
    }

    // The character targets in row order (the index keys; no second copy).
    characterIds() {
        return this.indexes.get('character')?.keys() ?? NO_IDS;
    }

    mapRows(work) {
        return Array.from({ length: this.length }, (_, index) => work(this.decode(index), index));
    }

    plain() {
        // Decoding already creates ordinary rows and reasons. Only exceptional
        // rows and nested extra fields still borrow private stored objects.
        const relations = this.mapRows((row, ordinal) => {
            if (this.fallback?.has(ordinal)) return JSON.parse(JSON.stringify(row));
            const extra = this.extras?.get(ordinal);
            if (extra) Object.assign(row, JSON.parse(JSON.stringify(extra)));
            return row;
        });
        // Preserve JSON export's normalization of accepted negative zero.
        return { version: this.version, ownerId: this.ownerId, revision: this.revision + 0,
            replayFloor: this.replayFloor + 0, readOnly: true, relations, recent: [] };
    }
}

module.exports = PackedInteractionRows;
