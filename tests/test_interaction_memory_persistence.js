const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const gameRoot = process.env.N53_GAME_ROOT || path.resolve(__dirname, '..');
const fixture = require('./helpers/isolatedSocialDatabase')('l2-interaction-memory', gameRoot);
require(gameRoot + '/src/Global');
fixture.assertConfigured(options.default);
invoke('GameServer/DataCache').init();
const Database = invoke('Database');
const Policy = require(gameRoot + '/src/GameServer/Social/InteractionMemoryPolicy');
const Memory = require(gameRoot + '/src/GameServer/Social/InteractionMemory');
const Repository = invoke('GameServer/Social/InteractionMemoryRepository');
const TableChannel = require(gameRoot + '/src/GameServer/Bot/Population/ColdTableChannel').shared;
const TableMirror = require(gameRoot + '/src/GameServer/Bot/Population/TableMirror');
const { ColdCommitQueue } = require(gameRoot + '/src/GameServer/Bot/Population/ColdCommitQueue');
const dir = fixture.directory, file = fixture.world;
const event = (key, sourceId = 1, targetId = 2, at = Date.now()) => ({ key, sourceId, targetId, type: 'attacked', at });

async function queuedFutureEpisodes() {
    let firstId = 10;
    for (const mode of ['ordinary', 'handoff', 'drain', 'handoff-race']) {
        const ids = [firstId++, firstId++, firstId++];
        const at = Date.now() - 10;
        // Queue and database are separate clock edges: SQL's real clock has
        // reached the episode, while queue admission has not reached it yet.
        let clock = at - 100;
        for (const id of ids) {
            await Database.execute(['INSERT INTO accounts(username, password) VALUES (?, ?)', [`bot_queue_${id}`, 'test']]);
            await Database.execute([`INSERT INTO characters(id, username, name, classId, race, maxHp, maxMp,
                sex, face, hair, hairColor, locX, locY, locZ)
                VALUES (?, ?, ?, 0, 0, 100, 100, 0, 0, 0, 0, 0, 0, 0)`, [id, `bot_queue_${id}`, `Queue${id}`]]);
            await Database.execute([`INSERT INTO bot_life_state(characterId, accountName, characterName, phase,
                activity, hp, simulationRevision, statsJson, updatedAt)
                VALUES (?, ?, ?, 'cold', 'hunting', 90, 0, '{}', ?)`, [id, `bot_queue_${id}`, `Queue${id}`, at - 1000]]);
        }
        const group = { id: `future:${mode}`, memberIds: ids.slice(0, 2) };
        const proposals = ids.map((id, index) => ({
            characterId: id, proposalId: `${mode}:${id}`, revision: 0,
            priority: index === 0 ? 'P0' : 'P1',
            ...(index < 2 ? { atomicGroup: group } : {}),
            nextState: { characterId: id },
            result: { memoryEvents: index < 2 ? [event(`future:${id}`, id, ids[1 - index], at - (index ? 0 : 30))] : [] }
        }));
        let coordinator = null, releaseParty = null;
        if (mode === 'handoff-race') {
            const { ColdSimulationCoordinator } = require(gameRoot + '/src/GameServer/Bot/Population/ColdSimulationCoordinator');
            coordinator = new ColdSimulationCoordinator();
            coordinator.worker = {};
            coordinator.ready = true;
            coordinator.workerEpoch = 'fence-race';
            // Only transport is simulated. Intake, commit acknowledgements,
            // deferred party completion and fenceBot are their real owners.
            coordinator.post = (type, payload) => {
                assert.strictEqual(type, 'fence');
                queueMicrotask(() => coordinator.waiters.get('fence-race').resolve({ characterId: payload.characterId }));
                return 'fence-race';
            };
            coordinator.postCollections = () => 1;
        }
        const partyFinished = mode === 'handoff-race' ? new Promise(resolve => { releaseParty = resolve; }) : null;
        const queue = new ColdCommitQueue({
            now: () => clock, p1TargetMs: 10,
            prepare: async proposal => proposal.nextState,
            commit: entries => Database.commitAndReleaseColdSimulationLeases(entries.map(entry => ({
                characterId: entry.nextState.characterId, expectedRevision: entry.revision,
                timestamp: at, patch: { phase: 'cold', activity: 'resting', hp: 45 },
                atomicGroup: entry.atomicGroup, memoryEvents: entry.proposal.result.memoryEvents
            }))),
            ...(coordinator ? {
                onResults: coordinator.queue.onResults,
                afterCommit: async entry => {
                    // The fenced member's own ACK can finish first; its
                    // partner still owns a deferred write for the same party.
                    if (entry.nextState.characterId === ids[1]) entry.deferred = async () => {
                        await partyFinished;
                        await Database.execute(['UPDATE bot_life_state SET hp = 31 WHERE characterId = ?', [ids[1]]]);
                    };
                }
            } : {})
        });
        if (coordinator) {
            coordinator.queue = queue;
            coordinator.handleProposalBatch({ payload: { proposals } });
        } else proposals.forEach(proposal => assert(queue.enqueue(proposal).ok));
        queue.capacityBlocked = true;
        clock += 20;
        await queue.flushDue();
        const rows = async () => Database.execute([`SELECT characterId, hp, simulationRevision
            FROM bot_life_state WHERE characterId IN (?, ?, ?) ORDER BY characterId`, ids]);
        assert.deepStrictEqual((await rows()).map(row => row.hp), [90, 90, 45],
            `${mode}: a future P0 group must not block a ready independent P1 outcome`);
        assert.strictEqual(await queue.flushDue(true), false, 'force and capacity cannot admit a future episode');
        clock = at - 20;
        await queue.flushDue(true);
        assert.deepStrictEqual((await rows()).map(row => row.hp), [90, 90, 45],
            'the later member holds the whole group even after the first member event is ready');
        let completion;
        if (mode === 'handoff') completion = queue.flushCharacter(ids[0]);
        if (mode === 'drain') completion = queue.drain(1000);
        if (coordinator) completion = coordinator.fenceBot(ids[0]);
        if (completion) {
            await new Promise(resolve => setImmediate(resolve));
            assert.deepStrictEqual((await rows()).map(row => row.hp), [90, 90, 45],
                `${mode} must wait without removing or committing half of the group`);
        }
        clock = at;
        if (coordinator) {
            // The ordinary flush wins while flushCharacter is sleeping.
            await queue.flushDue();
            try {
                assert.deepStrictEqual((await rows()).map(row => row.hp), [45, 45, 45]);
                const early = await Promise.race([
                    completion.then(() => true),
                    new Promise(resolve => setTimeout(() => resolve(false), 40))
                ]);
                assert.strictEqual(early, false, 'handoff must await the other member deferred work after the queue has emptied');
            } finally {
                releaseParty();
            }
        }
        if (completion) {
            const result = await completion;
            assert(mode === 'drain' ? result.drained : result.ok);
        } else await queue.flushDue();
        assert.deepStrictEqual((await rows()).map(row => [row.hp, row.simulationRevision]),
            [[45, 1], [coordinator ? 31 : 45, 1], [45, 1]],
            `${mode}: the physical outcomes commit once, with the atomic group intact`);
        for (const [index, id] of ids.slice(0, 2).entries()) {
            const saved = await Repository.load(id);
            assert.strictEqual(saved.recent.find(row => row.key === `future:${id}`).at, at - (index ? 0 : 30),
                'durable memory preserves the original event clock');
        }
        await queue.flushDue(true);
        assert.deepStrictEqual((await rows()).map(row => row.simulationRevision), [1, 1, 1],
            'a later flush cannot replay an already committed outcome');
    }
}

async function run() {
    try {
        Database.init();
        for (const id of [1, 2]) {
            await Database.execute(['INSERT INTO accounts(username, password) VALUES (?, ?)', [`bot_memory_${id}`, 'test']]);
            await Database.execute([`INSERT INTO characters(id, username, name, classId, race, maxHp, maxMp, sex, face, hair, hairColor, locX, locY, locZ)
                VALUES (?, ?, ?, 0, 0, 100, 100, 0, 0, 0, 0, 0, 0, 0)`, [id, `bot_memory_${id}`, `Memory${id}`]]);
        }
        const main = new Memory(Repository);
        const batch = [event('fight:1:a'), event('fight:1:b', 2, 1)];
        const first = await main.recordBatch(batch);
        assert(first.ok);
        assert.deepStrictEqual((await main.recordBatch(batch)).statuses, ['duplicate', 'duplicate']);
        assert.strictEqual(main.snapshot(1).revision, 1);
        const before = await Repository.load(1);
        const failed = await main.recordBatch([event('valid'), event('expired', 2, 1, Date.now() - Policy.ACCEPT_WINDOW_MS - 1000)]);
        assert.strictEqual(failed.ok, false);
        assert.deepStrictEqual(await Repository.load(1), before, 'rejected batch leaves no partial directed memory');
        await assert.rejects(main.recordBatch([event('fk-valid'), event('fk-fail', 999, 1)]), /FOREIGN KEY/);
        assert.deepStrictEqual(await Repository.load(1), before, 'SQL failure rolls back earlier owners too');
        await Promise.all([main.recordBatch([event('concurrent:1')]), main.recordBatch([event('concurrent:2')])]);
        assert.strictEqual(main.snapshot(1).revision, 3, 'serialized updates preserve both incidents');

        const timestamp = Date.now();
        await Database.execute([`INSERT INTO bot_life_state(characterId, accountName, characterName, phase, activity, updatedAt,
            simulationRevision, statsJson)
            VALUES (1, 'bot_memory_1', 'Memory1', 'cold', 'hunting', ?, 0, '{}')`,
        [timestamp]]);
        const request = { characterId: 1, expectedRevision: 0, timestamp, patch: { phase: 'cold', activity: 'hunting', hp: 73 }, memoryEvents: [event('cold:accepted')] };
        const commitOne = (one) => Database.commitAndReleaseColdSimulationLeases([one]).then(([result]) => result);
        const committed = await commitOne(request);
        assert.strictEqual(committed.ok, true);
        assert.strictEqual((await Database.execute(['SELECT hp FROM bot_life_state WHERE characterId = 1', []]))[0].hp, 73);
        assert.strictEqual(committed.memorySnapshots[0].revision, 4);
        const stale = await commitOne({ ...request, memoryEvents: [event('cold:stale')] });
        assert.strictEqual(stale.ok, false);
        assert.strictEqual((await Repository.load(1)).revision, 4, 'rejected lifecycle proposal creates no social event');
        await assert.rejects(commitOne({ ...request, expectedRevision: 1, patch: { ...request.patch, hp: 1 },
            memoryEvents: [event('cold:expired', 1, 2, timestamp - Policy.ACCEPT_WINDOW_MS - 1000)] }), /expired_event/);
        assert.strictEqual((await Database.execute(['SELECT hp FROM bot_life_state WHERE characterId = 1', []]))[0].hp, 73,
            'social admission failure rolls back the physical outcome');
        await assert.rejects(commitOne({ ...request, expectedRevision: 1, memoryEvents: {} }), /invalid cold batch/);
        await Database.execute([`INSERT INTO bot_life_state(characterId, accountName, characterName, phase, activity, updatedAt,
            simulationRevision, statsJson)
            VALUES (2, 'bot_memory_2', 'Memory2', 'cold', 'hunting', ?, 0, '{}')`,
        [timestamp]]);
        const atomicGroup = { id: 'encounter:1', memberIds: [1, 2] };
        const group = [
            { ...request, expectedRevision: 1, atomicGroup, memoryEvents: [{ ...event('group:1'), type: 'hunted_together' }] },
            { ...request, characterId: 2, atomicGroup, memoryEvents: [{ ...event('group:2', 2, 1), type: 'hunted_together' }] }
        ];
        const queuedChange = Database.execute(['UPDATE bot_life_state SET simulationRevision = 1 WHERE characterId = 2', []]);
        const raced = Database.commitAndReleaseColdSimulationLeases(group);
        await queuedChange;
        assert((await raced).every(result => !result.ok), 'group preflight must see earlier queued ownership changes');
        assert.strictEqual((await Repository.load(1)).revision, 4, 'no half-encounter memory after a queued ownership race');
        assert.strictEqual((await Database.execute(['SELECT simulationRevision FROM bot_life_state WHERE characterId = 1', []]))[0].simulationRevision, 1);
        await Database.execute(['UPDATE bot_life_state SET simulationRevision = 0 WHERE characterId = 2', []]);
        await assert.rejects(Database.commitAndReleaseColdSimulationLeases([
            group[0], { ...group[1], memoryEvents: [event('group:expired', 2, 1, timestamp - Policy.ACCEPT_WINDOW_MS - 1000)] }
        ]), /expired_event/);
        assert.strictEqual((await Repository.load(1)).revision, 4, 'failure in second participant rolls back first participant memory');
        assert.strictEqual((await Database.execute(['SELECT simulationRevision FROM bot_life_state WHERE characterId = 1', []]))[0].simulationRevision, 1);
        const groupResult = await Database.commitAndReleaseColdSimulationLeases(group);
        assert(groupResult.every(result => result.ok && result.memorySnapshots.length === 1));
        assert.strictEqual((await Repository.load(1)).revision, 5);
        assert.strictEqual((await Repository.load(2)).revision, 2);
        const repeatedGroup = await Database.commitAndReleaseColdSimulationLeases(group);
        assert(repeatedGroup.every(result => !result.ok));
        assert.strictEqual((await Repository.load(1)).revision, 5);
        assert.strictEqual((await Database.execute(['SELECT version FROM schema_migrations WHERE version = 37', []])).length, 1);
        // Actual hot callback -> queued SQLite write -> cold snapshot -> ACK.
        const runtime = invoke('GameServer/Social/InteractionMemoryRuntime');
        await runtime.ensureMany([1, 2]);
        const Competition = invoke('GameServer/Bot/AI/BotMobCompetition');
        const actor = id => {
            const value = { fetchId: () => id, fetchLocX: () => 0, fetchLocY: () => 0,
                fetchLocZ: () => 0, fetchIsOnline: () => true, isDead: () => false };
            value.session = { actor: value, accountId: `bot_memory_${id}`, plan: 'hunting',
                currentTargetId: 999, pvpDefense: {} };
            return value;
        };
        const a = actor(1), b = actor(2);
        const mob = { fetchId: () => 999, fetchKind: () => 'Monster', fetchHp: () => 100 };
        Competition.record(a, mob);
        for (let i = 0; i < 100; i++) Competition.record(b, mob);
        assert.strictEqual(runtime.events.snapshot().pending, 1, 'one hot episode despite 100 hit callbacks');
        await runtime.events.flush();
        assert.strictEqual((await Repository.load(1)).revision, 6);
        const { ColdSimulationKernel } = require(gameRoot + '/src/GameServer/Bot/Population/ColdSimulationKernel');
        const { ColdSimulationCoordinator } = require(gameRoot + '/src/GameServer/Bot/Population/ColdSimulationCoordinator');
        const kernel = new ColdSimulationKernel({ resolveSolo: () => ({}) });
        const coordinator = new ColdSimulationCoordinator();
        // The worker's 'memory' table over the real channel: a full copy at
        // attach, then every snapshot main accepts, accepted as the worker does.
        const mirror = new TableMirror();
        mirror.watch('memory', { reset() {}, put: (_key, row) => kernel.interactionMemory.accept(row), remove() {} },
            { retain: false });
        const channelTarget = {};
        TableChannel.attach(channelTarget, 'memory-test', payload => { mirror.apply(payload.tables); return true; });
        assert.strictEqual(mirror.rows('memory').size, 0, 'the worker keeps the accepted snapshots, not a second row copy');
        const coldState = { characterId: 1, phase: 'cold', activity: 'hunting', stats: {},
            simulation: { revision: 5 }, timing: { nextResolveAt: Date.now() + 60000 } };
        const oldPage = { state: coldState };
        kernel.upsert(oldPage);
        assert.deepStrictEqual(kernel.interactionMemory.assess({ id: 1 }, { id: 2 }, {}, timestamp),
            runtime.assess({ id: 1 }, { id: 2 }, {}, timestamp));
        await runtime.recordBatch([event('ack:memory')]);
        TableChannel.flush();
        assert.strictEqual(kernel.interactionMemory.inspect(1).revision, 7, 'a committed episode reaches the worker as a memory row');
        const startedAt = Date.now();
        const proposal = { characterId: 1, proposalId: `1:${startedAt}`, revision: 5,
            priority: 'P2', enqueuedAt: startedAt, result: { events: [] } };
        kernel.inFlight.set(1, { state: coldState, startedAt });
        kernel.dirty.set(1, proposal); kernel.flush(null, true);
        coordinator.postCollections = (type, payload) => {
            assert.strictEqual(type, 'commit_ack');
            kernel.onCommitAck(payload);
        };
        await coordinator.handleCommitResults([{ ok: true, characterId: 1, nextState: coldState, proposal }]);
        kernel.upsert(oldPage);
        assert.strictEqual(kernel.interactionMemory.inspect(1).revision, 7, 'a late state page cannot overwrite table memory');
        kernel.upsert({ state: { ...coldState, phase: 'hot', simulation: { revision: 6 } } });
        assert.strictEqual(kernel.interactionMemory.inspect(1).revision, 7, 'phase changes do not erase memory');
        kernel.remove(1);
        assert.strictEqual(kernel.interactionMemory.inspect(1).revision, 7, 'a state leaving the worker keeps its table memory');
        TableChannel.detach(channelTarget);
        const saved = await Repository.load(1);
        await Database.close();
        Database.init();
        assert.deepStrictEqual(await Repository.load(1), saved, 'real close/reopen preserves bounded memory and replay ledger');
        const restarted = new Memory(Repository);
        await restarted.load(1);
        const throttled = await restarted.recordBatch([{ ...event('hunt-after-restart'), type: 'hunted_together' }]);
        assert.deepStrictEqual(throttled.statuses, ['rate_limited']);
        assert.deepStrictEqual(await Repository.load(1), saved, 'restart cannot reset the shared hunt cooldown');
        const worker = new Memory();
        worker.accept(restarted.snapshot(1));
        assert.deepStrictEqual(worker.assess({ id: 1 }, { id: 2 }, {}, timestamp), restarted.assess({ id: 1 }, { id: 2 }, {}, timestamp));
        assert.strictEqual((await restarted.recordBatch([batch[0]])).statuses[0], 'duplicate');
        assert.strictEqual((await Database.execute(['PRAGMA integrity_check', []]))[0].integrity_check, 'ok');
        await queuedFutureEpisodes();
        await Database.execute(['DELETE FROM characters WHERE id = 1', []]);
        assert.strictEqual((await Repository.load(1)).revision, 0, 'character deletion removes its memory');
        console.log('Interaction memory SQLite restart, atomicity and cold commit checks passed');
    } finally {
        await Database.close();
        for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${file}${suffix}`, { force: true });
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
