'use strict';
// ARCH-08-b: a spot search reads the game table's spot list for the bot's
// role and level and takes the first spot it may hunt whose level fits; the
// crowd is no input. The real table; a catalogue of its own spots built from
// its authored reward rows (no World in a test); one level 29 mage.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('../src/Global');
const Data = invoke('GameServer/DataCache');
Data.init();
const { SPOT_CELL_SIZE } = invoke('GameServer/World/WorldConstants');
const Routes = invoke('GameServer/Bot/AI/LevelingRoutes');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const Index = invoke('GameServer/Bot/AI/SpotIndex');
const Spots = invoke('GameServer/Bot/Population/SpotProfiles');
const IncomeRoute = invoke('GameServer/Bot/Economy/EquipmentIncomeRoute');

const at = 1800000000000;
const mage = { classId: 12, level: 29, role: 'mage', maxHp: 592, maxMp: 932,
    pDef: 243, pAtk: 96, mAtk: 162, castSpd: 194, atkSpd: 263, weaponMask: 8,
    equipment: { weaponKind: 'Weapon.Blunt' },
    skills: [{ selfId: 1230, level: 1, spell: true, passive: false, power: 51, mp: 35, hitTime: 4000 }] };
const state = { characterId: 990801, level: 29, adena: 0, phase: 'cold', activity: 'hunting',
    spotId: null, loc: {}, inventory: {}, timing: {},
    vitals: { hp: 592, maxHp: 592, mp: 932, maxMp: 932 },
    stats: { classId: 12, role: 'nuker', deaths: 0 } };
const npcLevel = new Map(Data.npcs.map(npc => [Number(npc.selfId), Number(npc.template?.level || 0)]));
const rows = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/Bots/spot-reward-npcs.json'), 'utf8')).rows;
const profiles = rows.map(([id, entries, adenaMin, adenaMax]) => {
    const [gx, gy] = String(id).split('_').map(Number);
    const levelCounts = {};
    for (const [selfId, count] of entries) {
        const lvl = npcLevel.get(Number(selfId)) || 1;
        levelCounts[lvl] = (levelCounts[lvl] || 0) + count;
    }
    const levels = Object.keys(levelCounts).map(Number);
    const density = entries.reduce((sum, [, count]) => sum + count, 0);
    const avgLevel = Math.round(levels.reduce((sum, lvl) => sum + lvl * levelCounts[lvl], 0) / density);
    return { id: String(id), name: String(id), minLevel: Math.min(...levels), maxLevel: Math.max(...levels),
        avgLevel, density, levelCounts, tags: [],
        center: { locX: (gx + 0.5) * SPOT_CELL_SIZE, locY: (gy + 0.5) * SPOT_CELL_SIZE, locZ: 0 },
        npcEntries: entries.map(([selfId, count]) => ({ selfId, count })), rewards: { adenaMin, adenaMax } };
});
const originalCache = Spots.cache;
Spots.cache = profiles;
const options = { matchupProfiles: [mage], timestamp: at, profiles };
const level = Routes.targetLevelForState(state, options);

// The list's order, read by hand: the first spot the bot may hunt there.
const listed = IncomeRoute.spotList(state, { level }).ids(true)
    .map(id => Index.spotById(profiles, id))
    .filter(spot => spot && !spot.raidBoss && Routes.isSpotAllowedForState(spot, state, options));
const first = listed.find(spot => SpotService.isSuitable(spot, level));
assert(first && listed.length > 1, 'fixture: the mage may hunt several listed spots');
const scored = Routes.bestSpot(profiles.filter(spot => !spot.raidBoss
    && spot.minLevel <= level + 4 && spot.maxLevel >= level - 4
    && Routes.isSpotAllowedForState(spot, state, options)), state, options)?.spot;
assert(scored && scored.id !== first.id, 'fixture: the old score would pick another spot');

const chosen = Spots.findForState(state, options);
assert.equal(chosen?.id, first.id, 'the search takes the first allowed, level-fitting spot of the table list');
const route = Routes.routeMatchFor(first, state, options).route;
assert.equal(chosen.route?.id ?? null, route?.id ?? null, 'the chosen spot carries its own guide route');

const next = listed.find(spot => spot.id !== first.id && SpotService.isSuitable(spot, level));
assert.equal(Spots.findForState(state, { ...options, excludedSpotIds: new Set([String(first.id)]) })?.id, next?.id,
    'an avoided spot is skipped: the next one of the list');

Spots.cache = originalCache;
console.log('spot list search tests passed');
