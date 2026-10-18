// The room at a spot is checked once, when a far bot's trip ends there, in the
// background thread, against the bots that stand on the spot (ARCH-08-a).
// A full spot leaves the bot standing there with a "was full" mark that its
// next step's spot search reads; bots still on their way do not count; a safety
// evacuation may exceed the spot by one bot; a party is checked as a whole.
const assert = require('node:assert/strict');
const path = require('node:path');
require('../src/Global');
const { Worker } = require('node:worker_threads');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const root = path.resolve(__dirname, '..');

// Runs inside the worker: a solo trip started by the real trip builder,
// resolved by the real resolver at its arrival, projected by the kernel's
// projectResolve; a party arrival through the kernel's partyArrival option.
const observer = String.raw`
const Risk = invoke('GameServer/Bot/Population/SpotRiskPolicy');
const PartyRisk = require('./PartySpotRiskPolicy');
const Sections = invoke('GameServer/Bot/Economy/DecisionSections');
const bits = () => ({ occupation: Sections.sectionBit('occupation'), sources: Sections.sectionBit('sources') });
// The step's one raise (BotLifeState.prepareResolve): the sections its cheap
// check named, in the bump the step's own decision point then reads.
const Events = require('../AI/DecisionEvents'), raise = Events.raiseSections;
let raised = null;
Events.raiseSections = (before, after, ...lists) => {
    if (lists.length === 3) raised = [...lists[2]];
    return raise(before, after, ...lists);
};
module.exports.probe = async ({ kind, id, spotId, reason, remove, party }) => {
    for (const gone of remove || []) kernel.remove(gone);
    if (kind === 'party') {
        const members = party.memberIds.map(member => kernel.states.get(member).state);
        const out = kernel.partyArrival({ party, members, spotId });
        if (!out) return null;
        const dirty = out.members.map(member => Number(member.stats?.wishDirty || 0));
        return { excluded: [...PartyRisk.excludedSpotIds(out.party)], dirty, bits: bits() };
    }
    const { beginHuntingTrip } = require('./HuntingTravel');
    const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');
    const entry = kernel.states.get(id), now = Date.now();
    const to = { locX: 50000, locY: -176000, locZ: -1000 };
    const traveling = beginHuntingTrip(entry.state, { needed: true, mode: 'solo', spotId, regionName: 'Room',
        to, destinations: { [id]: to }, travelMs: 1000, reason }, now - 5000);
    const result = BackgroundResolver.resolveSolo({ state: traveling, timestamp: now });
    raised = null;
    const projected = (await kernel.projectResolve(traveling, result, now)).state;
    const next = { ...projected, stats: { ...projected.stats, stepCount: Risk.stepCount(projected) + 1 } };
    return { activity: projected.activity, spotId: projected.spotId, before: Risk.stepCount(traveling),
        marks: projected.stats.capacityBackoffs || [], raised,
        seq: [Number(traveling.stats.decisionSeq || 0), Number(projected.stats.decisionSeq || 0)],
        excludedNow: [...Risk.excludedSpotIdsForStates([projected])],
        excludedAfter: [...Risk.excludedSpotIdsForStates([next])] };
};`;
const wrapper = String.raw`
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const { parentPort, workerData } = require('node:worker_threads');
const loaded = new Module(workerData.workerPath, module);
loaded.filename = workerData.workerPath; loaded.paths = Module._nodeModulePaths(path.dirname(workerData.workerPath));
loaded._compile(fs.readFileSync(workerData.workerPath, 'utf8') + workerData.observer, workerData.workerPath);
parentPort.on('message', message => {
    if (!message.probe) return;
    loaded.exports.probe(message.probe).then(value => parentPort.postMessage({ probeId: message.msgId, value }))
        .catch(error => parentPort.postMessage({ probeId: message.msgId, error: error.stack }));
});`;

const room = { id: 'room-at-arrival', name: 'Room at arrival', center: { locX: 50000, locY: -176000, locZ: -1000 },
    minLevel: 18, maxLevel: 24, avgLevel: 21, density: 12, capacity: 2, levelCounts: { 20: 6 } };
const away = { ...room, id: 'room-away', name: 'Away field', center: { locX: 20000, locY: -176000, locZ: -1000 }, capacity: 20 };

function bot(characterId, extra = {}) {
    const now = Date.now();
    return { characterId, name: `Room${characterId}`, accountName: `bot_room_${characterId}`, phase: 'cold',
        activity: 'hunting', level: 20, exp: 0, sp: 0, adena: 1000, currentRegion: away.name, spotId: away.id,
        loc: { ...away.center }, inventory: {}, vitals: { hp: 1000, maxHp: 1000, mp: 500, maxMp: 500 },
        stats: { classId: 0, classProgressionClassId: 0, classProgressionLevel: 20, generatedCold: true, stepCount: 7 },
        timing: { lastResolvedAt: now - 10000, nextResolveAt: now + 600000 }, ...extra };
}

(async () => {
    invoke('GameServer/DataCache').init();
    const epoch = 'native:room-at-arrival', messages = [];
    let fault;
    const worker = new Worker(wrapper, { eval: true, workerData: { workerEpoch: epoch,
        workerPath: root + '/src/GameServer/Bot/Population/ColdSimulationWorker.js', observer } });
    try {
        worker.on('message', message => messages.push(message));
        worker.on('error', error => { fault = error; });
        const wait = async predicate => {
            const deadline = Date.now() + 60000;
            while (!messages.some(predicate)) {
                if (fault) throw fault;
                const rejected = messages.find(message => message.type === 'fault');
                if (rejected) throw Error(JSON.stringify(rejected));
                if (Date.now() > deadline) throw Error('room at arrival worker timeout');
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            return messages.find(predicate);
        };
        const send = (type, payload, msgId) => worker.postMessage(Protocol.envelope(type, epoch, payload, msgId));
        let probes = 0;
        const probe = async input => {
            const msgId = `probe-${++probes}`;
            worker.postMessage({ ...Protocol.envelope('pause', epoch, {}, msgId), probe: input });
            const response = await wait(message => message.probeId === msgId);
            if (response.error) throw Error(response.error);
            return response.value;
        };
        await wait(message => message.type === 'ready' && message.payload.phase === 'loaded');
        send('catalog_page', { catalog: 'npc_offers', rows: [], done: true });
        send('catalog_page', { catalog: 'spots', rows: [room, away] });
        send('init', { config: { loopIntervalMs: 1000 }, recomputeGeneration: { code: 'a'.repeat(40), config: 'b'.repeat(64) } }, 'init');
        await wait(message => message.type === 'ready' && message.payload.phase === 'running');
        send('pause', {}, 'pause');
        send('table_page', { tables: [{ name: 'board', from: null, to: 0, full: true, rows: [], removed: [], last: true },
            { name: 'market', from: null, to: 0, full: true, rows: [], removed: [], last: true },
            { name: 'personal_warehouse', from: null, to: 0, full: true, rows: [], removed: [], last: true }] });
        const standing = id => bot(id, { spotId: room.id, currentRegion: room.name, loc: { ...room.center } });
        // On its way to the spot: indexed there, not standing there.
        const onTheWay = bot(103, { activity: 'traveling', stats: { ...bot(103).stats,
            travel: { spotId: room.id, reason: 'level_replan', to: { ...room.center }, arrivalAt: Date.now() + 600000 } } });
        const rows = [standing(101), standing(102), onTheWay, bot(104), bot(110), bot(111)];
        send('snapshot_page', { rows: rows.map(state => ({ state, context: { buyOrderEscrow: 0 } })), ack: true }, 'state');
        await wait(message => message.type === 'ready' && message.msgId === 'state');

        // Two bots stand on a spot of two places: the arriving bot finds it full.
        const full = await probe({ kind: 'solo', id: 104, spotId: room.id, reason: 'level_replan' });
        assert.equal(full.activity, 'hunting', 'the bot arrives and stands on the full spot until its next step');
        assert.equal(full.spotId, room.id);
        assert.deepEqual(full.marks.map(mark => mark.spotId), [room.id], 'the full spot gets the "was full" mark');
        assert.equal(full.marks[0].untilStep, full.before + 1 + 1, 'the mark is counted from the step before its +1');
        assert.deepEqual(full.raised, ['occupation', 'sources'],
            'the full spot raises occupation and sources in the step\'s one bump');
        assert(full.seq[1] > full.seq[0], 'the raise moves the decision sequence');
        assert(full.excludedNow.includes(room.id), 'the next step\'s spot search skips the full spot');
        assert(!full.excludedAfter.includes(room.id), 'the mark lapses after that step');

        // A safety evacuation may exceed a full spot by one bot.
        const evacuation = await probe({ kind: 'solo', id: 104, spotId: room.id, reason: 'unsafe_ground_evacuation' });
        assert.deepEqual(evacuation.marks, [], 'an evacuation takes the one overflow place');

        // One bot stands there and one is on its way: the arriving bot takes the free place.
        const free = await probe({ kind: 'solo', id: 104, spotId: room.id, reason: 'level_replan', remove: [102] });
        assert.deepEqual(free.marks, [], 'a bot on its way to the spot does not count against it');
        assert.deepEqual(free.raised, [], 'an arrival into room raises nothing');

        // A party of two arrives where one bot stands: no room for all its members.
        const party = { partyId: 'room-party', leaderId: 110, memberIds: [110, 111], spotId: room.id, stats: {} };
        const crowded = await probe({ kind: 'party', spotId: room.id, party });
        assert(crowded, 'a party is checked as a whole');
        assert(crowded.excluded.includes(room.id), 'the party\'s next spot search skips the full spot');
        assert(crowded.dirty[0] & crowded.bits.occupation && crowded.dirty[0] & crowded.bits.sources,
            'the leader\'s next step reconsiders the spot');
        assert.equal(crowded.dirty[1], 0, 'a member\'s own arrival is not checked');
        assert.equal(await probe({ kind: 'party', spotId: room.id, party, remove: [101] }), null,
            'a party that fits the spot arrives without a mark');
        console.log('Room at arrival checks passed');
    } finally { await worker.terminate(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
