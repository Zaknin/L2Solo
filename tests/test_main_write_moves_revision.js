// A main write to a far bot's row moves its revision once, so a worker
// proposal built before it is refused (stale_revision) and the worker rebases
// on the row the commit read; a stale_command answers with the row read back.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
require('../src/Global');
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const Data = invoke('GameServer/DataCache');
const Population = invoke('GameServer/Bot/Population/PopulationService');
const PkDeathDrop = invoke('GameServer/Actor/Generics/PkDeathDrop');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'l2solo-main-write-revision-'));
const ACCOUNT = 'bot_main_write_revision';
let sequence = 0;

async function create(phase, stats = {}) {
    const name = `MainWrite${++sequence}`;
    const id = Number((await Database.createCharacter(ACCOUNT, { name,
        race: 0, classId: 0, maxHp: 100, maxMp: 100, sex: 0, face: 0, hair: 0, hairColor: 0,
        locX: 1, locY: 1, locZ: 0 })).insertId);
    await Life.upsertState({ characterId: id, accountName: ACCOUNT, name,
        phase, activity: 'resting', level: 1, inventory: {}, stats: { classId: 0, generatedCold: true, ...stats },
        loc: { locX: 1, locY: 1, locZ: 0 }, vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
        timing: { nextResolveAt: Date.now() + 86400000 } }, 'main_write_revision_fixture');
    return id;
}
async function row(id) {
    return (await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [id]]))[0];
}
function coordinatorProbe() {
    const coordinator = new ColdSimulationCoordinator();
    const sent = [];
    coordinator.worker = { postMessage() {} };
    coordinator.workerEpoch = 'main-write-revision';
    coordinator.postCollections = (type, payload) => { sent.push({ type, results: payload.results }); return 1; };
    coordinator.ensureCraftRecipes = async () => null;
    return { coordinator, sent };
}

(async () => {
    try {
        options.default.Database.path = path.join(directory, 'world.sqlite');
        options.default.Database.historyPath = path.join(directory, 'history.sqlite');
        Config.knowledgeErrorsEnabled = false;
        await new Promise(resolve => Database.init(resolve));
        Data.init();
        await Database.createAccount(ACCOUNT, 'fixture');
        await Life.init();
        const far = await create('cold');
        const near = await create('hot');

        // One main write, one move, on a far row only.
        const farBefore = Number((await row(far)).simulationRevision);
        const nearBefore = Number((await row(near)).simulationRevision);
        const renamed = await Database.updateGeneratedBotName(far, 'RenamedFar', 3);
        assert.equal(Number((await row(far)).simulationRevision), farBefore + 1, 'a main write moves a far row once');
        assert.equal(renamed.simulationRevision, farBefore + 1, 'the writer hands back the written revision');
        await Database.updateGeneratedBotName(near, 'RenamedNear', 3);
        assert.equal(Number((await row(near)).simulationRevision), nearBefore, 'a near row keeps its revision');

        // The cache patched by hand after the write carries the written revision.
        const migrated = await Life.acceptAppearanceMetadata(far, 1, 2);
        assert.equal(migrated.simulation.revision, farBefore + 2);
        assert.equal(Life.cachedState(far).simulation.revision, Number((await row(far)).simulationRevision),
            'the cached copy matches the row after a main write');

        // A proposal built before a main write is refused and rebases on the row.
        const stepRevision = Life.cachedState(far).simulation.revision;
        const proposed = { ...Life.cachedState(far), stats: { ...Life.cachedState(far).stats, proposalProbe: true } };
        await Database.updateGeneratedBotName(far, 'RenamedUnderStep', 4);
        const moved = Number((await row(far)).simulationRevision);
        const [refused] = await Owner.commitBatch([{ revision: stepRevision, nextState: proposed,
            proposal: { revision: stepRevision } }]);
        assert.equal(refused.ok, false);
        assert.equal(refused.reason, 'stale_revision', 'the older proposal is refused');
        assert.equal(refused.row.characterName, 'RenamedUnderStep', 'the refusal hands back the row it read');
        assert.equal(Number(refused.row.simulationRevision), moved);

        const commits = coordinatorProbe();
        await commits.coordinator.handleCommitResults([{ ...refused, proposal: { revision: stepRevision,
            proposalId: `${far}:1` }, nextState: proposed }]);
        const [ack] = commits.sent.find(message => message.type === 'commit_ack').results;
        const read = await row(far);
        assert.equal(ack.ok, false);
        assert.equal(ack.state.name, 'RenamedUnderStep', 'the ack state carries the main write');
        assert.equal(ack.state.simulation.revision, Number(read.simulationRevision), 'the ack state is the row the commit read');
        assert.equal(commits.coordinator.snapshot().refusals.commitRefused.stale_revision, 1);

        // A stale_command answers with the row read back, not the cached copy.
        const cached = Life.cachedState(far);
        const stale = { ...JSON.parse(JSON.stringify(cached)), updatedAt: cached.updatedAt - 1 };
        const staleCheckpoint = Protocol.safetyCheckpoint(stale);
        await Database.updateGeneratedBotName(far, 'RenamedBehindCache', 5);
        const commands = coordinatorProbe();
        commands.coordinator.handleCommandRequest({ payload: { requests: [{ characterId: far, kind: 'lifecycle',
            commandId: `command:${far}:1`, commandCheckpoint: staleCheckpoint, state: stale,
            precomputedResult: { patch: {}, events: [], materialize: {}, nextResolveAt: 1000 } }] } });
        await commands.coordinator.commandTail;
        const [answer] = commands.sent.find(message => message.type === 'command_ack').results;
        const latest = await row(far);
        assert.equal(answer.reason, 'stale_command');
        assert.equal(answer.state.name, 'RenamedBehindCache', 'stale_command answers with the row');
        assert.equal(answer.state.simulation.revision, Number(latest.simulationRevision));
        assert.equal(Life.cachedState(far).simulation.revision, Number(latest.simulationRevision), 'the reload moves the cache');
        assert.equal(commands.coordinator.snapshot().refusals.staleCommand, 1);

        // A far karma bot that dies under a worker command drops its PK items:
        // the command's save and drop move the row once; it still publishes its death.
        const pk = await create('cold', { restUntil: Date.now() + 30000 });
        await Database.execute(['UPDATE characters SET karma = 100, pk = 6 WHERE id = ?', [pk]]);
        const dying = Life.snapshot(pk);
        const pkRevision = Number((await row(pk)).simulationRevision);
        const deaths = coordinatorProbe();
        deaths.coordinator.population = Population;
        PkDeathDrop.spawn = () => {};
        deaths.coordinator.handleCommandRequest({ payload: { requests: [{ characterId: pk, kind: 'lifecycle',
            commandId: `command:${pk}:1`, commandCheckpoint: Protocol.commandCheckpoint(dying), state: dying,
            precomputedResult: { patch: { activity: 'dead', deathCount: 1, vitals: { ...dying.vitals, hp: 0 } },
                debug: { died: true, fights: 1, wins: 0 }, events: [], materialize: {}, nextResolveAt: Date.now() + 60000 } }] } });
        await deaths.coordinator.commandTail;
        const [died] = deaths.sent.find(message => message.type === 'command_ack').results;
        const dead = await row(pk);
        assert.equal(died.ok, true, `the death command publishes after the drop moved the row: ${died.reason}`);
        assert.equal(JSON.parse(dead.statsJson).pkDropDeathSequence, 1, 'the PK drop ran');
        assert.equal(Number(dead.simulationRevision), pkRevision + 1, 'the drop moved the far row once');
        assert.equal(Life.cachedState(pk).stats.pkDropDeathSequence, 1);
        assert.equal(Life.cachedState(pk).simulation.revision, pkRevision + 1, 'the cache carries the moved revision');

        // A clan demand written into its leader's row moves the cached copy too,
        // so the leader's next commit is not refused on the old revision.
        const leader = await create('cold');
        await Database.execute(['INSERT INTO clans(id,name,leaderId) VALUES(?,?,?)', [820900, 'RevisionClan', leader]]);
        const leaderRevision = Life.cachedState(leader).simulation.revision;
        const signal = await Life.syncClanMarketDemandSignal({ clanId: 820900, itemId: 1419, amount: 1, maxPrice: 100,
            goalKey: 'revision-demand', status: 'open' });
        assert.equal(signal.ok, true);
        assert.equal(Number((await row(leader)).simulationRevision), leaderRevision + 1);
        assert.equal(Life.cachedState(leader).simulation.revision, leaderRevision + 1, 'the leader cache takes the moved row');
        assert.equal(Life.cachedState(leader).stats.clanMarketDemand.goalKey, 'revision-demand');
        const leaderState = Life.cachedState(leader);
        const [leaderCommit] = await Owner.commitBatch([{ revision: leaderState.simulation.revision, nextState: leaderState,
            proposal: { revision: leaderState.simulation.revision } }]);
        assert.equal(leaderCommit.ok, true, `the leader commits on the cached copy: ${leaderCommit.reason}`);

        // A commit writes the proposal's stats as is, except the economy leaf:
        // the row keeps it even when the proposal carries none.
        const leaf = [1, 1, '0f0e0d0c-0b0a-4908-8706-050403020100', 2, 1, 0, 0, 0, 0, null];
        const trader = await create('cold', { economyCommit: leaf });
        assert.deepEqual(JSON.parse((await row(trader)).statsJson).economyCommit, leaf);
        const leafRevision = Life.cachedState(trader).simulation.revision;
        const leafless = { ...Life.cachedState(trader), stats: { ...Life.cachedState(trader).stats, proposalProbe: true } };
        delete leafless.stats.economyCommit;
        const [kept] = await Owner.commitBatch([{ revision: leafRevision, nextState: leafless,
            proposal: { revision: leafRevision } }]);
        assert.equal(kept.ok, true, `the leafless proposal commits: ${kept.reason}`);
        const keptRow = JSON.parse((await row(trader)).statsJson);
        assert.equal(keptRow.proposalProbe, true, 'the proposal\'s stats are written');
        assert.deepEqual(keptRow.economyCommit, leaf, 'the row keeps its economy leaf');
        assert.deepEqual(Life.cachedState(trader).stats.economyCommit, leaf, 'the cache takes the leaf the commit kept');

        // Main taking a far bot hot is a main write: the handoff moves the
        // revision even without a patch, so a step begun before it is refused.
        const handed = await create('cold');
        const handedBefore = await row(handed);
        const handedStep = { ...Life.cachedState(handed), stats: { ...Life.cachedState(handed).stats, proposalProbe: true } };
        const handoff = await Owner.handoffToMain(Life.cachedState(handed));
        assert.equal(handoff.ok, true, `the handoff takes the row: ${handoff.reason}`);
        assert.equal(handoff.reason, 'hot_handoff');
        const handedAfter = await row(handed);
        assert.equal(Number(handedAfter.simulationRevision), Number(handedBefore.simulationRevision) + 1, 'the handoff moves the revision once');
        assert.equal(Number(handedAfter.updatedAt), Number(handedBefore.updatedAt), 'a handoff without a patch writes only the revision');
        const [late] = await Owner.commitBatch([{ revision: Number(handedBefore.simulationRevision), nextState: handedStep,
            proposal: { revision: Number(handedBefore.simulationRevision) } }]);
        assert.equal(late.ok, false);
        assert.equal(late.reason, 'stale_revision', 'a step begun before the handoff is refused');
        console.log('PASS main writes move the revision; refusals rebase on the row');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
    process.exit(0);
})().catch(error => {
    console.error(error);
    process.exit(1);
});
