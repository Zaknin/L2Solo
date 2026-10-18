'use strict';
// Pins the observer pages' HTML escaping and compact-number output (app.js, knowledge-base.js, market.js).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const publicDir = path.join(__dirname, '..', 'src', 'WorldObserver', 'public');
const sharedPath = path.join(publicDir, 'format.js');

function load(file, names) {
    const source = fs.readFileSync(path.join(publicDir, file), 'utf8');
    const context = vm.createContext({});
    if (fs.existsSync(sharedPath)) context.WorldObserverFormat = require(sharedPath);
    for (const name of names) {
        const declaration = new RegExp(`^function ${name}\\(`, 'm').exec(source);
        assert(declaration, `${file}: function ${name} must exist`);
        const start = declaration.index;
        const next = /^function /m.exec(source.slice(start + declaration[0].length));
        const end = next ? start + declaration[0].length + next.index : source.length;
        vm.runInContext(source.slice(start, end), context);
    }
    return context;
}

const app = load('app.js', ['escapeHtml', 'compactNumber']);
const kb = load('knowledge-base.js', ['escapeHtml', 'compactNumber', 'number']);
const market = load('market.js', ['escapeMarketHtml', 'compactMarketNumber']);

const escapes = [
    ['plain', 'plain'], [`a&b<c>d"e'f`, 'a&amp;b&lt;c&gt;d&quot;e&#039;f'], ['&amp;', '&amp;amp;'],
    [null, ''], [undefined, ''], [0, '0'], [false, 'false'], ['', ''], [12.5, '12.5'], [{ toString: () => '<x>' }, '&lt;x&gt;']
];
for (const [input, expected] of escapes) {
    assert.strictEqual(app.escapeHtml(input), expected, `app.js escapeHtml(${String(input)})`);
    assert.strictEqual(kb.escapeHtml(input), expected, `knowledge-base.js escapeHtml(${String(input)})`);
    assert.strictEqual(market.escapeMarketHtml(input), expected, `market.js escapeMarketHtml(${String(input)})`);
}

// app.js and market.js: negatives clamp to 0, one fraction digit below 10000, none above.
const compact = [
    [0, '0'], [null, '0'], [undefined, '0'], ['', '0'], [-5, '0'], [999, '999'], [1000, '1K'], [1500, '1.5K'], [9999, '10K'],
    [10000, '10K'], [12345, '12K'], [999999, '1M'], [1234567, '1M'], [1500000, '2M'], [2500000000, '3B'], ['abc', 'NaN']
];
for (const [input, expected] of compact) {
    assert.strictEqual(app.compactNumber(input), expected, `app.js compactNumber(${String(input)})`);
    assert.strictEqual(market.compactMarketNumber(input), expected, `market.js compactMarketNumber(${String(input)})`);
}

// knowledge-base.js differs (kept as is): no clamp, always one fraction digit.
const kbCompact = [[0, '0'], [null, '0'], [-5, '-5'], [999, '999'], [1500, '1.5K'], [12345, '12.3K'], [1234567, '1.2M'], [2500000000, '2.5B']];
for (const [input, expected] of kbCompact) assert.strictEqual(kb.compactNumber(input), expected, `knowledge-base.js compactNumber(${String(input)})`);

console.log('test_world_observer_format: ok');
