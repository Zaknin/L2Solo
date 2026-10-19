'use strict';
// A bot that fights cold before any hot capture saves the seed kit
// (ColdCombatProfile.seedSnapshot); its next profile counts its hennas once.
const assert = require('node:assert/strict');

require('../src/Global');
const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Henna = invoke('GameServer/Henna/HennaRules');

const timestamp = 1_750_000_000_000;
const slots = [133, 37, 124];
const totals = Henna.totals(slots);
assert(Object.values(totals).some((value) => value !== 0), 'the symbols move some base stat');

// No characterId: every profile builds from the state, no kit store.
const bot = { level: 52, stats: { classId: 55, hennas: slots } };
const plain = Profile.profileFor({ ...bot, stats: { ...bot.stats, hennas: [] } }, timestamp).base;
const fresh = Profile.profileFor(bot, timestamp).base;
const seeded = Profile.profileFor({ ...bot, stats: { ...bot.stats, coldCombat: Profile.seedSnapshot(bot, timestamp) } },
    timestamp).base;

for (const stat of Henna.STAT_KEYS) {
    const key = stat.toLowerCase();
    assert.equal(fresh[key], plain[key] + totals[stat], `${stat}: an unseeded bot counts its hennas once`);
    assert.equal(seeded[key], fresh[key], `${stat}: the seeded kit counts the hennas once, not twice`);
}

// A symbol removed after the seed takes off only its own bonus.
const redrawn = Profile.profileFor({ ...bot, stats: { ...bot.stats, hennas: slots.slice(0, 2),
    coldCombat: Profile.seedSnapshot(bot, timestamp) } }, timestamp).base;
const fewer = Profile.profileFor({ ...bot, stats: { ...bot.stats, hennas: slots.slice(0, 2) } }, timestamp).base;
for (const stat of Henna.STAT_KEYS) {
    const key = stat.toLowerCase();
    assert.equal(redrawn[key], fewer[key], `${stat}: a henna change after the seed applies its delta once`);
}
console.log('PASS a seeded cold combat kit counts hennas once, also after a henna change');
