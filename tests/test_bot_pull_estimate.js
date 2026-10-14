const assert = require('assert');

require('../src/Global');

// E72/F20: how many mobs one pull brings, for hot target choice and cold fights.
const Pull = invoke('GameServer/Bot/AI/BotPullEstimate');
const rules = { assistZ: 600, aggroRadius: 500, aggroZ: 400 };
const mob = (x, extra = {}) => ({ x, y: 0, z: 0, clan: '', helpRadius: 0, hostile: false, ...extra });

// A lone mob comes alone; passive strangers nearby stay out.
assert.strictEqual(Pull.pullSize(mob(0), [mob(100), mob(200)], rules), 1);

// Same-clan helpers inside the target's help radius join; outside it, or of another clan, they do not.
const ant = mob(0, { clan: 'ant', helpRadius: 300 });
assert.strictEqual(Pull.pullSize(ant, [ant, mob(100, { clan: 'ant' }), mob(200, { clan: 'ant' }),
    mob(290, { clan: 'ant' }), mob(400, { clan: 'ant' }), mob(150, { clan: 'wolf' })], rules), 4);
assert.strictEqual(Pull.pullSize(ant, [mob(100, { clan: 'ant', z: 700 })], rules), 1, 'help stops at the assist height');

// Aggressive mobs within the aggro radius join; a clan helper that is also aggressive counts once.
assert.strictEqual(Pull.pullSize(mob(0), [mob(450, { hostile: true }), mob(600, { hostile: true })], rules), 2);
assert.strictEqual(Pull.pullSize(ant, [mob(100, { clan: 'ant', hostile: true })], rules), 2);
assert.strictEqual(Pull.pullSize(mob(0), [mob(100, { hostile: true, z: 450 })], rules), 1, 'aggro stops at its height');

// A leader brings its minions; minion actors are counted through their group, not again as neighbours.
assert.strictEqual(Pull.pullSize(mob(0), [mob(100, { hostile: true, minion: true })], rules, 3), 4);

// Minion groups from the Lisvus rows: a leader brings the mean of each group, a minion its leader and siblings.
const groups = new Map([[520, [{ minionId: 445, min: 3, max: 5 }, { minionId: 446, min: 1, max: 1 }]]]);
const joiners = Pull.minionJoiners(groups);
assert.strictEqual(joiners.get(520), 5);
assert.strictEqual(joiners.get(445), 5, 'a hit minion alerts the leader and the rest of the group');
assert.strictEqual(joiners.get(1), undefined);

// The start-time table: one mean pull per spawn group (spot entry), set only where it is above one.
const spot = {
    npcEntries: [{ selfId: 10, count: 2 }, { selfId: 20, count: 1 }, { selfId: 30, count: 1 }],
    records: [
        mob(0, { selfId: 10, clan: 'ant', helpRadius: 300 }),
        mob(5000, { selfId: 10, clan: 'ant', helpRadius: 300 }),
        mob(100, { selfId: 20, clan: 'ant' }),
        mob(3000, { selfId: 30 })
    ]
};
const size = Pull.annotate([spot], rules, new Map([[30, 2]]));
assert.strictEqual(spot.npcEntries[0].pull, 1.5, 'one of two ants has a clanmate in its help radius');
assert.strictEqual(spot.npcEntries[1].pull, undefined, 'a mob without help radius pulls alone');
assert.strictEqual(spot.npcEntries[2].pull, 3, 'a leader brings its minions');
assert.strictEqual(spot.records, undefined, 'the spawn records are dropped once the table is built');
assert.deepStrictEqual(size, { entries: 3, pulls: 2 });
assert.strictEqual(Pull.entryPull(spot, 30), 3);
assert.strictEqual(Pull.entryPull(spot, 20), 1);
assert.strictEqual(Pull.entryPull(null, 30), 1);

// A pull of k is one mob with k times the HP and the mean attack of the mobs still standing.
assert.deepStrictEqual(Pull.pullView({ maxHp: 100, pAtk: 10, pDef: 5 }, 3), { maxHp: 300, pAtk: 20, pDef: 5 });
const single = { maxHp: 100, pAtk: 10 };
assert.strictEqual(Pull.pullView(single, 1), single);

// The cold fight rolls a whole number of mobs from the mean once per new fight.
assert.strictEqual(Pull.rollPull(1, () => assert.fail('a pull of one draws nothing')), 1);
assert.strictEqual(Pull.rollPull(3, () => assert.fail('a whole pull draws nothing')), 3);
assert.strictEqual(Pull.rollPull(2.4, () => 0.39), 3);
assert.strictEqual(Pull.rollPull(2.4, () => 0.4), 2);

// Cold: the solo fight rolls its pull; the mob stays one mob for the readiness margin.
const Data = invoke('GameServer/DataCache');
Data.init();
const Cold = invoke('GameServer/Bot/Population/ColdCombatProfile');
const template = Data.npcs.find(n => n.template?.kind === 'Monster' && Number(n.template.level) === 20 && !n.template.hostile);
assert(template, 'datapack has a passive level-20 monster');
const base = Cold.npcCombatStats(template);
const coldSpot = { npcEntries: [{ selfId: template.selfId, count: 3, pull: 3 }] };
const pulled = Cold.npcForSpot(coldSpot, () => 0.5, { pull: true });
assert.strictEqual(pulled.pull, 3);
assert.strictEqual(pulled.maxHp, base.maxHp);
const alone = Cold.npcForSpot(coldSpot, () => 0.5);
assert.strictEqual(alone.pull, undefined, 'party and other callers keep one mob');
assert.strictEqual(alone.maxHp, base.maxHp);

// A won pull gives every mob's kill; the cycle reports the pull for the mobs-per-pull counter.
const Resolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const gremlins = pull => ({ id: 'starter_gremlin', name: 'Gremlin field', avgLevel: 1, density: 1, npcSelfIds: [1],
    npcEntries: [{ selfId: 1, count: 3, ...(pull ? { pull } : {}) }],
    rewards: { exp: 10, sp: 2, adenaMin: 7, adenaMax: 10 }, mob: { hp: 8, damage: 1 } });
const hunter = () => ({ characterId: 71, name: 'ColdHunter', level: 10, levelBand: '10-12', activity: 'hunting',
    vitals: { hp: 99999, maxHp: 99999, mp: 99999, maxMp: 99999 }, stats: {}, party: { role: 'dps' } });
const hunt = pull => Resolver.resolveSolo({ state: hunter(), spot: gremlins(pull), elapsedMs: 60000, rng: () => 0 });
const one = hunt(0), two = hunt(2), three = hunt(3);
assert.strictEqual(one.debug.wins, 1);
assert.strictEqual(two.debug.wins, 1);
assert.deepStrictEqual([one.debug.pulls, one.debug.pullMobs], [1, 1]);
assert.deepStrictEqual([two.debug.pulls, two.debug.pullMobs], [1, 2]);
assert.strictEqual(two.materialize.exp, one.materialize.exp * 2, 'each mob of the pull gives its exp');
assert.strictEqual(two.materialize.items.length, one.materialize.items.length * 2, 'each mob rolls its drops');
assert(two.debug.combatMs > one.debug.combatMs, 'two mobs take longer to kill');
// Helpers come regardless (design 13.5): a pull above the hunter's margin still starts, it is not rested for.
assert.deepStrictEqual([three.debug.pulls, three.debug.pullMobs], [1, 3]);
assert.notStrictEqual(three.patch.stats.lastReason, 'solo_recovery_needed');

console.log('Bot pull estimate checks passed');
