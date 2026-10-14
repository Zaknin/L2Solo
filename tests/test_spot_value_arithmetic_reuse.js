'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const Module = require('node:module');
require('../src/Global');
const Table = invoke('GameServer/Bot/AI/SpotValueTable');
const filename = require.resolve('../src/GameServer/Bot/AI/SpotValueTable');
const source = fs.readFileSync(filename, 'utf8');
// Bypass only local scalar reuse in the native table evaluator.
const scalarPattern = /const expRatio = ratio\('exp'\), busyRatio = ratio\('busy'\);\s*const gapFactor = expGapFactor\(gap\), lootFactor = lootRateFactor\(t.spots\[s\], rates.drop\);/;
assert(scalarPattern.test(source));
let old = source.replace(scalarPattern, '');
old = old.replace(/\bexpRatio\b/g, "ratio('exp')").replace(/\bbusyRatio\b/g, "ratio('busy')")
    .replace(/\badenaRatio\b/g, "ratio('adena')").replace(/\* gapFactor\b/g, '* expGapFactor(gap)')
    .replace(/\blootFactor\b/g, 'lootRateFactor(t.spots[s], rates.drop)');
function compiled(text) {
    const m = new Module(filename, module);
    m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
    m._compile(text, filename); return m.exports;
}
const reference = compiled(old);
const counts = { current: 0, reference: 0 };
function counted(text, key) {
    const instrumented = text.replace('function at(values, gaps, gap) {',
        `function at(values, gaps, gap) { global.__spotCurveCounts.${key}++;`);
    return compiled(instrumented);
}
global.__spotCurveCounts = counts;
const currentCounted = counted(source, 'current'), oldCounted = counted(old, 'reference');
const fixtureFile = path.join(__dirname, 'fixtures/spot_table.json');
let comparisons = 0;
try {
    for (const file of [fixtureFile, Table.DEFAULT_FILE]) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        Table.useFile(file); reference.useFile(file);
        // Full native roles, diverse spots, fractional level interpolation,
        // capped/invalid/deep-blue levels and missing rows; fresh rate each call.
        const spots = [raw.spots[0][0], raw.spots[1][0], ...raw.spots.filter((_, i) => i % 113 === 0).map(s => s[0]), 'missing'];
        for (const rate of ['x1', 'x10', 'x50']) {
            process.env.L2NODE_PROGRESSION_RATE = rate;
            for (const spot of spots) for (const role of [...raw.roles, 'missing'])
                for (const level of [0, 1, 5, 18, 24, 30.5, 39, 52, 65, 78, 100, NaN]) for (const shots of [true, false]) {
                    assert.deepEqual(Table.value(spot, role, level, shots), reference.value(spot, role, level, shots));
                    comparisons++;
                }
        }
    }
    currentCounted.useFile(fixtureFile); oldCounted.useFile(fixtureFile);
    process.env.L2NODE_PROGRESSION_RATE = 'x50';
    assert.deepEqual(currentCounted.value('S', 'dps', 24), oldCounted.value('S', 'dps', 24));
    assert.equal(counts.current, 8, 'three combat ratios plus two death interpolation reads');
    assert.equal(counts.reference, 14, 'six repeated combat ratios plus two death reads');
    const a = Table.value('-15_42', 'dps', 5), b = Table.value('-15_42', 'dps', 5);
    assert.notEqual(a, b, 'each caller still owns a fresh row');
    const expected = structuredClone(b); a.kills = -1;
    assert.deepEqual(Table.value('-15_42', 'dps', 5), expected);
    // One memo row per argument set as its string reads (the old string key):
    // "5" and 5 share a row, "05" has its own, for a known spot (numeric key)
    // and an unknown one (string key) alike.
    const Config = require('../src/GameServer/Bot/Population/PopulationConfig');
    const developer = Config.developerDiagnostics;
    const renamed = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
    renamed.spots[0][0] = '5';
    const renamedFile = path.join(require('node:os').tmpdir(), `spot_table_memo_${process.pid}.json`);
    fs.writeFileSync(renamedFile, JSON.stringify(renamed));
    try {
        Config.developerDiagnostics = true;
        Table.useFile(renamedFile);
        const memo = (...args) => {
            const before = Table.cacheStats(), row = Table.value(...args), after = Table.cacheStats();
            return { row, hits: after.memoHits - before.memoHits, misses: after.memoMisses - before.memoMisses };
        };
        const first = memo('5', 'dps', 24);
        assert(first.row && first.misses === 1 && first.hits === 0);
        assert.deepEqual(memo(5, 'dps', 24), { row: first.row, hits: 1, misses: 0 });
        assert.deepEqual(memo('5', 'dps', '24'), { row: first.row, hits: 1, misses: 0 });
        assert.deepEqual(memo('05', 'dps', 24), { row: null, hits: 0, misses: 1 });
        assert.deepEqual(memo('05', 'dps', 24), { row: null, hits: 1, misses: 0 });
        assert.deepEqual(memo('5', 'dps', '024'), { row: first.row, hits: 0, misses: 1 });
        assert.deepEqual(memo('7', 'dps', 24), { row: null, hits: 0, misses: 1 });
        assert.deepEqual(memo(7, 'dps', 24), { row: null, hits: 1, misses: 0 });
    } finally { Config.developerDiagnostics = developer; fs.rmSync(renamedFile, { force: true }); }
    console.log(`spot arithmetic exact parity PASS: ${comparisons} lookups; interpolation calls ${counts.reference}->${counts.current}`);
} finally {
    delete global.__spotCurveCounts; Table.useFile(); delete process.env.L2NODE_PROGRESSION_RATE;
}
