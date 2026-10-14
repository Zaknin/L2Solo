const assert = require('assert');
require('../src/Global');
const Data = invoke('GameServer/DataCache');
const Matchup = invoke('GameServer/Bot/AI/BotTargetMatchup');
const Hunting = invoke('GameServer/Bot/AI/BotHuntingTargetPolicy');
const DiagnosticConfig = invoke('GameServer/Bot/Population/PopulationConfig');
Data.init();

// L104: the shared verdict cache is bounded by the entries it holds (verdicts
// and spot results of all fingerprints), not only by the fingerprint count.
// The counts must hold without developer diagnostics: the budget reads them.
DiagnosticConfig.developerDiagnostics = false;
const BUDGET = Matchup.VERDICT_ENTRY_BUDGET;
assert(BUDGET > 0 && BUDGET < Matchup.VERDICT_PROFILE_LIMIT * 1000, 'the entry budget is a finite number of entries');

const monsters = Data.npcs.filter((npc) => npc.template?.kind === 'Monster' && Hunting.canHunt(npc));
const species = monsters.filter((npc) => Number(npc.template.level) === 20).slice(0, 6);
assert(species.length === 6, 'the datapack must contain level 20 monsters');
const huntSpot = { id: 'budget_hunt', npcEntries: species.map((npc, i) => ({ selfId: npc.selfId, count: 1 + i % 3 })) };
const strike = { selfId: 3, level: 5, passive: false, spell: false, power: 150, mp: 20, hitTime: 1080, reuse: 13000,
    distance: 40, semantic: { skillType: 'damage', target: 'enemy', trait: 'physical' } };
const fighter = (pAtk) => [{ classId: 0, role: 'dps', level: 20, pAtk, mAtk: 10, maxMp: 100, atkSpd: 300, castSpd: 333,
    weaponMask: 4, maxHp: 900, pDef: 150, equipment: { weaponKind: 'Weapon.Sword' }, skills: [{ ...strike }] }];
const options = { soloSafety: true };
const held = () => { const s = Matchup.cacheStats(); return s.verdictEntries + s.spotStores; };

// Spot results are entries too: a spot with no mobs adds one result and no
// verdicts, so three fingerprints over these spots pass the budget.
const filler = Array.from({ length: Math.ceil(BUDGET * 0.45) }, (_, i) => ({ id: `budget_${i}`, npcEntries: [] }));
const fill = (pAtk) => {
    const profiles = fighter(pAtk);
    const result = Matchup.spotMatchup(huntSpot, profiles, options);
    for (const spot of filler) Matchup.spotMatchup(spot, profiles, options);
    return result;
};
const start = Matchup.cacheStats();
const first = fill(111);
const second = fill(222);
assert.strictEqual(held() - (start.verdictEntries + start.spotStores), 2 * (filler.length + 1 + species.length),
    'verdicts and spot results are counted without diagnostics');
assert.strictEqual(Matchup.cacheStats().budgetEvictions, start.budgetEvictions, 'under the budget nothing is dropped');

// The first fingerprint is used again (a new profile array of the same
// fields), so the second is now the least recently used.
let before = held();
assert.deepStrictEqual(Matchup.spotMatchup(huntSpot, fighter(111), options), first);
assert.strictEqual(held(), before, 'a used fingerprint answers from its stored result');

fill(333);
const after = Matchup.cacheStats();
assert(after.budgetEvictions > start.budgetEvictions, 'the budget dropped a fingerprint');
assert(held() <= BUDGET, `the entries stay within the budget (${held()} > ${BUDGET})`);
assert(after.fingerprints <= Matchup.VERDICT_PROFILE_LIMIT);
assert.strictEqual(after.evictions - start.evictions, after.budgetEvictions - start.budgetEvictions,
    'no fingerprint was idle or over the count limit, so every drop is the budget');

// The recently used fingerprint survived; the dropped one is recomputed to the same result.
before = held();
assert.deepStrictEqual(Matchup.spotMatchup(huntSpot, fighter(111), options), first);
assert.strictEqual(held(), before, 'the most recently used fingerprint is kept');
assert.deepStrictEqual(Matchup.spotMatchup(huntSpot, fighter(222), options), second, 'a dropped fingerprint is recomputed');
assert.strictEqual(held(), before + 1 + species.length, 'the recomputed fingerprint counts again');

console.log('matchup entry budget tests passed');
