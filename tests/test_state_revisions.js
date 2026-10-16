'use strict';
// The bag, skills and henna revisions on bot_life_state (migration 68): the
// triggers move each on a real change only, the cold commit moves the bag
// revision with its own write (once), the committed row and state carry them,
// and the commit stamps the combat kit with the skills revision it checked.
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('./helpers/isolatedSocialDatabase')('state-revisions');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const DB = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
const Native = require('./helpers/nativeMarketFixture');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const id = 9771, loc = { locX: 83396, locY: 147904, locZ: -3400 };

async function revisions() {
    const [row] = await DB.execute(['SELECT * FROM bot_life_state WHERE characterId = ?', [id]]);
    return { row, ...DB.stateRevisions(row) };
}

async function run() {
    await DB.init();
    assert.deepEqual(DB.stateRevisions(undefined), { inventoryRevision: 0, skillsRevision: 0, hennaRevision: 0 },
        'a row without the columns reads as unknown (0)');
    await Native.character(DB, id, 'RevisionBot', 'bot_revision', loc);
    await DB.execute(['UPDATE characters SET level=20,classId=0,race=0 WHERE id=?', [id]]);
    const stats = { classId: 0, hennas: [], coldCombat: Profile.legacySnapshot({ level: 20, stats: { classId: 0 } }) };
    await DB.execute([`INSERT INTO bot_life_state(characterId,accountName,characterName,level,phase,activity,
        currentRegion,locX,locY,locZ,statsJson,inventorySummary) VALUES(?, 'bot_revision','RevisionBot',20,'cold','hunting','Giran',?,?,?,?,'{}')`,
    [id, loc.locX, loc.locY, loc.locZ, JSON.stringify(stats)]]);
    let at = await revisions();
    assert.deepEqual([at.inventoryRevision, at.skillsRevision, at.hennaRevision], [0, 0, 0], 'a new row starts at 0');

    // Skills: a new row, a same-level upsert (no move), a level, a delete.
    await DB.execute(['INSERT INTO skills (selfId, name, passive, level, characterId) VALUES (3, \'Power Strike\', 0, 1, ?)', [id]]);
    assert.equal((await revisions()).skillsRevision, 1, 'a learned skill moves skillsRevision');
    await DB.execute(['UPDATE skills SET level = 1 WHERE characterId = ? AND selfId = 3', [id]]);
    assert.equal((await revisions()).skillsRevision, 1, 'an unchanged skill row does not move it');
    await DB.execute(['UPDATE skills SET level = 2 WHERE characterId = ? AND selfId = 3', [id]]);
    assert.equal((await revisions()).skillsRevision, 2, 'a new rank moves it');
    await DB.execute(['DELETE FROM skills WHERE characterId = ? AND selfId = 3', [id]]);
    assert.equal((await revisions()).skillsRevision, 3, 'a forgotten skill moves it');

    // Hennas through their public writers.
    await DB.setCharacterHenna(id, 1, 133);
    assert.equal((await revisions()).hennaRevision, 1, 'a dyed slot moves hennaRevision');
    await DB.deleteCharacterHenna(id, 1);
    assert.equal((await revisions()).hennaRevision, 2, 'a removed symbol moves it');

    // The stored bag summary: any writer moves it, an equal write does not.
    await DB.execute(['UPDATE bot_life_state SET inventorySummary = ? WHERE characterId = ?', ['{"57":{"selfId":57,"amount":5}}', id]]);
    assert.equal((await revisions()).inventoryRevision, 1, 'a changed summary moves inventoryRevision');
    await DB.execute(['UPDATE bot_life_state SET inventorySummary = ? WHERE characterId = ?', ['{"57":{"selfId":57,"amount":5}}', id]]);
    assert.equal((await revisions()).inventoryRevision, 1, 'an equal summary does not');

    // The cold commit: one bag revision step, the built row equals the stored
    // row, the committed state carries the revisions, the kit gets the stamp.
    await Life.init();
    let state = Life.cachedState(id);
    const claim = await Owner.claim(state, { allowLifecycle: true });
    assert(claim.ok, `claim: ${claim.reason}`);
    const leased = Life.cachedState(id);
    const inventory = { ...leased.inventory, 1835: { selfId: 1835, name: 'Soulshot: No Grade', amount: 100, stackable: true } };
    const before = await revisions();
    const [result] = await Owner.commitAndReleaseBatch([{ token: claim, nextState: { ...leased, inventory },
        proposal: { baseState: leased }, options: { allowLifecycle: true } }]);
    assert(result.ok, `commit: ${result.reason}`);
    at = await revisions();
    assert.equal(at.inventoryRevision, before.inventoryRevision + 1, 'the commit moves the bag revision once (no trigger second write)');
    const { acceptedIncoming, incomingPending, ...columns } = result.row;
    assert.deepEqual(columns, { ...at.row }, 'the built committed row equals the stored row, revisions included');
    state = Life.cachedState(id);
    assert.equal(DB.stateRevisions(state).inventoryRevision, at.inventoryRevision, 'the committed state carries the bag revision');
    assert.equal(DB.stateRevisions(state).skillsRevision, at.skillsRevision, 'and the skills revision');
    const kit = JSON.parse(at.row.statsJson).coldCombat;
    assert.equal(kit.skillsRevision, at.skillsRevision, 'the checked kit carries the skills revision it was checked against');
    console.log('State revision checks passed');
}

run().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
