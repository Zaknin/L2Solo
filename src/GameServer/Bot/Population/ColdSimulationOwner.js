const DiagnosticConfig = require('./PopulationConfig');
const { randomUUID } = require('crypto');

const Database = invoke('Database');
const InventorySummary = invoke('GameServer/Bot/Population/InventorySummary');
const C4Unseal = invoke('GameServer/Items/C4Unseal');
const BotErrands = require('./BotErrands');

const OWNER_ID = 'cold_simulation_owner';
const LEGACY_OWNER_ID = 'legacy_main';
const DEFAULT_LEASE_MS = 30000;
const SIMPLE_ACTIVITIES = new Set(['hunting', 'resting', 'traveling', 'dead']);
const LEGACY_PLAN_STRATEGIES = new Set(['market', 'craft']);

function Metrics() {
    return invoke('GameServer/Bot/Population/PopulationMetrics');
}

function recordFailure(error) {
    DiagnosticConfig.developerDiagnostics && Metrics().recordColdOwnerError(error);
    if (error && typeof error === 'object') error.coldOwnerRecorded = true;
    throw error;
}

function eligibility(state = {}, options = {}) {
    if (!state?.characterId) return { ok: false, reason: 'missing_state' };
    if (state.phase !== 'cold') return { ok: false, reason: 'not_cold' };
    if (!SIMPLE_ACTIVITIES.has(String(state.activity || '')) && options.allowLifecycle !== true) return { ok: false, reason: 'legacy_activity' };
    if ((state.partyId || state.party?.partyId) && options.allowParty !== true) return { ok: false, reason: 'background_party' };
    if (options.allowLifecycle === true) {
        return { ok: true, reason: state.partyId || state.party?.partyId ? 'background_party_cold' : 'trusted_cold_lifecycle' };
    }
    if (options.hasWarehouseWorkflow === true) return { ok: false, reason: 'warehouse_state' };
    const stats = state.stats || {};
    if (stats.mammonReturn || (Number(stats.mammonRetryAt || 0) <= Date.now()
        && C4Unseal.sealedHeld(state.inventory))) return { ok:false, reason:'craft_state' };
    const busy = BotErrands.busyWith(state, BotErrands.COLD_CLAIM);
    if (busy) return { ok: false, reason: BotErrands.CLAIM_REASONS[busy] };
    if (stats.backgroundPartyId && options.allowParty !== true) return { ok: false, reason: 'background_party' };
    if (LEGACY_PLAN_STRATEGIES.has(String(stats.equipmentPlan?.strategy || ''))) {
        return { ok: false, reason: `${stats.equipmentPlan.strategy}_plan` };
    }
    if (state.activity === 'traveling' && stats.travel) {
        const arrivalActivity = String(stats.travel.arrivalActivity || 'shopping');
        const reason = String(stats.travel.reason || '');
        if (!SIMPLE_ACTIVITIES.has(arrivalActivity)) return { ok: false, reason: 'legacy_travel' };
        if (/(market|shop|sell|buy)/i.test(reason)) return { ok: false, reason: 'market_state' };
        if (/craft/i.test(reason)) return { ok: false, reason: 'craft_state' };
    }
    return { ok: true, reason: state.partyId || state.party?.partyId ? 'background_party_cold' : 'simple_solo_cold' };
}

function leaseId() {
    return `cold-owner:${randomUUID()}`;
}

function ownership(state = {}) {
    return {
        ownerId: state.simulation?.ownerId || LEGACY_OWNER_ID,
        revision: Math.max(0, Number(state.simulation?.revision || 0)),
        leaseId: state.simulation?.leaseId || null,
        leaseUntil: Math.max(0, Number(state.simulation?.leaseUntil || 0))
    };
}

function persistencePatch(state = {}, timestamp = Date.now(),
    inventorySummary = JSON.stringify(InventorySummary.canonicalize(state.inventory))) {
    return {
        level: Number(state.level || 1),
        exp: Number(state.exp || 0),
        sp: Number(state.sp || 0),
        adena: Number(state.adena || 0),
        homeRegion: state.homeRegion || null,
        currentRegion: state.currentRegion || null,
        spotId: state.spotId || null,
        activity: state.activity || 'hunting',
        phase: state.phase || 'cold',
        activityStartedAt: state.timing?.activityStartedAt || null,
        nextResolveAt: state.timing?.nextResolveAt || null,
        lastResolvedAt: state.timing?.lastResolvedAt || null,
        lastHotAt: state.timing?.lastHotAt || null,
        locX: Number(state.loc?.locX || 0),
        locY: Number(state.loc?.locY || 0),
        locZ: Number(state.loc?.locZ || 0),
        hp: Number(state.vitals?.hp || 0),
        maxHp: Number(state.vitals?.maxHp || 0),
        mp: Number(state.vitals?.mp || 0),
        maxMp: Number(state.vitals?.maxMp || 0),
        targetLevelBand: state.levelBand || null,
        deathCount: Number(state.stats?.deaths || 0),
        partyId: state.party?.partyId || null,
        inventorySummary,
        statsJson: JSON.stringify(state.stats || {}),
        updatedAt: Number(state.updatedAt || timestamp)
    };
}

// The proposal's stats with the economy leaf the row kept (the commit's
// RETURNING: JSON text, null when none). A new object only when they differ.
function withEconomyLeaf(stats = {}, leaf) {
    if (leaf == null) {
        if (!Object.hasOwn(stats, 'economyCommit')) return stats;
        const rest = { ...stats };
        delete rest.economyCommit;
        return rest;
    }
    return JSON.stringify(stats.economyCommit) === leaf ? stats : { ...stats, economyCommit: JSON.parse(leaf) };
}

// The committed state is the proposal's own object with the commit's numbers.
// A commit that rewrote the row after its UPDATE (a settlement, a PvP tally,
// a PK drop, a party payment) hands the whole row back: its stats hold what
// SQL wrote into them, so they are parsed (the one parse, rare).
function withPersistedStats(state, result) {
    const row = result?.row;
    if (!state || !row) return state;
    try {
        const stats = typeof row.statsJson === 'string' ? JSON.parse(row.statsJson) : withEconomyLeaf(state.stats, row.economyCommit);
        if (!stats || typeof stats !== 'object') return state;
        // The row's revisions (Database.stateRevisions) ride on the state, so
        // readers of the cached state ask whether the bag or the kit moved.
        // Its updatedAt too: a settlement merged inside the commit moves it past
        // the worker's clock, and a command checkpoint built from the cache
        // must match the row (L127: stale_command loop).
        const persisted = { ...state, ...Database.stateRevisions(row), name: row.characterName || state.name, stats,
            updatedAt: Number(row.updatedAt) || Number(state.updatedAt || 0) };
        // Board settlements, drops and native party payments can all change
        // the bag after the proposed state: continue with the committed bag.
        if (!result.settled && !result.pkDrops?.length && !result.partyPayment) return persisted;
        return { ...persisted, adena: Number(row.adena || 0), inventory: JSON.parse(row.inventorySummary || '{}') };
    } catch (_) {
        return state;
    }
}

function reflect(result, committedState = null) {
    if (!result?.ok || !result.characterId) return result;
    if (result.memorySnapshots?.length) {
        const memory = invoke('GameServer/Social/InteractionMemoryRuntime');
        result.memorySnapshots.forEach(snapshot => memory.accept(snapshot));
    }
    const BotLifeState = invoke('GameServer/Bot/Population/BotLifeState');
    BotLifeState.acceptSimulationOwnership(result.characterId, result, committedState);
    if (result.pkDrops?.length) {
        const row = result.row;
        require('../../Actor/Generics/PkDeathDrop').spawn(result.characterId,
            { locX: row.locX, locY: row.locY, locZ: row.locZ }, result.pkDrops);
    }
    return result;
}

function reflectRecovery(result = {}) {
    const BotLifeState = invoke('GameServer/Bot/Population/BotLifeState');
    (result.rows || []).forEach((row) => BotLifeState.acceptSimulationOwnership(row.characterId, {
        ownerId: row.simulationOwner,
        revision: row.simulationRevision,
        leaseId: row.simulationLeaseId,
        leaseUntil: row.simulationLeaseUntil
    }));
    return result;
}

function claim(state, options = {}) {
    const partition = eligibility(state, options);
    if (!partition.ok) {
        DiagnosticConfig.developerDiagnostics && Metrics().recordColdOwnerRejected(partition.reason);
        return Promise.resolve(partition);
    }
    const timestamp = Number(options.timestamp || Date.now());
    const leaseMs = Math.max(1000, Number(options.leaseMs || DEFAULT_LEASE_MS));
    const startedAt = DiagnosticConfig.developerDiagnostics ? Date.now() : 0;
    return Database.claimColdSimulationLease({
        characterId: Number(state.characterId),
        expectedRevision: ownership(state).revision,
        ownerId: OWNER_ID,
        leaseId: options.leaseId || leaseId(),
        timestamp,
        leaseUntil: timestamp + leaseMs,
        allowParty: options.allowParty === true,
        allowLifecycle: options.allowLifecycle === true
    }).then((result) => {
        DiagnosticConfig.developerDiagnostics && Metrics().recordColdOwnerClaim(result, Date.now() - startedAt);
        return reflect(result);
    }).catch(recordFailure);
}

function claimBatch(candidates = [], options = {}) {
    const timestamp = Number(options.timestamp || Date.now());
    const leaseMs = Math.max(1000, Number(options.leaseMs || DEFAULT_LEASE_MS));
    const rejected = [];
    const requests = [];
    (candidates || []).slice(0, 64).forEach((candidate) => {
        const state = candidate.state || candidate;
        const partition = eligibility(state, candidate.options || options);
        if (!partition.ok) {
            const result = { ...partition, characterId: Number(state?.characterId || candidate.characterId || 0) };
            DiagnosticConfig.developerDiagnostics && Metrics().recordColdOwnerRejected(result.reason);
            rejected.push(result);
            return;
        }
        requests.push({
            characterId: Number(state.characterId),
            expectedRevision: Number(candidate.expectedRevision ?? ownership(state).revision),
            ownerId: OWNER_ID,
            leaseId: candidate.leaseId || leaseId(),
            timestamp,
            leaseUntil: timestamp + leaseMs,
            allowParty: candidate.options?.allowParty === true || options.allowParty === true,
            allowLifecycle: candidate.options?.allowLifecycle === true || options.allowLifecycle === true
        });
    });
    if (!requests.length) return Promise.resolve({ grants: [], rejected });
    const startedAt = DiagnosticConfig.developerDiagnostics ? Date.now() : 0;
    return Database.claimColdSimulationLeases(requests).then((results) => {
        results.forEach((result) => {
            DiagnosticConfig.developerDiagnostics && Metrics().recordColdOwnerClaim(result, Date.now() - startedAt);
            if (result.ok) reflect(result);
        });
        return {
            grants: results.filter((result) => result.ok),
            rejected: [...rejected, ...results.filter((result) => !result.ok)]
        };
    }).catch(recordFailure);
}

function release(claimToken, options = {}) {
    if (!claimToken?.ok) {
        const result = { ok: false, reason: 'missing_claim' };
        DiagnosticConfig.developerDiagnostics && Metrics().recordColdOwnerRelease(result);
        return Promise.resolve(result);
    }
    return Database.releaseColdSimulationLease({
        characterId: Number(claimToken.characterId),
        expectedRevision: Number(claimToken.revision),
        ownerId: OWNER_ID,
        leaseId: claimToken.leaseId,
        timestamp: Number(options.timestamp || Date.now())
    }).then((result) => {
        DiagnosticConfig.developerDiagnostics && Metrics().recordColdOwnerRelease(result);
        return reflect(result);
    }).catch(recordFailure);
}

// Each entry commits on the revision its step started from (`revision`): the
// row takes it only while still far and at that revision.
function commitBatch(entries = [], options = {}) {
    const timestamp = Number(options.timestamp || Date.now());
    const requests = [];
    const states = new Map();
    const rejected = [];
    const accepted = [];
    const groupedEntries = new Map();
    (entries || []).slice(0, 32).forEach((entry) => {
        const nextState = entry.nextState;
        const partition = eligibility(nextState, entry.options || options);
        const groupId = entry.atomicGroup?.id ? String(entry.atomicGroup.id) : null;
        if (groupId) {
            const group = groupedEntries.get(groupId) || [];
            group.push(entry);
            groupedEntries.set(groupId, group);
        }
        const validRevision = Number.isSafeInteger(entry.revision) && entry.revision >= 0;
        if (!validRevision || !partition.ok) {
            rejected.push({
                ok: false,
                characterId: Number(nextState?.characterId || 0),
                reason: !validRevision ? 'invalid_revision' : 'partition_rejected',
                detail: !partition.ok ? partition.reason : undefined
            });
            return;
        }
        accepted.push({ entry, nextState, groupId });
    });

    const abortedGroups = new Map();
    groupedEntries.forEach((group, groupId) => {
        const expectedIds = new Set((group[0]?.atomicGroup?.memberIds || []).map(Number).filter(Boolean));
        const presentIds = new Set(group.map((entry) => Number(entry.nextState?.characterId)).filter(Boolean));
        const validIds = new Set(accepted
            .filter((candidate) => candidate.groupId === groupId)
            .map((candidate) => Number(candidate.nextState?.characterId))
            .filter(Boolean));
        const complete = expectedIds.size > 0
            && expectedIds.size === presentIds.size
            && [...expectedIds].every((id) => presentIds.has(id));
        if (!complete || validIds.size !== presentIds.size) {
            abortedGroups.set(groupId, !complete ? 'party_group_incomplete' : 'party_group_invalid');
        }
    });

    accepted.forEach(({ entry, nextState, groupId }) => {
        if (groupId && abortedGroups.has(groupId)) {
            rejected.push({
                ok: false,
                characterId: Number(nextState.characterId),
                reason: 'party_group_aborted',
                detail: abortedGroups.get(groupId)
            });
            return;
        }
        const canonicalInventory = InventorySummary.canonicalize(nextState.inventory);
        const canonicalState = { ...nextState, inventory: canonicalInventory };
        states.set(Number(nextState.characterId), canonicalState);
        const previousInventory = InventorySummary.canonicalize(entry.proposal?.baseState?.inventory);
        const inventorySummary = JSON.stringify(canonicalInventory);
        const inventoryChanged = JSON.stringify(previousInventory) !== inventorySummary;
        // The physical writer needs explicit removals even though persisted
        // summaries omit empty stacks. Only remove items owned by this proposal.
        const physicalInventory = { ...canonicalInventory };
        Object.entries(previousInventory).forEach(([key, item]) => {
            if (!canonicalInventory[key]) physicalInventory[key] = { ...item, amount: 0 };
        });
        requests.push({
            characterId: Number(nextState.characterId),
            expectedRevision: entry.revision,
            timestamp,
            patch: persistencePatch(canonicalState, timestamp, inventorySummary),
            // The partition and the death record read these instead of parsing the patch's statsJson.
            stats: canonicalState.stats || {},
            physical: {
                level: Number(nextState.level || 1),
                exp: Number(nextState.exp || 0),
                sp: Number(nextState.sp || 0),
                hp: Number(nextState.vitals?.hp || 0),
                maxHp: Number(nextState.vitals?.maxHp || 0),
                mp: Number(nextState.vitals?.mp || 0),
                maxMp: Number(nextState.vitals?.maxMp || 0),
                ...(entry.proposal?.durable?.classId !== undefined ? {
                    classId: Number(entry.proposal.durable.classId)
                } : {}),
                ...(entry.proposal?.durable?.pvpKills ? { pvpKills: entry.proposal.durable.pvpKills } : {}),
                ...(entry.proposal?.durable?.soulCrystals?.length ? { soulCrystals: entry.proposal.durable.soulCrystals } : {}),
                ...(inventoryChanged ? { inventory: physicalInventory } : {})
            },
            allowParty: entry.options?.allowParty === true || options.allowParty === true,
            allowLifecycle: entry.options?.allowLifecycle === true || options.allowLifecycle === true,
            atomicGroup: entry.atomicGroup || null,
            journalReason: entry.journalReason || options.journalReason || null,
            ...(entry.proposal?.result?.memoryEvents ? { memoryEvents: entry.proposal.result.memoryEvents } : {}),
            ...(entry.lifeEvents ? { lifeEvents: entry.lifeEvents } : {})
        });
    });
    if (!requests.length) return Promise.resolve(rejected);
    const startedAt = DiagnosticConfig.developerDiagnostics ? Date.now() : 0;
    return Database.commitAndReleaseColdSimulationLeases(requests).then((results) => {
        results.forEach((result) => {
            DiagnosticConfig.developerDiagnostics && Metrics().recordColdOwnerCommit(result, Date.now() - startedAt);
            if (result.ok) {
                DiagnosticConfig.developerDiagnostics && Metrics().recordColdOwnerRelease({ ok: true });
                const state = states.get(Number(result.characterId));
                reflect(result, withPersistedStats(state, result));
            }
        });
        return [...results, ...rejected];
    }).catch(recordFailure);
}

function releaseBatch(tokens = [], options = {}) {
    const timestamp = Number(options.timestamp || Date.now());
    const requests = (tokens || []).slice(0, 64).filter((token) => token?.ok).map((token) => ({
        characterId: Number(token.characterId),
        expectedRevision: Number(token.revision),
        ownerId: OWNER_ID,
        leaseId: token.leaseId,
        releaseInvalidated: options.releaseInvalidated === true,
        timestamp
    }));
    if (!requests.length) return Promise.resolve([]);
    return Database.releaseColdSimulationLeases(requests).then((results) => {
        results.forEach((result) => {
            DiagnosticConfig.developerDiagnostics && Metrics().recordColdOwnerRelease(result);
            if (result.ok) reflect(result);
        });
        return results;
    }).catch(recordFailure);
}

function renewActiveLeases(tokens = [], options = {}) {
    return Database.renewColdSimulationLeases(tokens, options).then((results) => {
        results.forEach((result) => {
            if (!result.ok) { DiagnosticConfig.developerDiagnostics && Metrics().recordColdOwnerRejected(result.reason); return; }
            const cached = invoke('GameServer/Bot/Population/BotLifeState').cachedState(result.characterId);
            const current = cached?.simulation;
            if (cached?.phase === 'cold' && current?.ownerId === result.ownerId && current.revision === result.revision
                && current.leaseId === result.leaseId && options.canRenew(result) === true) reflect(result);
        });
        return results;
    }).catch(recordFailure);
}

function handoffToMain(state, options = {}) {
    if (!state?.characterId) return Promise.resolve({ ok: false, reason: 'missing_state' });
    const stateOwnership = state.simulation;
    const nextState = options.nextState || null;
    const timestamp = Number(options.timestamp || Date.now());
    return Database.handoffColdSimulationToMain({
        characterId: Number(state.characterId),
        expectedRevision: stateOwnership ? Number(stateOwnership.revision || 0) : null,
        timestamp,
        allowParty: options.allowParty === true,
        allowLifecycle: options.allowLifecycle === true,
        ...(nextState ? { patch: persistencePatch(nextState, timestamp) } : {})
    }).then((result) => {
        DiagnosticConfig.developerDiagnostics && Metrics().recordColdOwnerHandoff(result);
        return reflect(result, nextState);
    }).catch(recordFailure);
}

function recoverExpiredLeases(timestamp = Date.now()) {
    if (!Database.isReady()) return Promise.resolve({ affectedRows: 0, rows: [] });
    return Database.recoverColdSimulationLeases({ timestamp, includeActive: false }).then((result) => {
        DiagnosticConfig.developerDiagnostics && Metrics().recordColdOwnerRecovery(result.affectedRows, false);
        return reflectRecovery(result);
    }).catch(recordFailure);
}

function recoverStartupLeases() {
    if (!Database.isReady()) return Promise.resolve({ affectedRows: 0, rows: [] });
    return Database.recoverColdSimulationLeases({ includeActive: true }).then((result) => {
        DiagnosticConfig.developerDiagnostics && Metrics().recordColdOwnerRecovery(result.affectedRows, true);
        return reflectRecovery(result);
    }).catch(recordFailure);
}

module.exports = {
    OWNER_ID,
    LEGACY_OWNER_ID,
    DEFAULT_LEASE_MS,
    SIMPLE_ACTIVITIES,
    LEGACY_PLAN_STRATEGIES,
    eligibility,
    ownership,
    persistencePatch,
    claim,
    claimBatch,
    commitBatch,
    release,
    releaseBatch,
    renewActiveLeases,
    handoffToMain,
    recoverExpiredLeases,
    recoverStartupLeases
};
