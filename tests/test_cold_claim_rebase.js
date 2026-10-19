const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('../src/Global');

const databasePath = path.join(process.cwd(), 'tmp', 'test-cold-claim-rebase.sqlite');
fs.rmSync(databasePath, { force: true });
fs.rmSync(`${databasePath}-wal`, { force: true });
fs.rmSync(`${databasePath}-shm`, { force: true });
options.default.Database.path = path.relative(process.cwd(), databasePath);

const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');

DataCache.init();
Database.init();

const originalClaimBatch = Owner.claimBatch;

(async () => {
    await Database.createAccount('claim_rebase_probe', 'secret');
    await Database.createCharacter('claim_rebase_probe', {
        name: 'ClaimRebaseProbe', race: 0, classId: 0,
        maxHp: 300, maxMp: 120, sex: 0, face: 0, hair: 0, hairColor: 0,
        locX: -84191, locY: 244577, locZ: -3729
    });
    const [character] = await Database.fetchCharacters('claim_rebase_probe');
    assert(character?.id, 'claim rebase fixture character must exist');
    const characterId = Number(character.id);
    const dueAt = Date.now() - 60000;
    await Database.execute([`
        INSERT INTO bot_life_state (
            characterId, accountName, characterName, level, exp, sp, adena,
            homeRegion, currentRegion, spotId, activity, phase,
            activityStartedAt, nextResolveAt, lastResolvedAt,
            locX, locY, locZ, hp, maxHp, mp, maxMp,
            statsJson, inventorySummary, updatedAt,
            simulationOwner, simulationRevision
        ) VALUES (?, 'claim_rebase_probe', 'ClaimRebaseProbe', 20, 1000, 100, 500,
            'Talking Island', 'Talking Island', NULL, 'resting', 'cold',
            ?, ?, ?, -84191, 244577, -3729, 300, 300, 120, 120,
            ?, '{}', ?, 'legacy_main', 1)`,
        [characterId, dueAt - 60000, dueAt, dueAt - 60000,
            JSON.stringify({ restUntil: dueAt - 1 }), dueAt]
    ]);
    assert.strictEqual(await LifeState.init(), true);
    assert.strictEqual(LifeState.cachedState(characterId).simulation.revision, 1);

    await Database.execute([
        `UPDATE bot_life_state
         SET simulationRevision = ?, updatedAt = ?
         WHERE characterId = ?`,
        [9, Date.now(), characterId]
    ]);

    Owner.claimBatch = async () => ({
        grants: [],
        rejected: [{
            ok: false,
            characterId,
            reason: 'stale_revision',
            expectedRevision: 1,
            actualRevision: 9
        }]
    });

    const coordinator = new ColdSimulationCoordinator();
    let response = null;
    coordinator.postCollections = (type, payload) => {
        response = { type, payload };
    };

    await coordinator.handleClaimRequest({
        msgId: 'claim-rebase-probe',
        payload: {
            candidates: [{
                characterId,
                expectedRevision: 1,
                purpose: { kind: 'resolver' }
            }]
        }
    });

    const rejection = response?.payload?.rejected?.[0];
    assert.strictEqual(response?.type, 'claim_ack');
    assert.strictEqual(rejection?.reason, 'stale_revision');
    assert.strictEqual(rejection?.state?.simulation?.revision, 9,
        'stale claim must return the authoritative SQLite revision to the worker');
    assert.strictEqual(rejection?.retryAfterMs, 1000,
        'ownership conflicts must not immediately re-enter the claim loop');
    assert.strictEqual(LifeState.cachedState(characterId).simulation.revision, 9,
        'authoritative rebase must refresh the coordinator cache');

    // E272: a flat own simulationOwner makes the worker treat the state as flat
    // wire input, refuse every command and never schedule the bot again.
    const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
    const cached = LifeState.cachedState(characterId);
    assert(!Object.hasOwn(cached, 'simulationOwner'), 'cached native state carries no flat owner');
    assert(Protocol.commandCheckpoint(cached), 'cached state stays commandable by the worker');
    assert(!Object.hasOwn(rejection.state, 'simulationOwner'), 'rebase state sent to the worker carries no flat owner');
    assert(Protocol.commandCheckpoint(rejection.state), 'rebase state stays commandable by the worker');
    const [hydrated] = await LifeState.statesByIds([characterId]);
    assert.strictEqual(hydrated.simulationOwner, hydrated.simulation.ownerId, 'clan readers still see the flat owner');
    assert.strictEqual(hydrated.simulationOwner, 'legacy_main');
    assert.notStrictEqual(hydrated, LifeState.cachedState(characterId), 'the decorated row is a copy, not the cache entry');
    assert(!Object.hasOwn(LifeState.cachedState(characterId), 'simulationOwner'));

    console.log('Cold claim authoritative rebase checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(async () => {
    Owner.claimBatch = originalClaimBatch;
    await Database.close().catch(() => null);
    fs.rmSync(databasePath, { force: true });
    fs.rmSync(`${databasePath}-wal`, { force: true });
    fs.rmSync(`${databasePath}-shm`, { force: true });
});
