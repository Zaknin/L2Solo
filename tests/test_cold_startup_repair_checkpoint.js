'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('cold-startup-repair');
require('../src/Global');
fixture.assertConfigured(options.default);
const Database = invoke('Database');
const Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Protocol = invoke('GameServer/Bot/Population/ColdSimulationProtocol');
const Checkpoint = invoke('GameServer/Bot/Population/NativeWriteCheckpoint');
const Native = require('./helpers/nativeMarketFixture');
Data.init();
process.on('exit', () => fs.rmSync(fixture.directory, { recursive: true, force: true }));
async function run() {
    await Database.init();
    const id = 9600317, old = Date.now() - 600000;
    const loc = { locX: 45596, locY: 247589, locZ: -6518 };
    await Native.character(Database, id, 'RepairCheckpoint', 'bot_repair_checkpoint', loc);
    await Database.execute([`INSERT INTO bot_life_state (characterId,accountName,characterName,level,
        phase,activity,currentRegion,locX,locY,locZ,hp,maxHp,mp,maxMp,inventorySummary,statsJson,
        activityStartedAt,nextResolveAt,lastResolvedAt,updatedAt,simulationRevision)
        VALUES (?,?,'RepairCheckpoint',18,'cold','hunting','Skeleton fields',?,?,?,100,100,100,100,'{}',?,?,?,?,?,17)`,
        [id, 'bot_repair_checkpoint', loc.locX, loc.locY, loc.locZ,
            JSON.stringify({ classId: 0, role: 'dps', coldCombat: { skillSource: 'hot', skills: [] } }),
            old, old + 30000, old, old]]);
    assert.equal(await Life.init(), true);
    const state = Life.cachedState(id);
    assert.equal(state.currentRegion, 'Elven Ruins', 'fixture must execute the actual startup area repair');
    assert.equal(state.stats.canonicalAreaId, 'elven_ruins');
    const [row] = await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [id]]);
    assert(row.updatedAt > old, 'startup repair must persist a new checkpoint');
    assert.equal(state.updatedAt, row.updatedAt, 'cache must publish the saved timestamp, not the pre-repair state');
    assert(Protocol.sameCommandCheckpoint(state, { ...row, lastHotAt: row.lastHotAt || 0 }),
        'all ownership, activity and time fields must match before the worker issues its first command');
    const beforeWrite = Checkpoint.create(id, { workerAdmission: {
        characterId: id, commandId: 'repair-first-command', commandCheckpoint: Protocol.commandCheckpoint(state),
        check: () => null
    } });
    const proof = Checkpoint.capture(beforeWrite, id);
    assert.doesNotThrow(() => Checkpoint.check(proof, row), 'the first native command must be admitted after repair');
    await Database.execute(['UPDATE bot_life_state SET updatedAt=updatedAt+1 WHERE characterId=?', [id]]);
    const [changed] = await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [id]]);
    assert.throws(() => Checkpoint.check(proof, changed), error => error.code === 'BOT_WORKER_COMMAND_ADMISSION_REFUSED',
        'a later foreign write must still invalidate the original proof');
    const baseline = Life.coldDueSummary(1000).due;
    const meetingState = { ...state, activity: 'shopping',
        stats: { classId: 0, tradeMeeting: [924, 1] }, timing: { nextResolveAt: 1 } };
    await Life.upsertState(meetingState, 'meeting_wait_probe');
    assert.equal(Life.coldDueSummary(1000).due, baseline,
        'an arrived event-driven trader must not inflate queue depth or age');
    await Life.upsertState({ ...meetingState, activity: 'traveling' }, 'meeting_travel_probe');
    assert.equal(Life.coldDueSummary(1000).due, baseline + 1,
        'an overdue meeting journey still requires a resolver and belongs in the queue');
    console.log('cold startup repair checkpoint PASS: durable region repair, first command and strict foreign-write fence');
}
run().then(() => Database.close()).catch(async error => { console.error(error); process.exitCode = 1; await Database.close(); });
