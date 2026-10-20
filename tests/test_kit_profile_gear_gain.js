'use strict';
// A gear gain is computed from the bot's kit profile: a better weapon gives a
// positive gain, and valuing it leaves the bot's own profile as it was.
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Providers = invoke('GameServer/Bot/Economy/WishProviders');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Index = require('../src/GameServer/Item/ItemTemplateIndex');
const timestamp = 1791335800000;
const template = id => Index.find(Data.items, id);
const worn = id => ({ selfId: id, amount: 1, slot: Number(template(id).etc.slot), equipped: true, equippedCount: 1,
    equippedSlots: [Number(template(id).etc.slot)], enchant: 0 });
const state = { characterId: 951001, level: 69, stats: { classId: 57 }, inventory: { 159: worn(159) } };
state.stats.coldCombat = Profile.legacySnapshot(state, Profile.skillRecordsFromTree(57, 69), timestamp);

const own = structuredClone(Profile.profileFor(state, timestamp));
const better = template(2503);
const gain = Providers.gearGain(state, better, timestamp, 1);
assert(gain.attack > 0, 'a better weapon gives a positive attack gain');
const { before, after } = Profile.candidateProfiles(state, timestamp);
const slot = Number(better.etc.slot);
assert(after({ free: wornSlot => wornSlot === slot, wear: { selfId: better.selfId, slot } }).pAtk > before.pAtk,
    'the candidate numbers carry the better weapon');
assert.deepEqual(Profile.profileFor(state, timestamp), own, 'valuing a candidate leaves the bot profile unchanged');
Profile.forgetBuild(state.characterId);
console.log('PASS gear gain from the kit profile');
