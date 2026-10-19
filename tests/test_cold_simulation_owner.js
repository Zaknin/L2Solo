process.env.BOT_DEVELOPER_DIAGNOSTICS = 'true'; // This fixture inspects optional developer metrics.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('../src/Global');

const Database = invoke('Database');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const BotLifeState = invoke('GameServer/Bot/Population/BotLifeState');
const databasePath = path.join(process.cwd(), 'tmp', 'test-cold-simulation-owner.sqlite');

fs.rmSync(databasePath, { force: true });
options.default.Database.path = path.relative(process.cwd(), databasePath);
Database.init();

function state(characterId, revision, activity = 'hunting') {
    return {
        characterId,
        accountName: 'owner_probe',
        name: 'OwnerProbe',
        level: 20,
        exp: 1000,
        sp: 100,
        adena: 500,
        phase: 'cold',
        activity,
        loc: { locX: 10, locY: 20, locZ: -30 },
        vitals: { hp: 100, maxHp: 100, mp: 50, maxMp: 50 },
        timing: { activityStartedAt: 100, nextResolveAt: 1000, lastResolvedAt: 500, lastHotAt: null },
        party: { partyId: null },
        stats: {},
        inventory: {},
        simulation: { ownerId: Owner.LEGACY_OWNER_ID, revision, leaseId: null, leaseUntil: 0 },
        updatedAt: 1000
    };
}

(async () => {
    await Database.createAccount('owner_probe', 'secret');
    await Database.createCharacter('owner_probe', {
        name: 'OwnerProbe', race: 0, classId: 0, maxHp: 100, maxMp: 50,
        sex: 0, face: 0, hair: 0, hairColor: 0, locX: 10, locY: 20, locZ: -30
    });
    const character = (await Database.fetchCharacters('owner_probe'))[0];
    const characterId = Number(character.id);
    await Database.execute([
        `INSERT INTO bot_life_state (
            characterId, accountName, characterName, level, activity, phase,
            locX, locY, locZ, hp, maxHp, mp, maxMp, statsJson, inventorySummary, updatedAt
        ) VALUES (?, ?, ?, 20, 'hunting', 'cold', 10, 20, -30, 100, 100, 50, 50, '{}', '{}', 1000)`,
        [characterId, 'owner_probe', 'OwnerProbe']
    ]);

    const columns = await Database.execute(['PRAGMA table_info(bot_life_state)', []]);
    for (const column of ['simulationOwner', 'simulationRevision', 'simulationLeaseId', 'simulationLeaseUntil']) {
        assert(columns.some((entry) => entry.name === column), `migration must add ${column}`);
    }
    const migrations = await Database.execute(['SELECT version FROM schema_migrations WHERE version = 10', []]);
    assert.strictEqual(migrations.length, 1, 'ownership schema migration must be recorded exactly once');

    for (const activity of ['hunting', 'resting', 'traveling', 'dead']) {
        assert.strictEqual(Owner.eligibility(state(characterId, 0, activity)).ok, true, `${activity} is a simple solo cold path`);
    }
    assert.strictEqual(Owner.eligibility({ ...state(characterId, 0), party: { partyId: 'bgp_1' } }).reason, 'background_party');
    assert.strictEqual(Owner.eligibility({ ...state(characterId, 0), activity: 'merchant', stats: { marketStore: {} } }).reason, 'legacy_activity');
    assert.strictEqual(Owner.eligibility({ ...state(characterId, 0), activity: 'crafting', stats: { craftShop: {} } }).reason, 'legacy_activity');
    assert.strictEqual(Owner.eligibility({ ...state(characterId, 0), activity: 'party_wait' }).reason, 'legacy_activity');
    assert.strictEqual(Owner.eligibility({ ...state(characterId, 0), stats: { supplyErrand: {} } }).reason, 'player_workflow');
    assert.strictEqual(Owner.eligibility({ ...state(characterId, 0), stats: { equipmentPlan: { strategy: 'market' } } }).reason, 'market_plan');
    assert.strictEqual(Owner.eligibility({ ...state(characterId, 0), stats: { equipmentPlan: { strategy: 'craft' } } }).reason, 'craft_plan');
    assert.strictEqual(Owner.eligibility({
        ...state(characterId, 0, 'traveling'),
        stats: { travel: { arrivalActivity: 'shopping', reason: 'market_search_for_weapon' } }
    }).reason, 'legacy_travel');
    assert.strictEqual(Owner.eligibility(state(characterId, 0), { hasWarehouseWorkflow: true }).reason, 'warehouse_state');
    assert.strictEqual(Owner.eligibility({ ...state(characterId, 0), stats: { warehouseErrand: {} } }).reason, 'warehouse_state');
    assert(Owner.eligibility({ ...state(characterId, 0), stats: { craftReturn: { loc: {} },
        equipmentPlan: { status: 'deferred', strategy: 'none' } } }).ok,
    'an abandoned craft return point is not an active crafting service');

    const initialState = state(characterId, 0);
    BotLifeState.acceptSimulationOwnership(characterId, initialState.simulation, initialState);
    const queuedBeforeMigration = BotLifeState.upsertState({
        ...initialState,
        stats: { generatedCold: true, generatedIndex: 700 }
    }, 'appearance_race_before');
    const queuedMigration = BotLifeState.acceptAppearanceMetadata(characterId, 1, 2);
    const queuedNameMigration = BotLifeState.acceptNameMetadata(characterId, 'NewOwnerNick', 3);
    const [queuedSave, migratedLifecycle, renamed] = await Promise.all([
        queuedBeforeMigration,
        queuedMigration,
        queuedNameMigration
    ]);
    assert(queuedSave, 'the save queued before the migrations lands');
    assert.strictEqual(migratedLifecycle.appearanceVersion, 2,
        'appearance migration must run in the per-character lifecycle write chain');
    assert.strictEqual(renamed.name, 'NewOwnerNick');
    assert.strictEqual(renamed.nameGeneratorVersion, 3);
    const versioned = (await Database.execute([
        'SELECT characterName, nameGeneratorVersion, appearanceVersion FROM bot_life_state WHERE characterId = ?',
        [characterId]
    ]))[0];
    assert.deepStrictEqual([versioned.characterName, Number(versioned.nameGeneratorVersion), Number(versioned.appearanceVersion)],
        ['NewOwnerNick', 3, 2], 'the name and look versions live in their own columns');

    // The generated look and name writes each moved the far row's revision
    // once, and the cache carries the written number.
    assert.strictEqual(BotLifeState.cachedState(characterId).simulation.revision, 2,
        'each main write to a far row moves its revision once');
    const [invalidPatch] = await Database.commitAndReleaseColdSimulationLeases([{
        characterId,
        expectedRevision: 2,
        timestamp: 1800,
        patch: { arbitraryColumn: 1 }
    }]);
    assert.strictEqual(invalidPatch.reason, 'invalid_patch', 'gateway must reject fields outside the explicit bridge protocol');

    const migratedAppearance = await BotLifeState.acceptAppearanceMetadata(characterId, 1, 2);
    assert.strictEqual(migratedAppearance.appearanceVersion, 2,
        'appearance metadata must patch atomically');
    assert.strictEqual(BotLifeState.cachedState(characterId).appearanceVersion, 2,
        'appearance migration must patch the active lifecycle cache without replacing other state');

    // The worker proposes on the state it stepped from: its name and look ride along.
    const resting = {
        ...state(characterId, 0, 'resting'),
        name: BotLifeState.cachedState(characterId).name,
        appearanceVersion: BotLifeState.cachedState(characterId).appearanceVersion,
        stats: { restUntil: 9000 },
        inventory: {
            57: { selfId: 57, name: 'Adena', amount: 500 },
            9999: { selfId: 9999, name: 'Consumed Probe', amount: 0 }
        },
        timing: { activityStartedAt: 2000, nextResolveAt: 9000, lastResolvedAt: 2000, lastHotAt: null },
        updatedAt: 2000
    };
    const commitOn = (revision, nextState, timestamp) => Owner.commitBatch([{ revision, nextState }], { timestamp })
        .then(([result]) => result);
    // The look write during the step moved the row: the proposal built before
    // it is refused and the step is redone on the row.
    assert.strictEqual((await commitOn(0, resting, 2000)).reason, 'stale_revision',
        'a proposal built before a main write is refused');
    const step = BotLifeState.cachedState(characterId).simulation.revision;
    const committed = await commitOn(step, resting, 2000);
    assert.strictEqual(committed.ok, true, 'owner proposal must commit through the main database gateway');
    assert.strictEqual(committed.revision, step + 1, 'conditional commit must advance the revision');
    assert.strictEqual(Number(committed.row.simulationRevision), committed.revision, 'the commit hands back the revision it wrote');
    assert.strictEqual(BotLifeState.cachedState(characterId).activity, 'resting', 'commit must reflect the accepted state in cache');
    assert.strictEqual(BotLifeState.cachedState(characterId).simulation.revision, committed.revision, 'commit must reflect its revision in cache');
    assert.strictEqual(BotLifeState.cachedState(characterId).inventory['9999'], undefined,
        'committed cache state must not retain a zero-amount inventory entry');
    const committedInventory = JSON.parse((await Database.execute([
        'SELECT inventorySummary FROM bot_life_state WHERE characterId = ?', [characterId]
    ]))[0].inventorySummary);
    assert.strictEqual(committedInventory['9999'], undefined,
        'cold-owner persistence must not write a zero-amount inventory entry');
    const committedRow = (await Database.execute([
        'SELECT statsJson, characterName, nameGeneratorVersion, appearanceVersion FROM bot_life_state WHERE characterId = ?', [characterId]
    ]))[0];
    // The commit patch carries no name or look version: the columns keep what their writers set.
    assert.deepStrictEqual([committedRow.characterName, Number(committedRow.nameGeneratorVersion), Number(committedRow.appearanceVersion)],
        ['NewOwnerNick', 3, 2], 'a commit leaves the name and its versions to their writers');
    assert.strictEqual(BotLifeState.cachedState(characterId).name, 'NewOwnerNick');
    assert.strictEqual(JSON.parse(committedRow.statsJson).restUntil, 9000, 'the commit writes the worker\'s stats');
    assert.strictEqual(BotLifeState.cachedState(characterId).appearanceVersion, 2,
        'the main cache keeps the look version over a commit');
    const committedCharacter = (await Database.fetchCharacters('owner_probe'))[0];
    assert.strictEqual(committedCharacter.name, 'NewOwnerNick');
    assert.strictEqual(Number(committedCharacter.sex), 1,
        'the same migration transaction must update the physical character appearance');

    assert.strictEqual(BotLifeState.cachedState(characterId).simulation.ownerId, Owner.LEGACY_OWNER_ID,
        'a commit returns the bot to main');

    const staleCommit = await commitOn(step, { ...resting, activity: 'hunting' }, 2100);
    assert.strictEqual(staleCommit.reason, 'stale_revision', 'an old step must never overwrite a newer revision');
    const partitionFailure = await commitOn(committed.revision, { ...resting, activity: 'crafting', stats: { craftShop: {} } }, 2200);
    assert.strictEqual(partitionFailure.reason, 'partition_rejected', 'owner cannot cross into a legacy-main activity');

    const handoff = await Owner.handoffToMain(BotLifeState.cachedState(characterId), { timestamp: 3000 });
    assert.strictEqual(handoff.reason, 'hot_handoff');
    assert.strictEqual(handoff.revision, committed.revision + 1, 'a hot activation moves the revision before spawning');
    const postHandoffCommit = await commitOn(committed.revision, resting, 3200);
    assert.strictEqual(postHandoffCommit.reason, 'stale_revision', 'handoff must fence a late cold commit');

    // A loan an older server left in the row returns to main at startup.
    await Database.execute([`UPDATE bot_life_state SET simulationOwner = ?, simulationLeaseId = 'lease-old',
        simulationLeaseUntil = 99999999999999 WHERE characterId = ?`, [Owner.OWNER_ID, characterId]]);
    assert.strictEqual((await Owner.recoverStartupLeases()).affectedRows, 1, 'a startup loan must recover to legacy_main');
    const recovered = (await Database.execute([
        'SELECT simulationOwner, simulationRevision, simulationLeaseId, simulationLeaseUntil FROM bot_life_state WHERE characterId = ?',
        [characterId]
    ]))[0];
    assert.strictEqual(recovered.simulationOwner, Owner.LEGACY_OWNER_ID);
    assert.strictEqual(recovered.simulationRevision, handoff.revision + 1);
    assert.strictEqual(recovered.simulationLeaseId, null);
    assert.strictEqual(recovered.simulationLeaseUntil, 0);
    assert.strictEqual(BotLifeState.cachedState(characterId).simulation.ownerId, Owner.LEGACY_OWNER_ID, 'recovery must return cached ownership to main');
    assert.strictEqual(BotLifeState.cachedState(characterId).simulation.revision, recovered.simulationRevision, 'recovery must reflect its revision in cache');

    await Database.execute([
        `UPDATE bot_life_state
         SET activity = 'resting', phase = 'cold', adena = 100,
             inventorySummary = ?, statsJson = '{}'
         WHERE characterId = ?`,
        [JSON.stringify({ 57: { selfId: 57, name: 'Adena', amount: 100 } }), characterId]
    ]);
    // A clan inventory write moves the row under a step: the step's commit is
    // refused and the row keeps the new inventory.
    const raceRevision = Number(recovered.simulationRevision);
    const inventoryAfterClanWrite = JSON.stringify({ '1869': { selfId: 1869, amount: 42 } });
    await Database.execute([`UPDATE bot_life_state SET simulationRevision = simulationRevision + 1,
        inventorySummary = ?, statsJson = ? WHERE characterId = ?`,
    [inventoryAfterClanWrite, JSON.stringify({ clanInventoryRevision: raceRevision + 1 }), characterId]]);
    const rejectedCommit = await commitOn(raceRevision, resting, 6400);
    assert.strictEqual(rejectedCommit.reason, 'stale_revision');
    const [afterRace] = await Database.execute(['SELECT * FROM bot_life_state WHERE characterId = ?', [characterId]]);
    assert.strictEqual(afterRace.inventorySummary, inventoryAfterClanWrite, 'a refused commit preserves the new inventory');
    assert.strictEqual(JSON.parse(afterRace.statsJson).clanInventoryRevision, raceRevision + 1);
    assert.strictEqual(afterRace.simulationOwner, Owner.LEGACY_OWNER_ID);

    // Developer diagnostics: an item read counts under its call-site tag.
    await Database.fetchItems(characterId, 'owner_probe');
    assert.strictEqual(invoke('GameServer/Bot/Economy/EconomyDiagnostics').metrics().counts['item_list:call:owner_probe'], 1);

    const dbStats = Database.stats();
    assert.strictEqual(path.resolve(dbStats.path), path.resolve(databasePath), 'all owner operations must use the one configured SQLite gateway');
    console.log('Cold simulation owner revision fence, handoff, and recovery checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => Database.close());
