'use strict';

// U54: save validation and restore rollback validation share one SQLite
// quick_check rule. Pin each caller's error text and status, and that a
// native open/read failure passes through unchanged.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const SavedGames = require('../scripts/saved-games');
const Restore = require('../src/DatabaseRestore');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'l2solo-integrity-'));

function database(file, { freelistDamage = false } = {}) {
    fs.rmSync(file, { force: true });
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = DELETE; CREATE TABLE t(a TEXT);');
    const insert = db.prepare('INSERT INTO t(a) VALUES (?)');
    db.exec('BEGIN');
    for (let n = 0; n < 500; n++) insert.run(`value-${n}`);
    db.exec('COMMIT');
    db.close();
    if (freelistDamage) {
        // Opens and reads, but quick_check reports a row other than "ok".
        const bytes = fs.readFileSync(file);
        bytes.writeUInt32BE(3, 36);
        fs.writeFileSync(file, bytes);
    }
    return file;
}

function malformed(file) {
    // A valid header with damaged pages: SQLite itself throws.
    database(file);
    const bytes = fs.readFileSync(file);
    const pageSize = bytes.readUInt16BE(16);
    bytes.fill(0xff, pageSize + 8, pageSize + 40);
    fs.writeFileSync(file, bytes);
    return file;
}

function quickCheck(file) {
    const db = new DatabaseSync(file, { readOnly: true });
    try { return db.prepare('PRAGMA quick_check').all(); } finally { db.close(); }
}

function restoreCase(name, prepare) {
    const dir = path.join(temp, name);
    fs.mkdirSync(dir);
    const worldPath = path.join(dir, 'world.sqlite');
    const historyPath = path.join(dir, 'history.sqlite');
    database(worldPath);
    const id = crypto.randomUUID();
    prepare(Restore.files(worldPath, id).previous);
    fs.writeFileSync(Restore.markerPath(worldPath), JSON.stringify({
        version: 1, id, phase: 'installing', historyPath: path.resolve(historyPath), hadWorld: true, hadHistory: false
    }));
    const before = fs.readFileSync(worldPath);
    let error = null;
    try { Restore.recover(worldPath, historyPath); } catch (caught) { error = caught; }
    return { error, unchanged: Buffer.compare(before, fs.readFileSync(worldPath)) === 0, worldPath };
}

async function saveCase(name, damage) {
    const dir = path.join(temp, name);
    fs.mkdirSync(dir);
    const databasePath = database(path.join(dir, 'world.sqlite'));
    const savesDir = path.join(dir, 'saves');
    const options = { databasePath, historyPath: path.join(dir, 'history.sqlite'), savesDir };
    const save = await SavedGames.run({ ...options, operation: 'create', name: 'pin' });
    damage(path.join(savesDir, save.id, 'database.sqlite'));
    const before = fs.readFileSync(databasePath);
    let error = null;
    try { await SavedGames.run({ ...options, operation: 'load', id: save.id }); } catch (caught) { error = caught; }
    assert(Buffer.compare(before, fs.readFileSync(databasePath)) === 0, `${name}: a rejected load leaves the world untouched`);
    return error;
}

async function main() {
    assert.notStrictEqual(quickCheck(database(path.join(temp, 'probe.sqlite'), { freelistDamage: true }))[0].quick_check, 'ok',
        'fixture: freelist damage fails quick_check without throwing');

    let result = restoreCase('restore-bad', (file) => database(file, { freelistDamage: true }));
    assert(result.error, 'restore refuses a rollback source that fails quick_check');
    assert.strictEqual(result.error.message, 'Restore database integrity check failed.');
    assert.strictEqual(result.error.statusCode, undefined);
    assert(result.unchanged, 'restore validates before replacing the world');

    result = restoreCase('restore-malformed', malformed);
    assert(result.error);
    assert.match(result.error.message, /malformed/, 'a native SQLite failure is not rewritten');
    assert(result.unchanged);

    result = restoreCase('restore-good', (file) => database(file));
    assert.strictEqual(result.error, null, 'a sound rollback source restores');
    assert(!fs.existsSync(Restore.markerPath(result.worldPath)), 'a finished rollback clears its marker');

    let error = await saveCase('save-bad', (file) => database(file, { freelistDamage: true }));
    assert(error, 'load refuses a save that fails quick_check');
    assert.strictEqual(error.message, 'Database integrity check failed.');
    assert.strictEqual(error.statusCode, 400);

    error = await saveCase('save-header', (file) => fs.writeFileSync(file, 'damaged save'));
    assert.strictEqual(error.message, 'The save is not a valid SQLite database.');
    assert.strictEqual(error.statusCode, 400);

    error = await saveCase('save-malformed', malformed);
    assert(error);
    assert.match(error.message, /malformed/, 'a native SQLite failure in a save is not rewritten');

    console.log('Database integrity check pins passed');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => fs.rmSync(temp, { recursive: true, force: true }));
