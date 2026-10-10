'use strict';
// perf C2: a worker keeps one economy plan per actor and serves it to a new
// state object only on equal inputs. The spot crowd the build read, a key
// input and the per-state gear plan memo decide whether it still serves.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Module = require('node:module');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'economy-kept-plan-'));
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.env.L2NODE_CONFIG_FILE = path.join(directory, 'config.ini');
fs.writeFileSync(process.env.L2NODE_CONFIG_FILE, `[Database]\npath=${directory}/world.sqlite\nhistoryPath=${directory}/history.sqlite\n`);
require('../src/Global');
invoke('GameServer/DataCache').init();
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
// The native module with its worker branch, as the cold worker loads it.
const filename = require.resolve('../src/GameServer/Bot/Economy/EconomyContext');
const loaded = new Module(filename, module); loaded.filename = filename;
loaded.paths = Module._nodeModulePaths(path.dirname(filename));
const nativeRequire = loaded.require.bind(loaded);
loaded.require = name => name === 'node:worker_threads' ? { isMainThread: false } : nativeRequire(name);
loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
const Economy = loaded.exports;

const spotId = invoke('GameServer/Bot/AI/SpotValueTable').best('dps', 20, true, 'income').spotId;
// The build values one spot through its own spot reader, as the wish
// providers do for a farm source.
Economy.registerProvider('kept-plan-probe', (state, context) => { context.spotValue({ id: spotId, density: 1 }); return []; });
const state = { characterId: 901, updatedAt: 10, level: 20, phase: 'cold', activity: 'hunting', adena: 1000,
    stats: { classId: 1, decisionSeq: 2, activityLeaf: 0 }, inventory: { 1: { selfId: 1, amount: 1, equipped: true, slot: 7 } },
    currentRegion: 'Giran', timing: {}, simulation: { revision: 3 },
    loc: { locX: 80000, locY: 148000, locZ: -3500 }, vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 } };
const crowd = count => ({ [spotId]: { count, reservedCount: count, capacity: 9, retained: new Set(), reservedKeys: new Set(),
    reservationKeys: new Set(), retainedReservationKeys: new Set() } });
const board = new BoardIndex(), deps = extra => ({ board, timestamp: 1e12, ...extra });
const next = (base, change = {}) => { const copy = structuredClone(base); copy.updatedAt++; Object.assign(copy.stats, change); return copy; };

const first = Economy.forState(state, deps({ occupancy: crowd(2) }));
let current = next(state);
assert.strictEqual(Economy.forState(current, deps({ occupancy: crowd(2) })).plan, first.plan, 'the same crowd serves the kept plan');
assert.strictEqual(Economy.forState(next(current), deps()).plan, first.plan, 'a caller without the crowd is served the kept plan');
current = next(current);
const crowded = Economy.forState(current, deps({ occupancy: crowd(6) }));
assert.notStrictEqual(crowded.plan, first.plan, 'another crowd on a spot the build read rebuilds the plan');
assert.strictEqual(Economy.forState(next(current), deps({ occupancy: { ...crowd(6), other: { count: 9 } } })).plan, crowded.plan,
    'a spot the build never read is not an input');

current = next(current);
const moved = Economy.forState(next(current, { routeMode: 'party' }), deps({ occupancy: crowd(6) }));
assert.notStrictEqual(moved.plan, crowded.plan, 'a build input that was outside the key (route mode) now rebuilds');

const memo = { plan: 'craft' };
current = next(current, { routeMode: 'party' });
const held = Economy.forState(current, deps({ occupancy: crowd(6) }));
assert.strictEqual(held.plan, moved.plan);
held.gearPlanMemo = memo;
assert.strictEqual(Economy.forState(current, deps({ occupancy: crowd(6) })).gearPlanMemo, memo, 'the gear plan memo lives with its state object');
const later = Economy.forState(next(current), deps({ occupancy: crowd(6) }));
assert.strictEqual(later.plan, moved.plan);
assert.equal(later.gearPlanMemo, undefined, 'a new state object chooses its gear plan again (time gates outside the key)');
console.log('test_economy_context_kept_plan: ok');
