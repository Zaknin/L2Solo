'use strict';
// U53: deleting a character from the character hall leaves no child rows.
// Pins, on a fresh database built by the project's own schema code, that the
// connection enforces foreign keys, that items/skills/shortcuts/macros cascade
// from characters, and that CharDelete leaves zero rows for the deleted
// character in every table that references characters, while another
// character keeps its rows.
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('char-delete-cascade');
require('../src/Global');
fixture.assertConfigured(options.default);
process.on('exit', () => fs.rmSync(fixture.directory, { recursive: true, force: true }));
const Database = invoke('Database');
const ServerResponse = invoke('GameServer/Network/Response');
const charDelete = invoke('GameServer/Network/Request/CharDelete');

const ACCOUNT = 'char_delete_cascade';
const CHILD_TABLES = ['items', 'skills', 'shortcuts', 'macros'];
const sql = async (query, params = []) => Database.execute([query, params]);
const settle = () => new Promise(resolve => setTimeout(resolve, 50));

async function character(id, name, account) {
    const created = await Database.createCharacter(account, { name, race: 0, classId: 0,
        maxHp: 100, maxMp: 100, sex: 0, face: 0, hair: 0, hairColor: 0, locX: 83000, locY: 148000, locZ: -3400 });
    await sql('UPDATE characters SET id = ? WHERE id = ?', [id, Number(created.insertId)]);
    await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 1000 });
    await Database.setItem(id, { selfId: 1835, name: 'Soulshot', amount: 50 });
    await Database.setSkill({ selfId: 3, name: 'Power Strike', passive: false, level: 1 }, id);
    await Database.setShortcut(id, { id: 3, kind: 2, slot: 0, unknown: 1 });
    await Database.setMacro(id, { id: 1001, icon: 1, name: 'm', descr: '', acronym: 'M', commands: [] });
}

async function referencing() {
    const tables = (await sql("SELECT name FROM sqlite_master WHERE type = 'table'")).map(row => row.name);
    const links = [];
    for (const table of tables) {
        for (const fk of await sql(`PRAGMA foreign_key_list("${table}")`)) {
            if (fk.table === 'characters') links.push({ table, column: fk.from, onDelete: fk.on_delete });
        }
    }
    return links;
}

async function rowsFor(links, id) {
    const counts = {};
    for (const { table, column } of links) {
        const row = (await sql(`SELECT COUNT(*) AS n FROM "${table}" WHERE "${column}" = ?`, [id]))[0];
        counts[`${table}.${column}`] = Number(row.n);
    }
    return counts;
}

(async () => {
    await Database.init();
    try {
        assert.equal(Number((await sql('PRAGMA foreign_keys'))[0].foreign_keys), 1, 'the game connection enforces foreign keys');
        const links = await referencing();
        for (const table of CHILD_TABLES) {
            const link = links.find(entry => entry.table === table && entry.column === 'characterId');
            assert(link, `${table}.characterId references characters`);
            assert.equal(link.onDelete, 'CASCADE', `${table} rows go with their character`);
        }

        await Database.createAccount(ACCOUNT, 'fixture-password');
        await character(9511, 'CascadeGone', ACCOUNT);
        await character(9512, 'CascadeKept', ACCOUNT);
        for (const table of CHILD_TABLES) {
            assert((await rowsFor(links.filter(l => l.table === table), 9511))[`${table}.characterId`] > 0, `fixture has ${table}`);
        }
        const keptBefore = await rowsFor(links, 9512);

        ServerResponse.charSelectInfo = (characters) => ({ kind: 'charSelectInfo', names: characters.map(c => c.name) });
        const sent = [];
        const session = { accountId: ACCOUNT, actor: null, dataSendToMe: packet => sent.push(packet) };
        const characters = await invoke('GameServer/Network/Shared').fetchCharacters(ACCOUNT);
        const slot = characters.findIndex(c => Number(c.id) === 9511);
        assert(slot >= 0);
        const buffer = Buffer.alloc(5);
        buffer.writeUInt8(0x0c, 0);
        buffer.writeInt32LE(slot, 1);
        await charDelete(session, buffer);
        await settle();

        assert.deepEqual(sent.at(-1), { kind: 'charSelectInfo', names: ['CascadeKept'] }, 'the hall lists the remaining character');
        assert.equal((await sql('SELECT COUNT(*) AS n FROM characters WHERE id = ?', [9511]))[0].n, 0);
        const left = await rowsFor(links, 9511);
        for (const [key, count] of Object.entries(left)) assert.equal(count, 0, `${key} keeps no row of the deleted character`);
        assert.deepEqual(await rowsFor(links, 9512), keptBefore, 'the other character keeps all its rows');
        console.log('CharDelete cascade checks passed');
    } finally {
        await Database.close?.();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
