'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Worker } = require('node:worker_threads');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'economy-context-publication-'));
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.env.L2NODE_CONFIG_FILE = path.join(directory, 'default.ini');
fs.writeFileSync(process.env.L2NODE_CONFIG_FILE, `[Database]\npath=${directory}/world.sqlite\nhistoryPath=${directory}/history.sqlite\n`);
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const Generation = require('../src/GameServer/Bot/Population/RecomputeGeneration');
// A context holds only by its event proof, which needs the warehouse rows
// and a recompute generation; without them every request builds anew.
invoke('GameServer/Bot/Economy/PersonalWarehouseIndex').useRowSource(() => null, () => true);
Generation.configure({ code: '1'.repeat(40), config: '2'.repeat(64) });
const timestamp = 1e12;
const deps = { board: new BoardIndex(), spots: invoke('GameServer/Bot/Population/SpotProfiles').ensure(), timestamp };
function state(id) {
    return { characterId: id, updatedAt: timestamp, level: 20, phase: 'cold', activity: 'resting', adena: 100,
        stats: { classId: 1 }, inventory: { 1: { selfId: 1, amount: 1, equipped: true, slot: 7 } },
        currentRegion: 'Giran', timing: { nextResolveAt: timestamp + 3600000 },
        simulation: { ownerId: 'legacy_main', revision: 2, leaseId: null, leaseUntil: 0 },
        loc: { locX: 80000, locY: 148000, locZ: -3500 }, vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 } };
}
function visible(context) {
    return { key: context.inputKey, packet: context.statsPacket, activity: context.network.activity,
        queue: context.network.queue, watch: context.watchList, stock: context.stock('shots'),
        budget: context.purchaseBudget(1), usefulness: context.itemUsefulness(1) };
}
function mainPublication() {
    Economy.reset();
    const original = state(901), first = Economy.forState(original, deps);
    // The bot publishes the build's decision; a later snapshot carries it.
    const cloned = structuredClone({ ...original, stats: { ...original.stats, ...first.statsPacket } }); cloned.updatedAt++;
    const replaced = Economy.forState(cloned, deps);
    assert.strictEqual(replaced.plan, first.plan, 'main actor snapshots retain their existing economic input cache contract');
    assert.deepEqual(visible(replaced), visible(first), 'same economic facts retain exactly the native decision');
    assert.strictEqual(Economy.forState(cloned, deps).plan, replaced.plan, 'same canonical state still caches');

    const kernel = new ColdSimulationKernel({ resolveSolo: () => null, now: () => timestamp });
    const members = [state(911), state(912), state(913), state(914)];
    members.forEach(bot => kernel.upsert({ state: bot }));
    const group = Economy.forGroup({ id: 'publication-a', adena: 200 }, members.slice(0, 2), deps);
    const unaffected = Economy.forGroup({ id: 'publication-b', adena: 200 }, members.slice(2), deps);
    const before = Profile.size().ownerBuilds;
    // Losing the copy is not a reason to rebuild: the group key holds the
    // wallet and every member's input key, so it alone decides a hit.
    kernel.upsert({ state: structuredClone(members[0]), context: { route: null } });
    const published = kernel.states.get(911).state;
    assert.notStrictEqual(published, members[0]);
    assert.equal(Economy.size().groups, 2, 'a publication alone evicts no group');
    assert.strictEqual(Economy.forGroup({ id: 'publication-a', adena: 200 }, [published, members[1]], deps), group,
        'a republished member with unchanged inputs keeps the group');
    assert.strictEqual(Economy.forGroup({ id: 'publication-b', adena: 200 }, members.slice(2), deps), unaffected);
    assert.equal(kernel.upsert({ state: { ...published, level: 21 }, context: { route: null } }), true);
    const moved = kernel.states.get(911).state;
    const regrouped = Economy.forGroup({ id: 'publication-a', adena: 200 }, [moved, members[1]], deps);
    assert.notStrictEqual(regrouped, group, 'a member whose inputs changed misses the group by key');
    assert.notEqual(regrouped.inputKey, group.inputKey);
    assert.equal(Economy.size().groups, 2, 'the rebuilt group replaces its own entry');
    assert.equal(Profile.size().ownerBuilds, before, 'context invalidation preserves native build gains');
    const current = kernel.states.get(911).state;
    const rebuilt = Economy.forState(current, deps);
    assert.strictEqual(rebuilt.state, current); assert.notStrictEqual(rebuilt, group);
    // The bot publishes the rebuilt decision; the published state holds it.
    assert.equal(kernel.upsert({ state: { ...current, stats: { ...current.stats, ...rebuilt.statsPacket } },
        context: { route: null } }), true);
    const decided = kernel.states.get(911).state;
    assert.strictEqual(Economy.forState(decided, deps).plan, rebuilt.plan, 'the published decision holds');
    kernel.upsert({ state: decided, context: { fresh: true } });
    assert.strictEqual(Economy.forState(decided, deps).plan, rebuilt.plan, 'context-only routing changes preserve the same state cache');
    const stale = { ...decided, simulation: { ...decided.simulation, revision: 1 } };
    assert.equal(kernel.upsert({ state: stale, context: { stalePage: true } }), false);
    assert.strictEqual(Economy.forState(decided, deps).plan, rebuilt.plan, 'rejected old snapshots do not evict the canonical context');
    kernel.remove(913);
    assert.equal(Economy.size().groups, 1, 'member removal releases its group even without party fields in its state');
    assert.equal(Profile.size().ownerBuilds, before - 1, 'actual removal still releases its build owner');
    for (const id of [911, 912, 914]) kernel.remove(id);
    Economy.forget(901);
    assert.deepEqual(Economy.size(), { context: 0, engine: 0, groups: 0 });
    console.log('PASS main actor cache contract, exact decision parity, group member release and preserved build cache');
}

const observer = String.raw`
const assert = require('node:assert/strict');
module.exports.publicationProbe = async stage => {
    const Economy = require('../Economy/EconomyContext'), Profile = require('./ColdCombatProfile');
    const Runtime = require('../../World/CharacterLocationRuntime');
    const current = kernel.states.get(911)?.state;
    // As the worker's own callers: the ready board names the producer scope of the proof.
    const options = { timestamp: 1e12, board: boardReady() };
    if (stage === 'prepare') {
        const members = [911,912].map(id => kernel.states.get(id).state);
        // The bot publishes the build's decision; a later snapshot carries it.
        const first = Economy.forState(current,options),clone = structuredClone({...current,stats:{...current.stats,...first.statsPacket}});
        clone.updatedAt++;
        const fresh = Economy.forState(clone,options);
        assert.strictEqual(fresh.plan,first.plan,'worker fact replacement reuses a validated data-only plan');
        assert.strictEqual(fresh.state,clone);
        assert.deepEqual(fresh.statsPacket,first.statsPacket);
        assert.deepEqual(fresh.network.activity,first.network.activity);
        Economy.forgetContext(current.characterId,'party_query_release',current);
        assert.strictEqual(Economy.forState(clone,options).plan,fresh.plan,'old query cleanup cannot evict a newer state');
        Economy.forgetContext(clone.characterId,'party_query_release',clone);
        assert.equal(Economy.size().context,0,'a private query snapshot releases its context and graph');
        const retained = Economy.size();
        const privateContext = Economy.forState(clone,{...options,rememberContext:false});
        assert.strictEqual(privateContext.state,clone);
        assert.deepEqual(privateContext.statsPacket,first.statsPacket);
        assert.deepEqual(Economy.size(),retained,'private preparation retains neither context nor engine result');
        const canonical = Economy.forState(current,options),decided = {...current,stats:{...current.stats,...canonical.statsPacket}};
        Economy.forState(clone,{...options,rememberContext:false});
        assert.strictEqual(Economy.forState(decided,options).plan,canonical.plan,'private preparation preserves the canonical card');
        const group = Economy.forGroup({id:'worker-publication',adena:200},members,options);
        assert.equal(Economy.size().groups,1);
        module.exports.previous = group.state;
        module.exports.group = group;
        module.exports.buildOwners = Profile.size().ownerBuilds;
        const hot = {...current,characterId:913,phase:'hot'};
        kernel.upsert({state:hot,context:{route:null}});
        const version = kernel.versions.get(913), size = kernel.states.size, nativeHot=kernel.states.get(913).state;
        await handle(Protocol.envelope('snapshot_page', epoch, { rows: [], economyOwnerId: 913 }, 'natural-economy-probe'));
        assert.strictEqual(kernel.states.get(913).state, nativeHot, 'a natural request does not resend or replace the canonical owner');
        assert.equal(kernel.versions.get(913), version, 'an empty request does not advance the snapshot version');
        assert.equal(kernel.states.size, size);
        assert(occupationPlanner.slots.size <= 64);
        assert(occupationPlanner.slots.has(913)||occupationPlanner.waiting.has(913),'a natural hot request uses the existing bounded pool');
        kernel.states.delete(913);
        return {cloneBackstop:true,stateShared:group.state===Runtime.index.getSource(911,'state').source,groups:1};
    }
    if (stage === 'replaced') {
        assert.notStrictEqual(current,module.exports.previous);
        assert.equal(Economy.size().context,2,'native publication keeps independently validated member calculations');
        assert.equal(Economy.size().groups,1,'native snapshot publication alone evicts no group');
        assert.strictEqual(Economy.forGroup({id:'worker-publication',adena:200},[current,kernel.states.get(912).state],options),
            module.exports.group,'a republished member with unchanged inputs keeps the group by key');
        assert.equal(Profile.size().ownerBuilds,module.exports.buildOwners);
        const economy=Economy.forState(current,options);
        assert.strictEqual(economy.state,current);
        assert.strictEqual(current,Runtime.index.getSource(911,'state').source);
        const projected=await LifeStateProjector.prepareResolve(current,{patch:{},materialize:{},events:[],debug:{},nextResolveAt:current.timing.nextResolveAt},
            {persist:false,projectClassProgression:true,timestamp:current.updatedAt+1});
        assert.notStrictEqual(projected,current);
        kernel.states.set(911,{...kernel.states.get(911),state:projected});
        assert.equal(Economy.size().context,2,'central publication keeps data-only calculations for validation');
        assert.strictEqual(Runtime.index.getSource(911,'state').source,projected);
        Economy.forGroup({id:'worker-projected',adena:200},[projected,kernel.states.get(912).state],options);
        kernel.states.delete(911);
        assert.equal(Economy.size().groups,0);
        kernel.states.clear();
        assert.deepEqual(Economy.size(),{context:0,engine:0,groups:0});
        assert.equal(Runtime.index.sourceSize('state'),0);
        return {newCanonical:true,projectionReleased:true,removed:true,forbiddenLoaded};
    }
    throw Error('unknown publication stage');
};`;
const wrapper = String.raw`
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const {parentPort,workerData}=require('node:worker_threads');
const loaded=new Module(workerData.workerPath,module);loaded.filename=workerData.workerPath;
loaded.paths=Module._nodeModulePaths(path.dirname(workerData.workerPath));
loaded._compile(fs.readFileSync(workerData.workerPath,'utf8')+workerData.observer,workerData.workerPath);
parentPort.on('message',message=>{
    if(!message.publicationProbe)return;
    loaded.exports.publicationProbe(message.publicationProbe).then(value=>parentPort.postMessage({oracle:message.msgId,value}))
        .catch(error=>parentPort.postMessage({oracle:message.msgId,error:error.stack}));
});`;
async function workerPublication() {
    const epoch = 'economy-publication';
    const worker = new Worker(wrapper, { eval: true, workerData: { observer, workerEpoch: epoch,
        workerPath: path.resolve(__dirname, '../src/GameServer/Bot/Population/ColdSimulationWorker.js') },
        resourceLimits: { maxOldGenerationSizeMb: 256 } });
    const messages = []; let fault;
    worker.on('message', message => messages.push(message)); worker.on('error', error => { fault = error; });
    async function wait(predicate) {
        const deadline = Date.now() + 15000;
        while (!messages.some(predicate)) {
            if (fault) throw fault;
            if (Date.now() >= deadline) throw Error('native publication reply timeout');
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        return messages.find(predicate);
    }
    async function probe(stage) {
        worker.postMessage({ ...Protocol.envelope('pause', epoch, {}, stage), publicationProbe: stage });
        const message = await wait(reply => reply.oracle === stage);
        if (message.error) throw Error(message.error);
        assert.deepEqual(message.value.forbiddenLoaded || [], []); console.log(stage, JSON.stringify(message.value));
    }
    try {
        await wait(message => message.type === 'ready' && message.payload.phase === 'loaded');
        // A context holds only by its event proof: a recompute generation and a ready warehouse table.
        worker.postMessage(Protocol.envelope('init', epoch, { config: { pvpAggression: 0 },
            recomputeGeneration: { code: '1'.repeat(40), config: '2'.repeat(64) } }, 'init'));
        await wait(message => message.type === 'ready' && message.payload.phase === 'running');
        worker.postMessage(Protocol.envelope('pause', epoch, {}, 'pause'));
        worker.postMessage(Protocol.envelope('table_page', epoch, { tables: ['board', 'personal_warehouse'].map(name =>
            ({ name, from: null, to: 0, full: true, rows: [], removed: [], last: true })) }, 'tables'));
        const members = [state(911), state(912)];
        worker.postMessage(Protocol.envelope('snapshot_page', epoch, { rows: members.map(bot => ({state:bot,context:{route:null}})),
            initial: true, done: true, ack: true }, 'initial'));
        await wait(message => message.type === 'ready' && message.msgId === 'initial');
        await probe('prepare');
        assert(!messages.some(message => message.msgId === 'natural-economy-probe'), 'a natural request has no snapshot ACK');
        const replacement = structuredClone(members[0]); replacement.updatedAt++;
        worker.postMessage(Protocol.envelope('snapshot_page', epoch, { rows: [{state:replacement,context:{route:null}}], ack: true }, 'replacement'));
        await wait(message => message.type === 'ready' && message.msgId === 'replacement');
        await probe('replaced');
    } finally { await worker.terminate(); }
}
(async () => {
    mainPublication(); await workerPublication();
    assert.equal(invoke('Database').isReady(), false, 'publication tests never initialize a database');
    fs.rmSync(directory, { recursive: true, force: true });
    console.log('test_economy_context_publication: ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
