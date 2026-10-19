'use strict';
// ARCH-14-b: a near bot's decision is taken in the worker on the bot's post
// and answers that post (payload.near.nearSeq). The body acts on the newest
// answer it got: a decision for an older post that arrives after a newer one
// is refused, and an accepted one brings the mind it moved to the body. A
// raise the body posted waits until a decision names it (raiseSeq). The
// worker side (its own mind kept over a post's, a raise taken once) is in
// test_worker_economy_publication.
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const Decisions = invoke('GameServer/Bot/Population/ColdEconomyDecision');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Events = invoke('GameServer/Bot/AI/DecisionEvents');
const World = invoke('GameServer/World/World');

const id = 7141;
const state = Life.acceptLifecycleRow({ characterId: id, accountName: 'bot_near_order', name: 'NearOrder', level: 30,
    phase: 'hot', activity: 'hunting', adena: 1000, currentRegion: 'Giran', loc: { locX: 0, locY: 0, locZ: 0 },
    stats: { classId: 0, decisionSeq: 4, money: [1000, .001, 0, 0] }, inventory: {}, timing: {},
    simulation: { revision: 1 }, updatedAt: Date.now() });
const actor = { fetchId: () => id, fetchLevel: () => 30, fetchClassId: () => 0, fetchRace: () => 0,
    fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0, fetchKarma: () => 0, fetchMaxLoad: () => 1000,
    backpack: { fetchItems: () => [], fetchTotalLoad: () => 0, fetchTotalAdena: () => 1000, fetchItemFromSelfId: () => null } };
const session = { accountId: 'bot_near_order', actor, coldLifeState: state };
actor.session = session;
// The world edge: the bot's body is registered near the player.
World.registeredActorById = actorId => Number(actorId) === id ? { session } : null;

const coordinator = new ColdSimulationCoordinator();
coordinator.worker = { postMessage: () => {} };
coordinator.workerEpoch = 'near-order';
const decided = (spotId, nearSeq, decisionSeq, raiseSeq = 0) => Protocol.envelope('ready', 'near-order', {
    phase: 'economy_decided', characterId: id,
    economyDecision: Decisions.capture({ network: { activity: { activity: 'hunting', spotId }, decisionSeq, activityLeaf: 0 } }, state),
    near: { statsPacket: { decisionSeq, activityLeaf: 0, money: [1000, .001, 0, 0] }, nearSeq, raiseSeq } });
const spot = () => Events.held(session)?.network.activity?.spotId;

(async () => {
    await coordinator.onMessage(decided('newer', 2, 6));
    assert.equal(spot(), 'newer', 'the answer to the bot\'s post drives the body');
    assert.equal(session.coldLifeState.stats.decisionSeq, 6, 'the accepted decision brings the mind it moved');
    await coordinator.onMessage(decided('older', 1, 5));
    assert.equal(spot(), 'newer', 'an older post\'s answer arriving late never replaces the newer one');
    assert.equal(session.coldLifeState.stats.decisionSeq, 6, 'nor rolls the mind back');
    await coordinator.onMessage(decided('next', 3, 7));
    assert.equal(spot(), 'next', 'the next post\'s answer replaces it');

    // A rejected action raises the impossible event once; it waits for the
    // decision that answers that raise, not for any later decision.
    const accepted = seq => ({ characterId: id, stats: { decisionSeq: seq, activityLeaf: 0 } });
    assert.equal(Events.rejectSession(session, accepted(7)), true, 'the rejection raises its event');
    assert.equal(Events.rejectSession(session, accepted(7)), false, 'a second rejection while it waits adds nothing');
    await coordinator.onMessage(decided('unanswered', 4, 8, 0));
    assert.equal(Events.rejectSession(session, accepted(8)), false, 'a decision taken before the raise does not answer it');
    await coordinator.onMessage(decided('answered', 5, 9, session.raiseSeq));
    assert.equal(Events.rejectSession(session, accepted(9)), true, 'after the answer a new rejection raises again');
    console.log('PASS near decision order: newest post wins, its mind reaches the body, a raise waits for its answer');
})().catch(error => { console.error(error); process.exitCode = 1; });
