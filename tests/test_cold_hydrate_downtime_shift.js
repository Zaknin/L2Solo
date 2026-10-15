'use strict';
// L136: a restart shifts every persisted due time by the downtime (the world
// was paused), bots and active parties, in the row and the cache alike, so the
// worker's first command checkpoint and the party commit fence still match
// the row. updatedAt moves too, so a second boot with no write in between
// shifts only its own gap, not the first downtime again.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
require('./helpers/databaseIsolation');
const secondBoot = process.env.DOWNTIME_SHIFT_SECOND_BOOT_INI;
const fixture = secondBoot ? null : require('./helpers/isolatedSocialDatabase')('cold-hydrate-downtime');
if (secondBoot) process.env.L2NODE_CONFIG_FILE = secondBoot;
require('../src/Global');
if (fixture) fixture.assertConfigured(options.default);
const Database = invoke('Database');
const Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Party = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Protocol = invoke('GameServer/Bot/Population/ColdSimulationProtocol');
const { SERVER_STARTED_AT } = require('../src/GameServer/Bot/Population/Uptime');
const Native = require('./helpers/nativeMarketFixture');
Data.init();
if (fixture) process.on('exit', () => fs.rmSync(fixture.directory, { recursive: true, force: true }));

const loc = { locX: 45596, locY: 247589, locZ: -6518 };
// No startup repair touches these rows (canonical area, hennas, hot skills),
// so the cache can only carry the shift if the boot itself applied it.
const stats = JSON.stringify({ classId: 0, role: 'dps', canonicalAreaId: 'elven_ruins',
    hennas: [null, null, null], coldCombat: { skillSource: 'hot', skills: [] } });
const PARTY = 'downtime-party';

async function bot(id, name, nextResolveAt, updatedAt) {
    const account = `bot_downtime_${id}`;
    await Native.character(Database, id, name, account, loc);
    await Database.execute([`INSERT INTO bot_life_state (characterId,accountName,characterName,level,
        phase,activity,currentRegion,locX,locY,locZ,hp,maxHp,mp,maxMp,inventorySummary,statsJson,
        activityStartedAt,nextResolveAt,lastResolvedAt,updatedAt,simulationOwner,simulationRevision)
        VALUES (?,?,?,18,'cold','hunting','Elven Ruins',?,?,?,100,100,100,100,'{}',?,?,?,?,?,'legacy_main',3)`,
        [id, account, name, loc.locX, loc.locY, loc.locZ, stats,
            updatedAt - 1000, nextResolveAt, updatedAt - 1000, updatedAt]]);
}

function checkpointRow(row) {
    return { ...row, lastHotAt: row.lastHotAt || 0, nextResolveAt: row.nextResolveAt || 0 };
}

async function boot() {
    assert.equal(await Life.init(), true);
    assert.equal(await Party.init(), true);
}

async function run() {
    if (secondBoot) {
        await Database.init();
        await boot();
        return;
    }
    await Database.init();
    const startedAt = Math.floor(SERVER_STARTED_AT), downtime = 60000, lastWrite = startedAt - downtime;
    const rows = {
        overdue: [9600411, 'DowntimeOverdue', lastWrite - 120000, lastWrite],
        later: [9600412, 'DowntimeLater', lastWrite + 300000, lastWrite - 30000],
        unset: [9600413, 'DowntimeUnset', null, lastWrite - 10000],
        // A write stamped after this process started (clock moved back):
        // neither the downtime source nor shifted.
        future: [9600414, 'DowntimeFuture', startedAt + 7200000, startedAt + 3600000]
    };
    for (const [id, name, next, updated] of Object.values(rows)) await bot(id, name, next, updated);
    const party = { nextResolveAt: lastWrite - 5000, updatedAt: lastWrite - 20000 };
    await Database.execute([`INSERT INTO bot_background_parties (partyId,leaderId,memberIdsJson,spotId,startedAt,
        nextResolveAt,cohesion,risk,status,roleCoverageJson,statsJson,updatedAt)
        VALUES (?,?,?,NULL,?,?,0.65,0.25,'active','{}','{}',?)`,
        [PARTY, 9600415, JSON.stringify([9600415, 9600416]), lastWrite - 600000, party.nextResolveAt, party.updatedAt]]);
    await boot();

    const shifted = (value, moved) => moved ? value + downtime : value;
    const expected = {
        overdue: [shifted(rows.overdue[2], true), shifted(rows.overdue[3], true)],
        later: [shifted(rows.later[2], true), shifted(rows.later[3], true)],
        unset: [null, rows.unset[3]],
        future: [rows.future[2], rows.future[3]]
    };
    for (const [key, [id]] of Object.entries(rows)) {
        const state = Life.cachedState(id);
        const [row] = await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [id]]);
        assert.equal(state.timing.nextResolveAt, expected[key][0], `${key}: cached due time`);
        assert.equal(row.nextResolveAt === null ? null : Number(row.nextResolveAt), expected[key][0], `${key}: row due time`);
        assert.equal(Number(row.updatedAt), expected[key][1], `${key}: updatedAt moves with the due time`);
        assert.equal(state.updatedAt, Number(row.updatedAt), `${key}: cached updatedAt matches the row`);
        assert(Protocol.sameCommandCheckpoint(state, checkpointRow(row)),
            `${key}: the worker's first command checkpoint matches the row`);
    }
    const cachedParty = Party.find(PARTY);
    const [partyRow] = await Database.execute(['SELECT * FROM bot_background_parties WHERE partyId=?', [PARTY]]);
    assert.equal(cachedParty.nextResolveAt, party.nextResolveAt + downtime, 'party: cached due time');
    assert.equal(Number(partyRow.nextResolveAt), party.nextResolveAt + downtime, 'party: row due time');
    assert.equal(Number(partyRow.updatedAt), party.updatedAt + downtime, 'party: updatedAt moves with the due time');
    assert.equal(cachedParty.updatedAt, Number(partyRow.updatedAt), 'party: the commit fence (updatedAt) matches the row');
    await Database.close();

    // Second boot on the same DB, no write in between: only its own gap.
    const child = spawnSync(process.execPath, [__filename], {
        env: { ...process.env, DOWNTIME_SHIFT_SECOND_BOOT_INI: fixture.ini }, encoding: 'utf8' });
    assert.equal(child.status, 0, `second boot failed: ${child.stdout}\n${child.stderr}`);
    const line = /cold hydrate: shifted (\d+) due times by (\d+) ms/.exec(child.stdout);
    assert(line, `second boot shifts and logs: ${child.stdout}`);
    const gap = Number(line[2]);
    assert(gap > 0 && gap < downtime / 2, `second boot shifts only its gap, not the downtime again (got ${gap} ms)`);
    const db = new DatabaseSync(fixture.world, { readOnly: true });
    const overdue = db.prepare('SELECT nextResolveAt FROM bot_life_state WHERE characterId=?').get(rows.overdue[0]);
    const partyAfter = db.prepare('SELECT nextResolveAt FROM bot_background_parties WHERE partyId=?').get(PARTY);
    db.close();
    assert.equal(Number(overdue.nextResolveAt), expected.overdue[0] + gap, 'second boot: bot moved by the gap only');
    assert.equal(Number(partyAfter.nextResolveAt), party.nextResolveAt + downtime + gap, 'second boot: party moved by the gap only');
    console.log('cold hydrate downtime shift PASS: bots and party +%d ms in row and cache, future write ignored, second boot +%d ms only',
        downtime, gap);
}
run().then(() => Database.close()).catch(async error => { console.error(error); process.exitCode = 1; await Database.close(); });
