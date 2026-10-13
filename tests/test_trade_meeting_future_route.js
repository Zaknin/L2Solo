'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.env.L2NODE_CONFIG_FILE = 'config/default.ini';
require('../src/Global');
const path = require('node:path'), { Worker } = require('node:worker_threads');
const Data = invoke('GameServer/DataCache'); Data.init();
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const { npcPlanningCatalogRows } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const spots = invoke('GameServer/Bot/Population/SpotProfiles').ensure();
const Town = invoke('GameServer/Bot/Economy/MarketTownPolicy');
const village = Town.NO_GRADE_MARKETS.find(row => row.name === 'Elven Village');
const spot = spots.filter(row => row.center).sort((a, b) =>
    Math.hypot(a.center.locX - village.locX, a.center.locY - village.locY)
    - Math.hypot(b.center.locX - village.locX, b.center.locY - village.locY))[0];
assert(spot);
const now = Date.now(), id = 710051;
const state = { characterId: id, name: 'OriginSeller', level: 20, exp: Number(Data.experience[19]), sp: 0,
    adena: 1000000, phase: 'cold', activity: 'hunting', currentRegion: 'Giran', spotId: String(spot.id), updatedAt: now,
    loc: { locX: 83396, locY: 147904, locZ: -3400 },
    vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
    inventory: invoke('GameServer/Bot/Population/BotLifeState').inventorySummaryFromItems([
        { id: 710101, selfId: 1, amount: 1, equipped: 1, slot: 7 },
        { id: 710102, selfId: 1869, amount: 1000000, equipped: 0, slot: 0 },
        { id: 710103, selfId: 1870, amount: 1000000, equipped: 0, slot: 0 }]),
    stats: { classId: 0, generatedCold: true, classProgressionClassId: 0, classProgressionLevel: 20 },
    timing: { lastResolvedAt: now - 1000, nextResolveAt: now + 60000 } };
const observer = String.raw`
module.exports.meetingPrepareProbe = async id => {
    const state = kernel.states.get(id).state, authority = require('../Economy/EconomyCommit').authority(state);
    boardIndex.put({ id: 710057, kind: 'sell_ad', storeType: 1, ownerId: id+1, botOwned: true, town: 'Giran', revision: 1, custodyPolicy: 1, lines: [{ id: 710058, selfId: 48, enchant: 0, count: 1, price: 1 }] });
    const request = { token: 'actual-meeting-prepare', actorA: id, actorB: id+1, seqA: 0, seqB: 0,
        town: 'Giran', point: { locX: 83396, locY: 147904, locZ: -3400 },
        parties: [0,1].map(() => ({ ...authority, sequence: 0, needRevision: authority.revision,
            route: { fee: 0, scroll: false, method: 'walk', durationMs: 0 } })),
        lines: [{ payer: 1, itemId: 710102, selfId: 1869, enchant: 0, count: 1, price: 100,
            adId: 710052, adRevision: 1, certificate: null }] };
    const result = await kernel.prepareMeeting(id, request);
    const previous = { activity: state.activity, travel: state.stats.travel };
    const Heine = require('../../World/TownRespawn').towns.innadril_town;
    let future;
    try {
        state.activity = 'traveling'; state.stats.travel = { to: Heine, arrivalAt: Date.now() + 1000,
            arrivalActivity: 'hunting', reason: 'return_after_market' };
        const next = JSON.parse(JSON.stringify(request)); next.token = 'meeting-after-return';
        future = JSON.parse(JSON.stringify(await kernel.prepareMeeting(id, next)));
        const expected = invoke('GameServer/Bot/Population/ColdTrip').townPlan({ ...state, loc: Heine }, request.point);
        if (!(expected.route.fee > 0) || future.parties[0].route.fee !== expected.route.fee)
            throw Error('meeting_future_fare_not_reserved');
    } finally { state.activity = previous.activity; state.stats.travel = previous.travel; }
    return { result, future, forbiddenLoaded: Object.keys(require.cache).filter(key => /\/Database\.js$|\/Network\/|\/World\/World\.js$/.test(key)) };
};`;
const wrapper = String.raw`
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const { parentPort, workerData } = require('node:worker_threads');
const loaded = new Module(workerData.workerPath, module);
loaded.filename = workerData.workerPath; loaded.paths = Module._nodeModulePaths(path.dirname(workerData.workerPath));
loaded._compile(fs.readFileSync(workerData.workerPath, 'utf8') + workerData.observer, workerData.workerPath);
parentPort.on('message', message => {
    if (!message.meetingPrepareProbe) return;
    loaded.exports.meetingPrepareProbe(message.meetingPrepareProbe).then(value => parentPort.postMessage({ probeId: message.msgId, value }))
        .catch(error => parentPort.postMessage({ probeId: message.msgId, error: error.stack }));
});`;
(async () => {
    const epoch = 'native:meeting-prepare', messages = []; let fault;
    const worker = new Worker(wrapper, { eval: true, workerData: { workerEpoch: epoch, observer,
        workerPath: path.resolve(__dirname, '../src/GameServer/Bot/Population/ColdSimulationWorker.js') } });
    worker.on('message', message => messages.push(message)); worker.on('error', error => { fault = error; });
    const wait = async predicate => { const deadline = Date.now() + 60000;
        while (!messages.some(predicate)) { if (fault) throw fault;
            const rejected = messages.find(message => message.type === 'fault'); if (rejected) throw Error(JSON.stringify(rejected));
            if (Date.now() > deadline) throw Error('native market origin timeout');
            await new Promise(resolve => setTimeout(resolve, 10)); }
        return messages.find(predicate); };
    const send = (type, payload, msgId) => worker.postMessage(Protocol.envelope(type, epoch, payload, msgId));
    try {
        await wait(message => message.type === 'ready' && message.payload.phase === 'loaded');
        const catalog = npcPlanningCatalogRows();
        for (let at = 0; at < catalog.length; at += Protocol.MAX_BATCH) send('catalog_page', { catalog: 'npc_offers',
            rows: catalog.slice(at, at + Protocol.MAX_BATCH), done: at + Protocol.MAX_BATCH >= catalog.length });
        for (let at = 0; at < spots.length; at += Protocol.MAX_BATCH) send('catalog_page', { catalog: 'spots',
            rows: spots.slice(at, at + Protocol.MAX_BATCH) });
        send('init', { config: { loopIntervalMs: 1000 } }, 'init');
        await wait(message => message.type === 'ready' && message.payload.phase === 'running'); send('pause', {}, 'pause');
        send('table_page', { tables: [{ name: 'board', from: null, to: 0, full: true,
            rows: [[710052, [710052, 'sell_ad', 1, id, 'Giran', 1, [[710053, 1869, 0, 1000, 100, null, 0]], 1]]],
            removed: [], last: true }] });
        send('snapshot_page', { rows: [{ state, context: {} }], ack: true }, 'state');
        await wait(message => message.type === 'ready' && message.msgId === 'state');
        worker.postMessage({ ...Protocol.envelope('pause', epoch, {}, 'probe'), meetingPrepareProbe: id });
        const response = await wait(message => message.probeId === 'probe'); if (response.error) throw Error(response.error);
        assert.equal(response.value.result.token, 'actual-meeting-prepare');
        assert(response.value.result.dependencies.length <= 40);
        assert.equal(response.value.result.parties[0].route.fee, 0);
        assert(response.value.future.parties[0].route.fee > 0,
            'real bilateral preparation reserves departure from the paid return destination');
        assert.deepEqual(response.value.forbiddenLoaded, []);
        console.log('PASS actual worker meeting route from the end of the paid return trip');
    } finally { await worker.terminate(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
