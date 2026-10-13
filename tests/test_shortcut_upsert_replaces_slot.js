'use strict';
// AddShortcut used to DELETE the slot before the setShortcut UPSERT. The UPSERT replaces the same row
// (PRIMARY KEY and ON CONFLICT target are both (characterId, slot)), so DELETE + UPSERT and UPSERT alone
// must leave the same table for every kind, slot (page is part of the slot) and starting state.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
require('../src/Global');

const Database = invoke('Database');
const root = path.join(__dirname, '..');
const schema = /CREATE TABLE IF NOT EXISTS shortcuts \([\s\S]*?\n\);/.exec(fs.readFileSync(path.join(root, 'database/sql/sqlite.sql'), 'utf8'))[0];
const upsert = /`(INSERT INTO shortcuts[\s\S]*?)`/.exec(Database.setShortcut.toString())[1];
assert(/PRIMARY KEY\(characterId, slot\)/.test(schema) && /ON CONFLICT\(characterId, slot\)/.test(upsert), 'key and conflict target must match');

function open() {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE characters (id INTEGER PRIMARY KEY);');
    db.exec(schema.replace('IF NOT EXISTS ', ''));
    db.exec('INSERT INTO characters (id) VALUES (1), (2);');
    return db;
}
const dump = (db) => JSON.stringify(db.prepare('SELECT characterId, slot, kind, id, unknown FROM shortcuts ORDER BY characterId, slot').all());
const rows = [];
for (const characterId of [1, 2]) for (const slot of [0, 5, 11, 12, 23, 24, 35, 47, 59, 71, 143]) rows.push([characterId, slot]);
let seed = 7;
const rand = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
for (let round = 0; round < 40; round++) {
    const oldWay = open();
    const newWay = open();
    const initial = [];
    for (const [characterId, slot] of rows) if (rand(3) !== 0) initial.push([rand(5000), 1 + rand(5), slot, rand(3), characterId]);
    for (const db of [oldWay, newWay]) for (const params of initial) db.prepare(upsert).run(...params);
    assert.strictEqual(dump(oldWay), dump(newWay));
    for (let step = 0; step < 30; step++) {
        const [characterId, slot] = rows[rand(rows.length)];
        const params = [rand(5000), 1 + rand(5), slot, rand(3), characterId];
        oldWay.prepare('DELETE FROM shortcuts WHERE slot = ? AND characterId = ?').run(slot, characterId);
        oldWay.prepare(upsert).run(...params);
        newWay.prepare(upsert).run(...params);
        assert.strictEqual(dump(oldWay), dump(newWay), `round ${round} step ${step}`);
        assert.strictEqual(newWay.prepare('SELECT COUNT(*) AS n FROM shortcuts WHERE characterId = ? AND slot = ?').get(characterId, slot).n, 1);
    }
}
console.log('test_shortcut_upsert_replaces_slot: ok');
