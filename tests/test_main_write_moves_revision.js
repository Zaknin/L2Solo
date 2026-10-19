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
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'l2solo-main-write-revision-'));
const ACCOUNT = 'bot_main_write_revision';
let sequence = 0;

async function create(phase) {
    const name = `MainWrite${++sequence}`;
    const id = Number((await Database.createCharacter(ACCOUNT, { name,
        race: 0, classId: 0, maxHp: 100, maxMp: 100, sex: 0, face: 0, hair: 0, hairColor: 0,
        locX: 1, locY: 1, locZ: 0 })).insertId);
    await Life.upsertState({ characterId: id, accountName: ACCOUNT, name,
        phase, activity: 'resting', level: 1, inventory: {}, stats: { classId: 0, generatedCold: true },
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
    coordinator.contextIndex = () => ({});
    coordinator.contextFor = () => ({});
    return { coordinator, sent };
}

(async () => {
    try {
        options.default.Database.path = path.join(directory, 'world.sqlite');
        options.default.Database.historyPath = path.join(directory, 'history.sqlite');
        Config.knowledgeErrorsEnabled = false;
        await new Promise(resolve => Database.init(resolve));
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
        const token = await Owner.claim(Life.cachedState(far), { allowLifecycle: true });
        assert(token.ok);
        const proposed = { ...Life.cachedState(far), stats: { ...Life.cachedState(far).stats, proposalProbe: true } };
        await Database.updateGeneratedBotName(far, 'RenamedUnderStep', 4);
        const moved = Number((await row(far)).simulationRevision);
        const [refused] = await Owner.commitAndReleaseBatch([{ token, nextState: proposed, proposal: { token } }]);
        assert.equal(refused.ok, false);
        assert.equal(refused.reason, 'stale_revision', 'the older proposal is refused');
        assert.equal(refused.row.characterName, 'RenamedUnderStep', 'the refusal hands back the row it read');
        assert.equal(Number(refused.row.simulationRevision), moved);

        const commits = coordinatorProbe();
        await commits.coordinator.handleCommitResults([{ ...refused, proposal: { token, proposalId: 'proposal:1' }, nextState: proposed }]);
        const [ack] = commits.sent.find(message => message.type === 'commit_ack').results;
        const released = await row(far);
        assert.equal(ack.ok, false);
        assert.equal(ack.state.name, 'RenamedUnderStep', 'the ack state carries the main write');
        assert.equal(ack.state.simulation.revision, Number(released.simulationRevision), 'the ack state is the row after the release');
        assert.equal(ack.state.simulation.ownerId, released.simulationOwner);
        assert.equal(commits.coordinator.snapshot().refusals.commitRefused.stale_revision, 1);

        // A stale_command answers with the row read back, not the cached copy.
        const cached = Life.cachedState(far);
        const stale = { ...JSON.parse(JSON.stringify(cached)), updatedAt: cached.updatedAt - 1 };
        const staleCheckpoint = Protocol.safetyCheckpoint(stale);
        delete staleCheckpoint.simulationLeaseUntil;
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
        console.log('PASS main writes move the revision; refusals rebase on the row');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
    process.exit(0);
})().catch(error => {
    console.error(error);
    process.exit(1);
});
