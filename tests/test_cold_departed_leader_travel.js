'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const world = require('./fixtures/native_stock_world')();
require('../src/Global');
const DB = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const Resolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const { ColdSimulationKernel, lifecycleKind } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');

async function main() {
    DB.init(); invoke('GameServer/DataCache').init(); await Life.init();
    const at = Date.now(), town = world.town(), messages = [];
    await DB.createAccount('bot_departed_leader', 'fixture');
    const id = Number((await DB.createCharacter('bot_departed_leader', {
        name: 'DepartedLeader', race: 0, classId: 0, maxHp: 100, maxMp: 100,
        sex: 0, face: 0, hair: 0, hairColor: 0, ...town
    })).insertId);
    // The departure already paid for this SoE/gatekeeper trip. Arrival must
    // move the bot, with no second charge and no rollback of a later bag write.
    await DB.setItem(id, { selfId: 57, name: 'Adena', amount: 479600, equipped: false, slot: 0 });
    await DB.setItem(id, { selfId: 736, name: 'Scroll of Escape', amount: 1, equipped: false, slot: 0 });
    const paid = await Life.upsertState({ characterId: id, accountName: 'bot_departed_leader', name: 'DepartedLeader',
        phase: 'cold', activity: 'traveling', level: 20, adena: 479600, spotId: '18_0',
        party: { partyId: null, leaderId: null }, loc: { locX: 108698, locY: 5562, locZ: -3272 },
        inventory: Life.inventorySummaryFromItems(await DB.fetchItems(id)),
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
        timing: { lastResolvedAt: at - 60000, nextResolveAt: at - 35000 },
        stats: { generatedCold: true, lastReason: 'bot_afk_trade_published', travel: {
            reason: 'market_buy_craft_material', method: 'soe_gatekeeper', viaTown: 'Aden', townName: 'Giran',
            from: { locX: 108698, locY: 5562, locZ: -3272 }, to: town,
            startedAt: at - 60000, arrivalAt: at - 35000, arrivalActivity: 'shopping',
            arrivalEvent: 'arrived_town', paid: { scroll: 736, fee: 20400 }
        } } }, 'departed_leader_fixture');
    const oldParty = { partyId: 'old-departed-party', status: 'active', leaderId: id,
        memberIds: [id, id + 1], nextResolveAt: at + 3600000 };
    // The departed leader's party is not in the worker's parties table (main
    // publishes the row it holds; a departure changes or removes it).
    const kernel = new ColdSimulationKernel({ now: () => at, resolveSolo: input => Resolver.resolveSolo(input),
        projectResolve: (state, result, timestamp) => Life.prepareResolve(state, result, { timestamp, persist: false }),
        emit: (type, payload, msgId) => messages.push({ type, payload, msgId }) });
    kernel.upsert({ state: paid });
    assert.equal(kernel.leaderParty(id), null, 'a departed leader leads no party row');
    assert.equal(kernel.scheduleTokens.get(id).dueAt, paid.timing.nextResolveAt, 'arrival owns the deadline, not the old hunt');
    kernel.tick();
    assert(kernel.inFlight.has(id), 'the overdue solo trip must enter its next worker step');
    await kernel.resolveChain;
    kernel.flush(null, true);
    const proposal = messages.find(m => m.type === 'proposal_batch')?.payload.proposals[0];
    assert(proposal, 'the native arrival resolver must issue a durable proposal');
    const [committed] = await Owner.commitBatch([{ revision: proposal.revision, nextState: proposal.nextState,
        proposal, options: proposal.options }], { timestamp: at });
    assert(committed.ok, JSON.stringify(committed));
    const saved = Life.cachedState(id);
    const row = (await DB.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [id]]))[0];
    assert.equal(row.activity, 'shopping');
    assert.equal(JSON.parse(row.statsJson).travel, null);
    assert.deepEqual([row.locX, row.locY, row.locZ], [town.locX, town.locY, town.locZ]);
    const amounts = Object.fromEntries((await DB.fetchItems(id)).map(item => [item.selfId, Number(item.amount)]));
    assert.equal(amounts[57], 479600, 'arrival does not charge the trip twice');
    assert.equal(amounts[736], 1);
    kernel.onCommitAck({ results: [{ characterId: id, ok: true,
        proposalId: proposal.proposalId, state: saved }] });
    assert.equal(lifecycleKind(kernel.states.get(id).state, kernel), 'command',
        'town errands can run after the arrival receipt');
    kernel.upsert({ state: paid });
    assert.equal(kernel.states.get(id).state.activity, 'shopping', 'an older snapshot cannot roll arrival back');

    const attached = { ...paid, characterId: id + 10, party: { partyId: oldParty.partyId } };
    const follower = { ...paid, characterId: id + 11, party: attached.party, activity: 'grouped', stats: {},
        timing: { lastResolvedAt: at - 1000, nextResolveAt: at + 3600000 } };
    kernel.upsert({ state: attached });
    kernel.upsert({ state: follower });
    kernel.partyPut(oldParty.partyId, { ...oldParty, leaderId: attached.characterId,
        memberIds: [attached.characterId, follower.characterId] });
    assert.equal(lifecycleKind(attached, kernel), 'party',
        'an attached leader keeps the group writer');
    assert.equal(kernel.scheduleTokens.get(attached.characterId).dueAt, oldParty.nextResolveAt);
    await kernel.shutdown();

    // Main sends the departed leader's solo state at once and rewrites the
    // party row only after later awaits: a stale row that still names it
    // leader must not make the solo trip a party writer.
    const soloKernel = new ColdSimulationKernel({ now: () => at, resolveSolo: input => Resolver.resolveSolo(input),
        projectResolve: (state, result, timestamp) => Life.prepareResolve(state, result, { timestamp, persist: false }),
        emit: () => {} });
    const leftAt = at + 20000;
    const departed = { ...paid, characterId: id + 20,
        timing: { lastResolvedAt: at - 1000, nextResolveAt: leftAt },
        stats: { ...paid.stats, travel: { ...paid.stats.travel, startedAt: at - 1000, arrivalAt: leftAt } } };
    const staleParty = { partyId: 'stale-departed-party', status: 'active', leaderId: departed.characterId,
        memberIds: [departed.characterId, id + 21, id + 22], nextResolveAt: at + 3600000 };
    soloKernel.upsert({ state: departed });
    for (const followerId of [id + 21, id + 22]) {
        soloKernel.upsert({ state: { ...follower, characterId: followerId,
            party: { partyId: staleParty.partyId, leaderId: departed.characterId } } });
    }
    soloKernel.partyPut(staleParty.partyId, staleParty);
    assert.equal(soloKernel.leaderParty(departed.characterId), null, 'a solo state leads no stale party row');
    assert.equal(lifecycleKind(departed, soloKernel), 'resolver', 'the solo trip keeps its own writer');
    assert.equal(soloKernel.scheduleTokens.get(departed.characterId).dueAt, leftAt,
        'the paid trip owns the deadline, no party step');
    await soloKernel.shutdown();

    // Native group results repeat the same party row for every member. The
    // leader's postcommit review can dissolve it before the follower's tail.
    const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
    const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
    await Parties.init();
    const prepared = Parties.prepareCommit({ ...oldParty, startedAt: at, stats: {} });
    const native = await DB.saveBackgroundParty(prepared.row);
    assert(native.affectedRows);
    const coordinator = new ColdSimulationCoordinator();
    // Economic side effects have separate suites; retain the real party
    // publication callback and native dissolution between the two member ACKs.
    coordinator.step = async (name, owner, work) => name === 'partyCache' ? work() : undefined;
    await coordinator.afterCommit({ nextState: saved,
        proposal: { partyResolution: { partyId: oldParty.partyId, party: oldParty } } }, { partyRow: native.row });
    assert.equal(Parties.find(oldParty.partyId).status, 'active', 'the leader publishes the shared native row');
    await Parties.setStatus(oldParty.partyId, 'dissolved');
    assert.equal(Parties.find(oldParty.partyId), null);
    await coordinator.afterCommit({ nextState: { ...saved, characterId: id + 1 }, proposal: {} }, { partyRow: native.row });
    assert.equal(Parties.find(oldParty.partyId), null, 'a follower receipt must not resurrect a dissolved party in main');
    assert(!Parties.active().some(party => party.partyId === oldParty.partyId));
    assert.equal((await DB.execute(['SELECT status FROM bot_background_parties WHERE partyId=?', [oldParty.partyId]]))[0].status,
        'dissolved', 'the accepted cache agrees with native membership');
    console.log('PASS detached leader finishes paid market travel through native worker step/commit; an older page cannot roll the arrival back');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => world.close());
