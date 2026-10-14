const assert = require('assert');

require('../src/Global');
options.default.BotPopulation.developerDiagnostics = true;

// E69: a spot gives back only what its spawns respawn; a cold solo bot kills
// at most its share of it, split by the bots hunting the spot.
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const Resolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');

// Mobs per hour one spawn gives back: 3600 / its respawn seconds; a minion comes back with its leader.
const leader = { spawnDefinition: { spawn: { respawn: 60, bias: 30 } } };
assert.strictEqual(SpotService.respawnsPerHour(leader), 60);
assert.strictEqual(SpotService.respawnsPerHour({ spawnDefinition: null, minionLeader: leader }), 60);
assert.strictEqual(SpotService.respawnsPerHour({ spawnDefinition: { spawn: { respawn: 0 } } }), 0);
assert.strictEqual(SpotService.respawnsPerHour({}), 0);

// A spot of 2 mobs respawning in 60 s: 120 mobs per hour. Nine hunters, one-minute rounds:
// each bot's share is 120 / 60 / 9 = 0.22 mobs per round.
const gremlins = (extra = {}) => ({ id: 'share_gremlin', name: 'Gremlin field', avgLevel: 1, density: 2, npcSelfIds: [1],
    npcEntries: [{ selfId: 1, count: 2, production: 120 }],
    rewards: { exp: 10, sp: 2, adenaMin: 7, adenaMax: 10 }, mob: { hp: 8, damage: 1 }, ...extra });
const hunter = (stats = {}) => ({ characterId: 72, name: 'ShareHunter', level: 10, levelBand: '10-12', activity: 'hunting',
    vitals: { hp: 99999, maxHp: 99999, mp: 99999, maxMp: 99999 }, stats, party: { role: 'dps' } });
const share = Resolver.soloShareMobs(gremlins(), 60000, 9);
assert(Math.abs(share - 120 / 60 / 9) < 1e-9);
assert.strictEqual(Resolver.soloShareMobs(gremlins({ npcEntries: [{ selfId: 1, count: 2 }] }), 60000, 9), null,
    'a spot without a production table is not shared');
assert.strictEqual(Resolver.soloShareMobs(gremlins({ raidBoss: true }), 60000, 9), null);
assert.strictEqual(Resolver.soloShareMobs(gremlins({ npcEntries: [{ selfId: 1, count: 2, production: 0 }] }), 60000, 9), 0,
    'mobs that never respawn give no share');

const before = { ...Metrics.counters };
const first = Resolver.resolveSolo({ state: hunter(), spot: gremlins(), spotHunters: 9, elapsedMs: 60000, rng: () => 0 });
assert.strictEqual(first.debug.wins, 0, 'a crowded bot does not kill above its share');
assert.strictEqual(first.debug.shareCut, 1);
Metrics.recordCombat(first.debug);
assert.strictEqual(Metrics.counters.coldShareBoundResolves - (before.coldShareBoundResolves || 0), 1);
assert.strictEqual(Metrics.counters.coldShareCutFights - (before.coldShareCutFights || 0), 1);

// The unused part of the share carries to the next round on the same spot, so the bot is not starved.
let state = hunter();
let kills = 0;
for (let round = 0; round < 17; round++) {
    const result = Resolver.resolveSolo({ state, spot: gremlins(), spotHunters: 9, elapsedMs: 60000, rng: () => 0 });
    kills += Number(result.debug.pullMobs || 0);
    state = { ...state, stats: result.patch.stats };
}
assert(kills >= 1, 'the share accumulates to a kill');
assert(kills <= Math.floor(17 * share), `kills ${kills} stay within 17 rounds of share`);

// A lone bot on the same spot has the whole spot's production.
const alone = Resolver.resolveSolo({ state: hunter(), spot: gremlins(), spotHunters: 1, elapsedMs: 60000, rng: () => 0 });
assert.strictEqual(alone.debug.wins, 1);
assert.strictEqual(alone.debug.shareCut, 0);

console.log('Bot spot share checks passed');
