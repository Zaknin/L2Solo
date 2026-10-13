'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const Progression = require('../src/GameServer/ClassProgression');
const Filters = require('../src/WorldObserver/public/actorFilters');

const stringRow = { classId: '0', template: { class: 'String first', race: 1 } };
const numericRow = { classId: 0, template: { class: 'Numeric second', race: 2 } };
const duplicate = { classId: 0, template: { class: 'Duplicate third' } };
const classes = [stringRow, numericRow, duplicate];
assert.equal(Progression.firstClassRow(classes, 0), stringRow);
assert.equal(Progression.firstClassRow(classes, 0, 'strict'), numericRow);
assert.equal(Progression.firstClassRow(classes, '0', 'strict'), stringRow);
assert.equal(Progression.firstClassRow(classes, NaN, 'strict'), undefined);
assert.equal(Progression.firstClassRow([{ classId: 'bad' }, numericRow], 0, 'finite').classId, 'bad');
assert.equal(Progression.firstClassRow(classes, NaN), undefined);
assert.throws(() => Progression.firstClassRow(undefined, 0, 'strict'), TypeError);
assert.equal(Progression.firstClassRow([numericRow, null], 0), numericRow, 'find stops before a malformed later row');
assert.equal(Progression.firstClassRow([numericRow, { classId: Symbol() }], 0), numericRow);
assert.throws(() => Progression.firstClassRow([null, numericRow], 0), TypeError);
assert.throws(() => Progression.firstClassRow(new Array(1), 0), TypeError);
classes.reverse();
assert.equal(Progression.firstClassRow(classes, 0), duplicate, 'mutable same-length reorders are current');
duplicate.classId = 3;
assert.equal(Progression.firstClassRow(classes, 0), numericRow, 'mutable ID edits are current');
const loaded = [{ classId: 1 }, { classId: 2 }];
for (const source of [undefined, null, false, 0, 'invalid', {}, () => {}]) {
    assert.doesNotThrow(() => Progression.registerLoadedSource(source), 'registration must not reject a loader warning result');
}
Progression.registerLoadedSource(loaded);
assert.equal(Progression.firstClassRow(loaded, 1), loaded[0]);
loaded[0].classId = 9;
Progression.invalidateSource(loaded);
assert.equal(Progression.firstClassRow(loaded, 1), undefined);
loaded.push({ classId: 1 });
assert.equal(Progression.firstClassRow(loaded, 1), loaded[2], 'length change rebuilds loaded sources');

// Exercise the real loader through registration, stopping at the next module
// boundary. validateModel warns and retains invalid sources for their readers.
const cachePath = path.resolve(__dirname, '../src/GameServer/DataCache.js');
const cacheRequire = createRequire(cachePath);
const afterRegistration = new Error('loader advanced beyond source registration');
const loaderWarnings = [];
const loaderModule = { exports: {} };
vm.runInNewContext(fs.readFileSync(cachePath, 'utf8'), {
    module: loaderModule,
    require: name => name === 'jsonschema' ? { validate: model => ({
        valid: model !== null && model !== undefined && model !== false,
        errors: [{ stack: 'malformed fixture source' }]
    }) } : cacheRequire(name),
    invoke: name => {
        if (name === 'GameServer/ClassProgression') return Progression;
        if (name === 'GameServer/RaidBoss/RaidBossBalance') return {};
        if (name === 'GameServer/World/C4LateTownGatekeepers') throw afterRegistration;
        if (name.endsWith('/.schema')) return {};
        if (name === '../data/Templates/templates') return structuredClone(require('../data/Templates/templates.json'));
        if (name === '../data/Templates/Shortcuts/shortcuts') return null;
        if (name === '../data/Templates/Spawns/spawns') return undefined;
        if (name === '../data/Skills/Tree/tree') return false;
        return name.endsWith('/ai') || name.endsWith('/revitalize') ? {} : [];
    },
    utils: { infoWarn: (...args) => loaderWarnings.push(args) }, structuredClone
}, { filename: cachePath });
assert.throws(() => loaderModule.exports.init(), error => error === afterRegistration,
    'invalid loader sources must reach the existing next stage');
assert.equal(loaderWarnings.length, 3);
assert.equal(loaderModule.exports.newbieShortcuts, null);
assert.equal(loaderModule.exports.newbieSpawns, undefined);
assert.equal(loaderModule.exports.skillTree, false);
assert.throws(() => loaderModule.exports.fetchSkillTreeFromClassId(0, () => {}), TypeError,
    'registration does not turn an invalid required source into an empty array');

const firstRanks = [{ level: 3, pLevel: 8 }, { level: 1, pLevel: 1 }, { level: 1, pLevel: 4 }];
const childRanks = [{ level: 2, pLevel: 5 }, { level: 1, pLevel: 2 }];
const base = { selfId: 7, marker: 'base', baseOnly: true, levels: firstRanks };
const child = { selfId: '7', marker: 'child', levels: childRanks };
const independent = { selfId: 8, levels: [{ level: 1, pLevel: 20 }] };
const trees = [{ classId: 0, skills: [base] }, { classId: 1, skills: [child, independent] },
    { classId: 1, skills: [{ selfId: 99, levels: [{ level: 1, pLevel: 40 }] }] }];
assert.deepEqual(Progression.lineage(999), []);
assert.deepEqual(Progression.coldLineage(999), [999]);
assert.deepEqual(Progression.coldLineage('bad'), [0]);
assert.deepEqual(Progression.coldLineage(null), [0]);
assert.deepEqual(Progression.lineage(null), []);
assert.deepEqual(Progression.coldLineage(-1), []);
assert.deepEqual(Progression.coldLineage(88), [0, 1, 2, 88]);
const cold = Progression.mergedSkillTrees(trees, Progression.coldLineage(1));
assert.deepEqual(cold.map(row => row.selfId), ['7', 8]);
assert.deepEqual(cold[0].levels.map(row => row.level), [3, 1, 2]);
assert.equal(cold[0].levels[1], childRanks[1]);
assert.equal(cold[0].baseOnly, true, 'cold merged metadata retains ancestor-only fields');
assert.equal(cold[1], independent, 'unmerged cold entries remain borrowed');
assert.equal(Progression.mergedSkillTrees(trees, [0])[0], base, 'first cold ranks are not deduplicated');
assert.notEqual(cold, Progression.mergedSkillTrees(trees, [0, 1]), 'cold outer arrays remain fresh');
const books = Progression.mergedSkillTrees(trees, Progression.lineage(1), 'books');
assert.deepEqual(books[0].levels.map(row => row.level), [1, 2, 3]);
assert.equal(books[0].baseOnly, undefined, 'book metadata uses the current entry only');
assert.notEqual(books[1], independent, 'book entries remain caller-owned projections');
const sparseSkills = [{ classId: 0, skills: [, base] }];
assert.deepEqual(Progression.mergedSkillTrees(sparseSkills, [0]), [base], 'cold forEach skips sparse skill slots');
assert.throws(() => Progression.mergedSkillTrees(sparseSkills, [0], 'books'), TypeError, 'book for-of rejects sparse skills');
const sparseRanks = [{ classId: 0, skills: [{ selfId: 7, levels: [{ level: 1 }] }] },
    { classId: 1, skills: [{ selfId: 7, levels: [, { level: 2 }] }] }];
assert.deepEqual(Progression.mergedSkillTrees(sparseRanks, [0, 1])[0].levels.map(row => row.level), [1, 2]);
assert.throws(() => Progression.mergedSkillTrees(sparseRanks, [0, 1], 'books'), TypeError);
assert.equal(Progression.currentTreeSkill(trees, 1, 7), child);
assert.equal(Progression.currentTreeSkill(trees, 2, 7), undefined, 'rest lookup does not inherit');
const learning = Progression.learningLevels(trees);
assert.equal(learning.get(1).get(99), 40, 'raw imported class relation is LAST');
assert.equal(learning.get(1).get(7), 1, 'learning minimum follows ancestors');
assert.equal(learning.get(1).get('7'), undefined, 'raw skill key types remain distinct');
const rawLearning = Progression.learningLevels([{ classId: 0, skills: [base] }, { classId: '1', skills: [child] }]);
assert.equal(rawLearning.has(1), false, 'raw imported class keys are not normalized');
assert.equal(rawLearning.has('1'), true);
assert.equal(rawLearning.get('1').has('7'), false, 'numeric lineage cannot select a raw string class key');
trees[2].skills[0].levels[0].pLevel = 50;
assert.equal(learning.get(1).get(99), 40, 'imported learning levels are a snapshot');

const directorySource = [{ classId: 2, template: { class: 'Zulu' } },
    { classId: '0', template: { class: 'Alpha' } }, { classId: 0, template: { class: 'Alpha' } }];
const directory = Progression.classDirectory(directorySource);
assert.deepEqual(directory.map(row => row.classId), [0, 0, 2]);
directory[0].className = 'Caller edit';
assert.equal(Progression.classDirectory(directorySource)[0].className, 'Alpha');
directorySource[0].template.class = 'Aardvark';
assert.deepEqual(Progression.classDirectory(directorySource).map(row => row.classId), [2, 0, 0]);
const publicRows = [{ classId: '1', label: 'First' }, { classId: 1, className: 'Second' }];
assert.equal(Filters.className({ classId: 1, className: 'Direct' }, publicRows), 'Direct');
assert.equal(Filters.className({ classId: 1 }, publicRows), 'First');
publicRows.reverse();
assert.equal(Filters.className({ classId: 1 }, publicRows), 'Second');
publicRows[0].classId = 2;
publicRows[1].label = 'Fresh';
assert.equal(Filters.className({ classId: 1 }, publicRows), 'Fresh');
assert.equal(Filters.className({ classId: 1 }, [publicRows[1], { classId: Symbol() }]), 'Fresh');

const data = { classTemplates: [numericRow], skillTree: trees };
const warnings = [];
global.utils = { infoWarn: (...args) => warnings.push(args) };
global.invoke = path => path === 'GameServer/DataCache' ? data : path === 'GameServer/ClassProgression' ? Progression
    : path === 'GameServer/Formulas' ? { calcLevelMod: () => 1, calcBaseMod: { CON: () => 1, MEN: () => 1 } }
    : path === 'GameServer/Skills/C4SkillRules' ? { resolve: ({ level }) => ({ stats: { regHpAdd: level } }) } : {};
const Books = require('../src/GameServer/Skills/SkillBookCatalog');
const firstBookView = Books.entries(1);
assert.equal(Books.entries(1), firstBookView, 'books keep their caller-owned current-source snapshot');
data.skillTree = [{ classId: 1, skills: [independent] }];
assert.deepEqual(Books.entries(1).map(row => row.selfId), [8]);
trees[1].skills[0].marker = 'source returned';
data.skillTree = trees;
assert.notEqual(Books.entries(1), firstBookView, 'A->B->A starts a new source observation');
assert.equal(Books.entries(1)[0].marker, 'source returned');
const Cold = require('../src/GameServer/Bot/Population/ColdSkillTree');
assert.deepEqual(Cold.classProgressionIds(999), [999]);
assert.deepEqual(Cold.skillTreeEntries(1)[0].levels.map(row => row.level), [3, 1, 2]);
const Data = require('../src/GameServer/DataCache');
Data.skillTree = [{ classId: 0, skills: [{ selfId: 7, levels: firstRanks }] }];
let callbacks = 0;
Data.fetchSkillTreeFromClassId(0, row => { callbacks++; row.skills.length = 0; });
assert.equal(callbacks, 1);
assert.equal(Data.skillTree[0].skills.length, 1, 'DataCache callback receives a clone');
Data.fetchSkillTreeFromClassId('0', () => callbacks++);
assert.equal(callbacks, 1);
assert.equal(warnings.length, 1, 'unknown strict class warns without calling back');
Data.skillTree = undefined;
assert.throws(() => Data.fetchSkillTreeFromClassId(0, () => {}), TypeError);
const Rest = require('../src/GameServer/Bot/Population/ColdRest');
data.skillTree = [{ classId: 0, skills: [{ selfId: 212, levels: [{ level: 9, pLevel: 1 }] }] },
    { classId: 1, skills: [{ selfId: 212, levels: [{ level: 1, pLevel: 1 }, { level: 3, pLevel: 50 }, { level: 2, pLevel: 1 }] }] }];
assert.equal(Rest.coldRestRegenPerTick({ classId: 1, level: 20 }).hp, 3, 'eligible maximum rank, not final rank or inherited rank');
assert.equal(Rest.coldRestRegenPerTick({ classId: 2, level: 20 }).hp, 0);
const Shared = require('../src/GameServer/Network/Shared');
(async () => {
    assert.equal(await Shared.fetchClassInformation(0), numericRow);
    await Shared.fetchClassInformation('0').then(() => assert.fail('strict class mismatch must reject'), error => assert.equal(error, undefined));
    data.classTemplates = undefined;
    await assert.rejects(Shared.fetchClassInformation(0), TypeError);
    console.log('class-data source, lineage, tree projection and caller contracts passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
