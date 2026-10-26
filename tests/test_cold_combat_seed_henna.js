'use strict';
// A bot that fights cold before any hot capture saves the seed kit
// (ColdCombatProfile.seedSnapshot); its next profile counts its hennas once.
// A seed saved before the henna totals were written is repaired at world load.
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('cold-seed-henna');
require('../src/Global');
const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const DB = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
const Native = require('./helpers/nativeMarketFixture');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Henna = invoke('GameServer/Henna/HennaRules');

const timestamp = 1_750_000_000_000;
const slots = [133, 37, 124];
const totals = Henna.totals(slots);
assert(Object.values(totals).some((value) => value !== 0), 'the symbols move some base stat');

// No characterId: every profile builds from the state, no kit store.
const bot = { level: 52, stats: { classId: 55, hennas: slots } };
const withHennas = (hennas, coldCombat) => ({ ...bot, stats: { ...bot.stats, hennas, ...(coldCombat ? { coldCombat } : {}) } });
const plain = Profile.profileFor(withHennas([]), timestamp).base;
const fresh = Profile.profileFor(bot, timestamp).base;
const seeded = Profile.profileFor(withHennas(slots, Profile.seedSnapshot(bot, timestamp)), timestamp).base;
for (const stat of Henna.STAT_KEYS) {
    const key = stat.toLowerCase();
    assert.equal(fresh[key], plain[key] + totals[stat], `${stat}: an unseeded bot counts its hennas once`);
    assert.equal(seeded[key], fresh[key], `${stat}: the seeded kit counts the hennas once, not twice`);
}

// A symbol removed after the seed takes off only its own bonus.
const removed = Profile.profileFor(withHennas(slots.slice(0, 2), Profile.seedSnapshot(bot, timestamp)), timestamp).base;
const fewer = Profile.profileFor(withHennas(slots.slice(0, 2)), timestamp).base;
for (const stat of Henna.STAT_KEYS) {
    const key = stat.toLowerCase();
    assert.equal(removed[key], fewer[key], `${stat}: a henna change after the seed applies its delta once`);
}

// A seed saved before the fix (base with the hennas of that moment, no henna
// totals), then a cold draw of a second symbol: after the world load the bot
// counts both symbols once.
const id = 9762, loc = { locX: 83396, locY: 147904, locZ: -3400 };
const before = [133, null, null], after = [133, 37, null];
assert.notDeepEqual(Henna.totals(before), Henna.totals(after), 'the drawn symbol moves some base stat');
async function run() {
    try {
        await DB.init();
        await Native.character(DB, id, 'SeedHenna', 'bot_seed_henna', loc);
        await DB.execute(['UPDATE characters SET level=52,classId=55,race=4 WHERE id=?', [id]]);
        for (let i = 0; i < after.length; i++) if (after[i]) await DB.setCharacterHenna(id, i + 1, after[i]);
        const oldSeed = Profile.seedSnapshot(withHennas(before), timestamp);
        delete oldSeed.henna;
        const stats = { classId: 55, hennas: after, coldCombat: oldSeed };
        await DB.execute([`INSERT INTO bot_life_state(characterId,accountName,characterName,level,phase,activity,
            currentRegion,locX,locY,locZ,statsJson,inventorySummary) VALUES(?, 'bot_seed_henna','SeedHenna',52,'cold','hunting','Giran',?,?,?,?,'{}')`,
            [id, loc.locX, loc.locY, loc.locZ, JSON.stringify(stats)]]);
        await Life.init();
        const expected = Profile.profileFor(withHennas(after), timestamp).base;
        const loaded = Profile.profileFor(Life.cachedState(id), timestamp).base;
        const row = (await DB.execute(['SELECT statsJson FROM bot_life_state WHERE characterId=?', [id]]))[0];
        const persisted = Profile.profileFor({ level: 52, stats: JSON.parse(row.statsJson) }, timestamp).base;
        for (const stat of Henna.STAT_KEYS) {
            const key = stat.toLowerCase();
            assert.equal(loaded[key], expected[key], `${stat}: an old seed counts a later cold draw once after the load`);
            assert.equal(persisted[key], expected[key], `${stat}: the repaired kit is saved`);
        }
        console.log('PASS a seeded cold combat kit counts hennas once, after a henna change and from an old seed after the load');
    } finally { await DB.close(); fs.rmSync(fixture.directory, { recursive: true, force: true }); }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
