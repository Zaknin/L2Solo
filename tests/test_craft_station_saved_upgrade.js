'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('craft-station-saved-upgrade');
require('../src/Global');
fixture.assertConfigured(options.default);

const Data = invoke('GameServer/DataCache'); Data.init();
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Seeder = invoke('GameServer/Bot/Population/GeneratedColdSeeder');
const Shops = invoke('GameServer/Bot/Economy/CraftShopService');

async function run() {
    await Database.init(); await Life.init();
    const oldIds = new Map();
    const oldLoc = { locX: 1, locY: 2, locZ: 3 };
    for (let slot = 0; slot < 32; slot++) {
        const accountName = `bot_craft_${String(slot + 1).padStart(2, '0')}`;
        const name = `OldCraft${String(slot + 1).padStart(2, '0')}`;
        await Database.createAccount(accountName, 'fixture');
        const characterId = Number((await Database.createCharacter(accountName, { name, classId: 57,
            race: 4, sex: 0, face: 0, hair: 0, hairColor: 0, maxHp: 1000, maxMp: 1000,
            ...oldLoc })).insertId);
        oldIds.set(accountName, characterId);
        await Life.upsertState({ characterId, accountName, name, level: 70, exp: Data.experience[69],
            phase: 'cold', activity: 'crafting', currentRegion: 'Giran', loc: oldLoc,
            vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 }, inventory: {}, timing: {},
            stats: { classId: 57, generatedCold: true, generatedIndex: 10000 + slot,
                craftStationId: 'd_heavy', craftShop: { stationId: 'd_heavy', title: 'Old station',
                    loc: oldLoc, entries: [{ recipeId: 79, price: 1 }] } } }, 'old_craft_station_fixture');
    }

    assert.equal(Shops.CraftStations.length, 35);
    const seeded = await Seeder.ensureCraftServices();
    assert.deepEqual(seeded, { created: 3, seeded: 3 }, 'only the appended services are new');
    for (let slot = 0; slot < 35; slot++) {
        const accountName = `bot_craft_${String(slot + 1).padStart(2, '0')}`;
        const [character] = await Database.fetchCharacters(accountName);
        assert(character, `service ${slot + 1} exists`);
        if (slot < 32) assert.equal(Number(character.id), oldIds.get(accountName), 'old account keeps its character');
        const state = await Life.findByCharacterId(character.id);
        const station = Shops.CraftStations[slot];
        assert.equal(state.stats.craftStationId, station.id, `service ${slot + 1} keeps its slot identity`);
        assert.equal(state.stats.craftShop.stationId, station.id);
        assert.deepEqual(state.loc, station.loc, `service ${slot + 1} moves to the current Giran stall`);
        assert.deepEqual(state.stats.craftShop.loc, station.loc);
        assert.deepEqual(state.stats.craftShop.entries.map(row => row.recipeId),
            Shops.profileFor(state).entries.map(row => row.recipeId), 'saved service publishes the current recipes');
    }
    console.log('PASS saved craft stations: 32 account identities refreshed, 3 appended services created');
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await Database.close(); fs.rmSync(fixture.directory, { recursive: true, force: true });
});
