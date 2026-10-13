'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
require('../src/Global');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Service = require('../src/GameServer/AfkTrade/TradeMeetingService');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const now = Date.now(), epoch = 'commit-meeting-order';
const state = { characterId: 1, phase: 'cold', activity: 'shopping', updatedAt: now,
    simulation: { ownerId: 'legacy_main', revision: 5, leaseId: null, leaseUntil: 0 },
    timing: { activityStartedAt: now, lastResolvedAt: now, nextResolveAt: now + 600000, lastHotAt: 0 },
    stats: {}, inventory: {} };
const token = { characterId: 1, ownerId: 'cold_simulation_owner', revision: 4, leaseId: 'resolver-lease', leaseUntil: now + 600000 };
const proposal = { characterId: 1, proposalId: 'resolver:1', token };
const request = { token: 'original-postcommit-consent', actorA: 1, actorB: 2, seqA: 1, seqB: 1, town: 'Giran',
    point: { locX: 1, locY: 2, locZ: 3 }, parties: [1, 2].map(() => ({ phase: 'cold',
        ownerId: 'legacy_main', leaseId: null, hotAt: 0, revision: 5, sequence: 1, needRevision: 5,
        route: { fee: 0, scroll: false, method: 'walk', durationMs: 0 } })),
    lines: [{ payer: 0, itemId: 30, selfId: 1867, count: 2, price: 100 }] };
const coordinator = new ColdSimulationCoordinator();
let sent = 0, pages = 0, bytes = 0;
const originalCached = Life.cachedState, originalTransport = Service.adjustTransportPages;
Life.cachedState = () => state;
Service.adjustTransportPages = (p, b) => { pages += p; bytes += b; assert(pages >= 0 && bytes >= 0); };
const worker = new Worker(`
const { parentPort, workerData } = require('node:worker_threads');
require(workerData.source + '/Global');
const Protocol = require(workerData.source + '/GameServer/Bot/Population/ColdSimulationProtocol');
const Codec = require(workerData.source + '/GameServer/AfkTrade/TradeMeetingCodec');
const { ColdSimulationKernel } = require(workerData.source + '/GameServer/Bot/Population/ColdSimulationKernel');
const kernel = new ColdSimulationKernel({ resolveSolo() { throw Error('consent_must_not_resolve_combat'); }, emit(type,payload,msgId) {
  parentPort.postMessage(Protocol.envelope(type, workerData.epoch, payload, msgId)); return true;
} });
kernel.upsert({ state: workerData.state });
kernel.inFlight.set(1, { grant: workerData.token, state: workerData.state, startedAt: Date.now(), pendingCommitId: 'resolver:1' });
kernel.prepareMeeting = async (id,input) => input;
kernel.meetingResultPages = (input,id,commandId) => Codec.commandPages(input, frame => Protocol.envelope('command_request',
  workerData.epoch, { requests: [{ kind: 'meeting', characterId: id, commandId, frame }] }, 'result:3'), []);
parentPort.on('message', message => {
  if (!Protocol.validateEnvelope(message,'main',{workerEpoch:workerData.epoch}).ok) throw Error('invalid_main_message');
  if (message.type === 'snapshot_page') for (const row of message.payload.rows) kernel.upsert(row);
  if (message.type === 'commit_ack') kernel.onCommitAck(message.payload);
  if (message.type === 'command_request') for (const req of message.payload.requests) {
    if (!kernel.receiveMeetingPage(req)) parentPort.postMessage(Protocol.envelope('command_ack',workerData.epoch,
      { results: [{ kind:'meeting', characterId:req.characterId, commandId:req.commandId, pageIndex:-1, ok:false, reason:'trade_meeting_worker_busy' }] }));
  }
  if (message.type === 'command_ack') for (const result of message.payload.results) kernel.completeCommand(result);
});`, { eval: true, workerData: { source: path.resolve(__dirname, '../src'), epoch, state, token } });
coordinator.worker = worker; coordinator.workerEpoch = epoch; coordinator.ready = true;
coordinator.contextFor = () => ({}); coordinator.contextIndex = () => ({});
coordinator.ensureCraftRecipes = async () => {};
coordinator.queue.enqueue = () => ({ ok: true });
const nativePost = worker.postMessage.bind(worker);
worker.postMessage = message => { if (message.type === 'command_request') sent++; nativePost(message); };
worker.on('message', message => coordinator.onMessage(message, worker, epoch).catch(error => { throw error; }));
const tick = () => new Promise(resolve => setImmediate(resolve));

(async () => {
    try {
        // Native commit succeeded, but the worker still owns the resolver until its ACK.
        coordinator.handleProposalBatch({ payload: { proposals: [proposal] } });
        const unrelated = { ...proposal, characterId: 3, proposalId: 'resolver:3', token: { ...token, characterId: 3 } };
        coordinator.handleProposalBatch({ payload: { proposals: [unrelated] } });
        const preparation = coordinator.requestMeetingPreparation(1, request);
        await tick(); assert.equal(sent, 0, 'postcommit consent must wait for its own resolver ACK');
        assert.equal(pages, 0, 'waiting does not hold transport pages');
        const timeout = setTimeout(() => { throw Error('preparation_deadlocked'); }, 10000);
        await coordinator.handleCommitResults([{ ok: true, characterId: 1, proposal, nextState: state, revision: 5 }]);
        const proof = await preparation; clearTimeout(timeout);
        assert(proof.approved); assert.equal(proof.token, request.token);
        assert(sent > 0); assert.equal(coordinator.commitAcknowledgements.size, 1, 'unrelated commit does not block consent');
        assert.equal(coordinator.commandInflight.size, 0); assert.equal(pages, 0); assert.equal(bytes, 0);
        // Timeout/discard before ACK cannot send a retired preparation later.
        const later = { ...proposal, proposalId: 'resolver:later' };
        coordinator.handleProposalBatch({ payload: { proposals: [later] } });
        const cancelled = coordinator.requestMeetingPreparation(1, { ...request, token: 'cancel-before-ack' });
        const rejected = assert.rejects(cancelled, /preparation_discarded/);
        coordinator.cancelMeetingPreparation('cancel-before-ack'); await rejected;
        const before = sent;
        await coordinator.handleCommitResults([{ ok: true, characterId: 1, proposal: later, nextState: state, revision: 5 }]);
        await tick(); assert.equal(sent, before, 'late ACK must not revive discarded consent');
        await coordinator.handleCommitResults([{ ok: true, characterId: 3, proposal: unrelated, nextState: { ...state, characterId: 3 }, revision: 5 }]);
        assert.equal(coordinator.commitAcknowledgements.size, 0);
        // The existing deadline also covers time spent waiting for commit ACK.
        const timeoutProposal = { ...proposal, proposalId: 'resolver:timeout' };
        coordinator.handleProposalBatch({ payload: { proposals: [timeoutProposal] } });
        let expire;
        const nativeTimeout = global.setTimeout;
        global.setTimeout = callback => { expire = callback; return nativeTimeout(callback, 600000); };
        let expiring;
        try { expiring = coordinator.requestMeetingPreparation(1, { ...request, token: 'expire-before-ack' }); }
        finally { global.setTimeout = nativeTimeout; }
        const expired = assert.rejects(expiring, /preparation_timeout/);
        expire(); await expired;
        await coordinator.handleCommitResults([{ ok: true, characterId: 1, proposal: timeoutProposal, nextState: state, revision: 5 }]);
        await tick(); assert.equal(sent, before);
        // Source retirement releases both the staging promise and ACK waiter.
        coordinator.handleProposalBatch({ payload: { proposals: [{ ...proposal, proposalId: 'resolver:exit' }] } });
        const exiting = coordinator.requestMeetingPreparation(1, { ...request, token: 'exit-before-ack' });
        const retired = assert.rejects(exiting, /worker_exited/);
        coordinator.stopping = true;
        coordinator.onWorkerExit(1, worker, epoch); await retired; await tick();
        assert.equal(coordinator.commitAcknowledgements.size, 0);
        assert.equal(coordinator.commandInflight.size, 0); assert.equal(pages, 0); assert.equal(bytes, 0);
        console.log('PASS postcommit meeting waits for matching resolver ACK, ignores unrelated commits, retains token and clears cancelled waiters');
    } finally {
        Life.cachedState = originalCached; Service.adjustTransportPages = originalTransport;
        for (const held of coordinator.commandInflight.values()) clearTimeout(held.timer);
        await worker.terminate();
    }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
