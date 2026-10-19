const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
require('../src/Global');
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const World = invoke('GameServer/World/World');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const EconomyCommit = require('../src/GameServer/Bot/Economy/EconomyCommit');
const previous = { path: options.default.Database.path, history: options.default.Database.historyPath,
    knowledge: Config.knowledgeErrorsEnabled, world: World.user };
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'l2solo-ack-runtime-'));
let coordinator, sequence = 0;
const sent = [];
async function until(predicate, label) {
    for (let attempt = 0; attempt < 2500; attempt++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`timed out: ${label}`);
}
async function create() {
    const name = `AckRuntime${++sequence}`;
    const id = Number((await Database.createCharacter('bot_ack_runtime', { name,
        race: 0, classId: 0, maxHp: 100, maxMp: 100, sex: 0, face: 0, hair: 0, hairColor: 0,
        locX: 1, locY: 1, locZ: 0 })).insertId);
    await Life.upsertState({ characterId: id, accountName: 'bot_ack_runtime', name,
        phase: 'cold', activity: 'resting', level: 1, inventory: {}, stats: { classId: 0, generatedCold: true },
        loc: { locX: 1, locY: 1, locZ: 0 }, vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
        timing: { nextResolveAt: Date.now() + 86400000 } }, 'ack_runtime_fixture');
    return id;
}
async function claim(id) {
    const token = await Owner.claim(Life.cachedState(id), { allowLifecycle: true });
    assert(token.ok); assert(Protocol.leaseRenewalToken(token)); return token;
}
async function row(id) {
    return (await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [id]]))[0];
}
function take(type) {
    const messages = sent.filter(message => message.type === type);
    sent.length = 0;
    messages.forEach(message => assert(Protocol.validateEnvelope(message, 'main', { workerEpoch: coordinator.workerEpoch }).ok));
    return messages.flatMap(message => message.payload.results);
}
// A commit of a fresh bot whose row holds `rowLeaf` (written as an economy
// command writes it) and whose proposal carries `proposalLeaf`: the row keeps
// its own leaf over the proposal's (EconomyCommit.preserveLeafSql).
async function leafCommit(rowLeaf, proposalLeaf, proposalId) {
    const id = await create(), token = await claim(id), claimed = Life.cachedState(id), at = Date.now();
    if (rowLeaf) await Database.execute(["UPDATE bot_life_state SET statsJson=json_set(COALESCE(statsJson,'{}'),'$.economyCommit',json(?)) WHERE characterId=?",
        [JSON.stringify(rowLeaf), id]]);
    const nextState = { ...claimed, activity: 'hunting', updatedAt: at,
        timing: { ...claimed.timing, lastResolvedAt: at, nextResolveAt: at + 60000 },
        stats: proposalLeaf ? { ...claimed.stats, economyCommit: proposalLeaf } : claimed.stats };
    const proposal = { proposalId, token, nextState, result: { events: [] }, enqueuedAt: at };
    const [commit] = await Owner.commitBatch([{ revision: token.revision, nextState, proposal, options: { allowLifecycle: true } }]);
    assert(commit.ok); assert.equal(Life.cachedState(id), commit.cached);
    assert.equal(commit.row.economyCommit, rowLeaf ? JSON.stringify(rowLeaf) : null, 'the row kept its own leaf');
    return { ...commit, proposal, nextState };
}
async function release(token) {
    const request = Protocol.envelope('release_request', coordinator.workerEpoch,
        { releases: [{ token, reason: 'ack_identity_fixture' }] });
    assert(Protocol.validateEnvelope(request, 'worker', { workerEpoch: coordinator.workerEpoch }).ok);
    await coordinator.onMessage(request, coordinator.worker, coordinator.workerEpoch);
    return { request, results: take('release_ack') };
}
(async () => {
    try {
        options.default.Database.path = path.join(directory, 'world.sqlite');
        options.default.Database.historyPath = path.join(directory, 'history.sqlite');
        Config.knowledgeErrorsEnabled = false;
        await new Promise(resolve => Database.init(resolve));
        invoke('GameServer/DataCache').init();
        await Database.createAccount('bot_ack_runtime', 'fixture');
        await Life.init(); await create();
        World.user = { sessions: [], revision: 0 };
        coordinator = new ColdSimulationCoordinator();
        await coordinator.start({ realPlayerSessionsNear: World.realPlayerSessionsNear.bind(World) });
        await until(() => coordinator.ready && coordinator.snapshotsLoaded, 'actual ready Worker');
        assert(coordinator.worker instanceof Worker);
        const worker = coordinator.worker, post = worker.postMessage.bind(worker);
        worker.postMessage = message => { sent.push(message); return post(message); };
        const id = await create(), original = await claim(id);
        const handoff = await Owner.handoffToMain(Life.cachedState(id)); assert(handoff.ok);
        const current = await claim(id), currentRow = await row(id);
        assert.notEqual(original.leaseId, current.leaseId);
        const stale = (await Owner.commitBatch([{ revision: original.revision, nextState: Life.cachedState(id), options: { allowLifecycle: true } }]))[0];
        assert.equal(stale.ok, false); assert.equal(stale.reason, 'stale_revision');
        assert.deepEqual(await row(id), currentRow);
        const proposal = { proposalId: 'old-native-proposal', token: original };
        await coordinator.handleCommitResults([{ ...stale, characterId: id, proposal }]);
        const [ack] = take('commit_ack');
        assert(ack); assert.deepEqual(await row(id), currentRow);
        console.log('Actual ready Worker and stale native commit/current ownership conservation: PASS');
        assert.deepEqual(ack.inputToken, Protocol.leaseRenewalToken(original), 'commit echoes original input token');
        assert.equal(ack.proposalId, proposal.proposalId);
        console.log('Main commit echoes old original identity independently of latest cached state: PASS');

        const oldRelease = await release(original);
        assert.equal(oldRelease.results.length, 1);
        assert.equal(oldRelease.results[0].ok, false);
        assert.deepEqual(oldRelease.results[0].inputToken, Protocol.leaseRenewalToken(original));
        assert.equal(oldRelease.results[0].releaseRequestId, oldRelease.request.msgId);
        assert.deepEqual(await row(id), currentRow);
        console.log('Native stale release echoes exact request identity and conserves fresh grant: PASS');

        const committed = (await Owner.commitBatch([{ revision: current.revision, nextState: Life.cachedState(id), options: { allowLifecycle: true } }]))[0];
        assert(committed.ok); assert.notEqual(committed.revision, current.revision);
        const currentProposal = { proposalId: 'current-native-proposal', token: current };
        await coordinator.handleCommitResults([{ ...committed, characterId: id, proposal: currentProposal },
            { ok: false, characterId: 999999, reason: 'malformed_original', proposal: { token: null, proposalId: 'malformed' } }]);
        const currentAcks = take('commit_ack');
        assert.equal(currentAcks.length, 1);
        assert.deepEqual(currentAcks[0].inputToken, Protocol.leaseRenewalToken(current));
        assert.equal(currentAcks[0].proposalId, currentProposal.proposalId);
        assert.equal(currentAcks[0].revision, committed.revision);
        assert.equal(currentAcks[0].state.simulation.revision, committed.revision);
        console.log('Successful native output revision stays separate and malformed sibling cannot poison ACK: PASS');

        // A commit returns the bot to main; a new claim leases it again at a
        // newer revision, and its release uses that current token.
        const releaseToken = await claim(id);
        const activeRelease = await release(releaseToken);
        assert.equal(activeRelease.results.length, 1); assert(activeRelease.results[0].ok);
        assert.deepEqual(activeRelease.results[0].inputToken, Protocol.leaseRenewalToken(releaseToken));
        assert.equal(activeRelease.results[0].releaseRequestId, activeRelease.request.msgId);
        assert.notEqual(activeRelease.results[0].revision, releaseToken.revision);
        assert.equal((await row(id)).simulationLeaseId, null);
        console.log('Successful native release keeps original input/request and newer output authority: PASS');

        // A commit whose afterCommit writes nothing: main's cache stays the
        // commit's own entry, the ack carries the numbers and no state, and the
        // worker's copy built from its proposal matches main's cache on the
        // command checkpoint and the bag, kit and henna revisions.
        const numbersId = await create(), numbersToken = await claim(numbersId), claimed = Life.cachedState(numbersId);
        const at = Date.now();
        // The worker's bag as a step leaves it, not canonical: a bought sword
        // counted before its physical copy exists and an emptied stack.
        const proposedState = { ...claimed, activity: 'hunting', updatedAt: at,
            timing: { ...claimed.timing, lastResolvedAt: at, nextResolveAt: at + 60000 },
            inventory: { 1: { selfId: 1, name: 'Short Sword', amount: 2, stackable: false, equipped: false, slot: 0,
                instances: [{ id: null, amount: 1, enchant: 0, equipped: false, slot: 0 }] },
            1835: { selfId: 1835, name: 'Soulshot: No Grade', amount: 0, stackable: true } } };
        const numbersKernel = new ColdSimulationKernel({ resolveSolo: () => null, emit: () => true });
        numbersKernel.upsert({ state: claimed });
        numbersKernel.inFlight.set(numbersId, { state: claimed, grant: numbersToken });
        numbersKernel.dirty.set(numbersId, { proposalId: 'numbers-proposal', characterId: numbersId, token: numbersToken,
            priority: 'P1', enqueuedAt: at, nextState: proposedState, result: { events: [] } });
        numbersKernel.flush(null, true);
        const numbersProposal = { proposalId: 'numbers-proposal', token: numbersToken, nextState: proposedState,
            result: { events: [] }, enqueuedAt: at };
        const [numbersCommit] = await Owner.commitBatch([{ revision: numbersToken.revision, nextState: proposedState,
            proposal: numbersProposal, options: { allowLifecycle: true } }]);
        assert(numbersCommit.ok);
        assert.equal(Life.cachedState(numbersId), numbersCommit.cached, 'the commit names the cache entry it built');
        await coordinator.afterCommit({ proposal: numbersProposal, token: numbersToken, nextState: proposedState }, numbersCommit);
        assert.equal(Life.cachedState(numbersId), numbersCommit.cached, 'an afterCommit that writes nothing keeps the entry');
        const committedResult = { ...numbersCommit, proposal: numbersProposal, nextState: proposedState };
        const ackState = { ...coordinator.ackState };
        await coordinator.handleCommitResults([committedResult]);
        const [numbersAck] = take('commit_ack');
        assert.equal(Object.hasOwn(numbersAck, 'state'), false, 'the ack carries no state');
        assert.deepEqual(coordinator.ackState, { with: ackState.with, without: ackState.without + 1 });
        numbersKernel.onCommitAck({ results: [numbersAck] });
        const workerCopy = numbersKernel.states.get(numbersId).state, mainCopy = Life.cachedState(numbersId);
        assert(Protocol.sameCommandCheckpoint(workerCopy, mainCopy), 'the worker copy passes main\'s command checkpoint');
        assert.deepStrictEqual(workerCopy, mainCopy, 'the worker copy is main\'s cached state, its bag canonical');
        console.log('A commit main did not change acks with numbers only and the worker rebuilds main\'s state: PASS');

        // A bot after its first economy step: the row holds a leaf and the
        // proposal carries the same one. The row kept nothing over it: numbers.
        const leaf = EconomyCommit.completed(EconomyCommit.create(1, 0, {}), { success: true });
        const otherLeaf = EconomyCommit.completed(EconomyCommit.create(1, 1, {}), { success: true });
        const sameLeaf = await leafCommit(leaf, leaf, 'same-leaf-proposal');
        assert.equal(sameLeaf.cached.stats, sameLeaf.nextState.stats, 'the same leaf keeps the proposal\'s stats');
        const leafAckState = { ...coordinator.ackState };
        await coordinator.handleCommitResults([sameLeaf]);
        const [sameLeafAck] = take('commit_ack');
        assert.equal(Object.hasOwn(sameLeafAck, 'state'), false, 'the same leaf acks without the state');
        assert.equal(sameLeafAck.inventoryRevision, sameLeaf.cached.bagRevision);
        assert.deepEqual(coordinator.ackState, { with: leafAckState.with, without: leafAckState.without + 1 });
        console.log('A row and a proposal holding the same economy leaf ack with numbers only: PASS');

        // Each condition failing carries the state: main committed another
        // state, a write replaced the cache entry, the commit read the bag or
        // the stats back from the row, or the row kept an economy leaf other
        // than the proposal's (real commits: a different leaf, the row's leaf
        // where the proposal has none, none where the proposal has one).
        const fails = {
            cleanup: { proposal: { ...numbersProposal, inventoryCleanupForced: true } },
            resolvedOnMain: { proposal: { ...numbersProposal, nextState: undefined } },
            cacheReplaced: { cached: { ...numbersCommit.cached } },
            settled: { settled: true },
            pkDrops: { pkDrops: [{ itemId: 1 }] },
            partyPayment: { partyPayment: true },
            rowReread: { row: { ...numbersCommit.row, statsJson: '{}' } },
            economyLeaf: await leafCommit(leaf, otherLeaf, 'different-leaf-proposal'),
            rowLeaf: await leafCommit(leaf, null, 'row-leaf-proposal'),
            proposalLeaf: await leafCommit(null, leaf, 'proposal-leaf-proposal')
        };
        for (const [name, change] of Object.entries(fails)) {
            await coordinator.handleCommitResults([{ ...committedResult, ...change }]);
            const [ack] = take('commit_ack');
            assert(ack.state, `${name}: the ack carries the state`);
            assert.equal(Object.hasOwn(ack, 'inventoryRevision'), false, `${name}: no numbers`);
        }
        assert.equal(coordinator.ackState.with, ackState.with + Object.keys(fails).length);
        console.log('Each failed numbers condition still carries the state: PASS');

        // Hold delivery of real native release outcomes, then replace the
        // actual Worker before either main handler resumes. Native recovery
        // remains real; only Promise delivery is gated by the fixture.
        const lateToken = await claim(await create()), nativeRelease = Database.releaseColdSimulationLeases;
        let entered = 0, resume;
        const gate = new Promise(resolve => { resume = resolve; });
        Database.releaseColdSimulationLeases = async (...args) => {
            const results = await nativeRelease.apply(Database, args);
            entered++; await gate; return results;
        };
        try {
            sent.length = 0;
            const oldEpoch = coordinator.workerEpoch;
            const pendingCommit = coordinator.handleCommitResults([{ ok: false, characterId: lateToken.characterId,
                reason: 'prepare_refused', proposal: { proposalId: 'old-source-proposal', token: lateToken } }]);
            const lateRequest = Protocol.envelope('release_request', oldEpoch,
                { releases: [{ token: lateToken, reason: 'old_source' }] });
            const pendingRelease = coordinator.onMessage(lateRequest, worker, oldEpoch);
            await until(() => entered === 2, 'two real native outcome delivery gates');
            await worker.terminate();
            await until(() => coordinator.worker === null, 'actual old Worker exit');
            clearTimeout(coordinator.restartTimer); coordinator.restartTimer = null;
            coordinator.startWorker();
            const replacement = coordinator.worker, replacementPost = replacement.postMessage.bind(replacement);
            replacement.postMessage = message => { sent.push(message); return replacementPost(message); };
            await until(() => coordinator.ready && coordinator.snapshotsLoaded, 'actual replacement Worker bootstrap');
            assert.notEqual(replacement, worker); assert.notEqual(coordinator.workerEpoch, oldEpoch);
            resume(); await Promise.all([pendingCommit, pendingRelease]);
            assert.equal(sent.filter(message => message.type === 'commit_ack').length, 0);
            assert.equal(sent.filter(message => message.type === 'release_ack').length, 0);
            sent.length = 0;
            replacement.postMessage = replacementPost;
        } finally { resume(); Database.releaseColdSimulationLeases = nativeRelease; }
        console.log('Actual Worker replacement during native outcome delivery suppresses both old-source ACKs: PASS');
        worker.postMessage = post;
        console.log('Native main ACK identity runtime tests: PASS');
    } finally {
        await coordinator?.stop(); await Database.close();
        options.default.Database.path = previous.path;
        options.default.Database.historyPath = previous.history;
        Config.knowledgeErrorsEnabled = previous.knowledge;
        World.user = previous.world;
        fs.rmSync(directory, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
