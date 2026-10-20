'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('generated-cold-seed-shots');
require('../src/Global');
fixture.assertConfigured(options.default);
process.on('exit', () => fs.rmSync(fixture.directory, { recursive: true, force: true }));
const Database = invoke('Database');
const Data = invoke('GameServer/DataCache');
const Seeder = invoke('GameServer/Bot/Population/GeneratedColdSeeder');
const Planner = invoke('GameServer/Bot/Population/PopulationSeedPlanner');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Native = require('./helpers/nativeMarketFixture');
Data.init();

const NO_GRADE_SOULSHOT = 1835;
const BEGINNER_SOULSHOT = 5789;

async function run() {
    await Database.init();
    // One new bot per racial spawn; the dwarf slot is always a fighter class.
    // Craft services are a separate seed pass: switched off through the config.
    Config.maxPlayingPopulation = 1700;
    Config.starterBotsPerRace = 1;
    Config.staticBuyersDisabled = true;
    SpotProfiles.ensure = () => Planner.STARTER_REGIONS.map((region) => ({
        id: `starter_${region.id}`, minLevel: 1, avgLevel: 1, center: { ...region.center }
    }));

    const result = await Seeder.seedPopulation();
    assert.equal(result.error, undefined);
    assert.ok(result.seeded > 0, 'the wave must seed new bots');

    const rows = await Database.execute(['SELECT characterId, inventorySummary FROM bot_life_state WHERE accountName LIKE ?', ['bot_pop_%']]);
    assert.equal(rows.length, result.seeded, 'every seeded bot must be persisted');
    let fighters = 0;
    for (const row of rows) {
        const summary = JSON.parse(row.inventorySummary);
        assert.equal(summary[NO_GRADE_SOULSHOT], undefined,
            `bot ${row.characterId}: the persisted bag must not name Soulshot No Grade the bot does not hold`);
        const held = Native.amount(await Database.fetchItems(row.characterId), BEGINNER_SOULSHOT);
        if (!held) continue;
        fighters += 1;
        assert.equal(Number(summary[BEGINNER_SOULSHOT]?.amount), held,
            `bot ${row.characterId}: the persisted beginner soulshots must equal the items table`);
    }
    assert.ok(fighters > 0, 'a wave with a dwarf slot must seed at least one soulshot class');
    console.log('Generated cold seed shots: persisted bag matches the items table');
}
run().then(() => Database.close()).catch(async error => {
    console.error(error); process.exitCode = 1; await Database.close();
});
