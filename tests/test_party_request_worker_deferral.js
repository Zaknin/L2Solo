'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const world = require('./fixtures/native_stock_world')();
require('../src/Global');
const DB = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const Request = require('../src/GameServer/Bot/Population/PartyRequestPlanner');
const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const at = Date.now(), snapshots = [], originalDirty = Coordinator.markDirty;
const kernel = new ColdSimulationKernel({ now: () => at, resolveSolo: () => { throw Error('no combat in this fixture'); } });
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
let sequence = 0;
async function seed(age = 0, extra = {}) {
    const username = `bot_deferral_${++sequence}`;
    await DB.createAccount(username, 'fixture');
    const id = Number((await DB.createCharacter(username, { name: `Deferred${sequence}`, classId: 14,
        race: 0, sex: 0, face: 0, hair: 0, hairColor: 0, maxHp: 100, maxMp: 100,
        locX: 0, locY: 0, locZ: 0 })).insertId);
    await DB.execute(['UPDATE characters SET level=57,hp=100,mp=100 WHERE id=?', [id]]);
    const state = await Life.upsertState({ characterId: id, name: `Deferred${sequence}`, accountName: username,
        phase: 'cold', activity: 'party_wait', level: 57, spotId: 'old-source', loc: { locX: 0, locY: 0, locZ: 0 },
        inventory: {}, vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, timing: {}, stats: { classId: 14,
            equipmentPlan: { status: 'active', target: { selfId: 148, slot: 7 } },
            partyRequest: { materialParty: true, status: 'open', priority: 'required', reason: 'craft_material',
                itemId: 4108, targetId: 148, requiredTotal: 12, amount: 12, spotId: 'old-source',
                objectiveKey: 'craft-material:old-source', npcId: 620, attempts: 2, requestedAt: at - age, ...extra } } }, 'deferral_fixture');
    await flush();
    kernel.upsert({ state, context: {} });
    return state;
}
async function rowFor(id) { return (await DB.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [id]]))[0]; }
async function checkDeferred(old, reason) {
    await flush();
    const row = await rowFor(old.characterId), cached = Life.cachedState(old.characterId);
    const request = JSON.parse(row.statsJson).partyRequest;
    assert.equal(request.status, 'deferred');
    assert.equal(request.attempts, 3);
    assert(request.deferredUntil > at);
    assert.equal(cached.simulation.revision, old.simulation.revision + 1, 'native deferral fences an in-transit stale claim');
    assert.equal(row.simulationRevision, cached.simulation.revision);
    assert.deepEqual(cached.stats.partyRequest, request, 'cache accepts the exact committed request');
    assert(snapshots.some(packet => packet.state === cached && packet.options.critical && packet.options.reason === 'party_request_deferred'),
        'the worker receives a critical snapshot, without waiting for a population refresh');
    const workerState = kernel.states.get(old.characterId).state;
    assert.deepEqual(workerState.stats.partyRequest, request);
    const Material = require('../src/GameServer/Bot/Population/CraftMaterialParty'), originalRequest = Material.request;
    Material.request = () => ({ ...request, status: 'open', spotId: 'rotated-source', objectiveKey: 'craft-material:rotated-source' });
    try {
        const planned = Request.partyRequestForPlan(workerState, workerState.stats.equipmentPlan, at + 2,
            { economy: { worth: () => 0 } });
        assert.equal(planned.status, 'deferred', 'worker planning cannot bypass the published pause by rotating sources');
        assert.equal(planned.deferredUntil, request.deferredUntil);
        assert.equal(planned.attempts, request.attempts);
    } finally { Material.request = originalRequest; }
    const claim = await DB.claimColdSimulationLease({ characterId: old.characterId, expectedRevision: old.simulation.revision,
        allowLifecycle: true, ownerId: 'cold_simulation_owner', leaseId: `stale-${old.characterId}`, timestamp: at + 1, leaseUntil: at + 30000 });
    assert.equal(claim.ok, false);
    assert.equal(claim.reason, 'stale_revision');
    if (reason) assert.equal(request.lastReason, reason);
    return cached;
}
async function main() {
    DB.init(); invoke('GameServer/DataCache').init(); await Life.init();
    Coordinator.markDirty = (state, options) => { snapshots.push({ state, options }); kernel.upsert({ state, context: {} }); };
    const incompatible = await seed(), claimed = await seed();
    const grant = await DB.claimColdSimulationLease({ characterId: claimed.characterId, expectedRevision: claimed.simulation.revision,
        allowLifecycle: true, ownerId: 'cold_simulation_owner', leaseId: 'active-request', timestamp: at, leaseUntil: at + 30000 });
    assert(grant.ok);
    snapshots.length = 0;
    assert.equal(JSON.parse((await rowFor(claimed.characterId)).statsJson).partyRequest.status, 'open', 'an active worker lease is untouched');
    assert.equal(await Life.deferUnformablePartyRequests([incompatible.characterId, claimed.characterId]), 1);
    await checkDeferred(incompatible, 'no_compatible_level_match');
    assert.equal(await Life.deferUnformablePartyRequests([incompatible.characterId]), 0, 'one rejection increments attempts exactly once');

    // Native data can change after the preliminary pending-write lookup. Only
    // RETURNING may supply the cache/worker publication, never that old SELECT.
    const raced = await seed(), originalExecute = DB.execute;
    let injected = false;
    DB.execute = async (statement, ...args) => {
        const rows = await originalExecute.call(DB, statement, ...args);
        if (!injected && statement[0].startsWith('SELECT characterId FROM bot_life_state') && statement[1].includes(raced.characterId)) {
            injected = true;
            await originalExecute.call(DB, ["UPDATE bot_life_state SET statsJson=json_set(statsJson, '$.partyRequest.attempts', 7, '$.partyRequest.spotId', 'new-source', '$.nativeMarker', 123) WHERE characterId=?", [raced.characterId]]);
        }
        return rows;
    };
    try { assert.equal(await Life.deferUnformablePartyRequests([raced.characterId]), 1); }
    finally { DB.execute = originalExecute; }
    await flush();
    const fresh = Life.cachedState(raced.characterId);
    assert.equal(fresh.stats.partyRequest.attempts, 8);
    assert.equal(fresh.stats.partyRequest.spotId, 'new-source');
    assert.equal(fresh.stats.nativeMarker, 123);
    assert.deepEqual(kernel.states.get(raced.characterId).state.stats.partyRequest, fresh.stats.partyRequest);
    console.log('PASS both native request deferrals publish exact critical worker snapshots, advance revision and reject stale claims; active leases and concurrent native edits survive');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    Coordinator.markDirty = originalDirty;
    await world.close();
});
