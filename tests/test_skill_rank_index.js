'use strict';

const assert = require('assert');
const Ranks = require('../src/GameServer/Skills/SkillRankIndex');
const Items = require('../src/GameServer/Item/ItemTemplateIndex');
const finite = value => { const converted = Number(value); return Number.isFinite(converted) ? converted : 0; };
const rows = [5, '2', 5, 1, 4, undefined, NaN, Infinity, -Infinity, null].map((level, position) => ({ level, position }));
const requested = [0, 1, '2', 2, 3, 4, 5, 6, undefined, NaN, Infinity, -Infinity, null];
for (const levels of [[], rows, rows.slice().reverse(), [{ level: '2' }, { level: 2 }], [{ level: 5 }, { level: 2 }]]) {
    for (const level of requested) {
        assert.strictEqual(Ranks.find(levels, level), levels.find(row => Number(row.level) === Number(level)));
        assert.strictEqual(Ranks.findStrict(levels, level), levels.find(row => row.level === level));
        assert.strictEqual(Ranks.has(levels, level), levels.some(row => Number(row.level) === Number(level)));
        assert.strictEqual(Ranks.findOrLastEligible(levels, level), levels.find(row => Number(row.level) === Number(level))
            || levels.filter(row => Number(row.level) <= Number(level)).at(-1));
        assert.strictEqual(Ranks.findFiniteOrLastEligible(levels, level), levels.find(row => finite(row.level) === finite(level))
            || levels.filter(row => finite(row.level) <= finite(level)).at(-1));
        assert.strictEqual(Ranks.findOrPosition(levels, level), levels.find(row => Number(row.level) === level)
            || levels[Math.max(0, Math.min(levels.length - 1, level - 1))]);
    }
}
assert.strictEqual(Ranks.findOrLastEligible([{ level: 5 }, { level: 2 }], 6).level, 2, 'fallback is raw-last, not greatest level');
const first = { level: 2 }, second = { level: '2' };
assert.strictEqual(Ranks.find([first, second], '2'), first, 'numeric FIRST');
assert.strictEqual(Ranks.findStrict([first, second], '2'), second, 'strict FIRST');
const append = [first];
assert.strictEqual(Ranks.find(append, 3), undefined);
append.push({ level: 3 });
assert.strictEqual(Ranks.find(append, 3), append[1], 'length change rebuilds the rank index');
const invalid = [first, null];
assert.strictEqual(Ranks.find(invalid, 2), first, 'earlier match short-circuits malformed trailing rows');
assert.throws(() => Ranks.find(invalid, 3), TypeError);
assert.throws(() => Ranks.find(undefined, 3), TypeError, 'required missing ranks still throw');
assert.strictEqual(Ranks.find([], Symbol('empty')), undefined, 'empty find does not convert its query');
assert.strictEqual(Ranks.findOrLastEligible([], Symbol('empty')), undefined, 'empty fallback does not convert its query');
assert.strictEqual(Ranks.findFiniteOrLastEligible([], Symbol('empty')), undefined, 'empty finite fallback does not convert its query');
const sparse = new Array(2); sparse[1] = first;
assert.strictEqual(Ranks.has(sparse, 2), true, 'membership retains Array.some sparse semantics');

const definitionFirst = { selfId: 123, levels: [{ level: 1 }] };
const definitionLast = { selfId: '123', levels: [{ level: 3 }, { level: '3' }, { level: NaN }] };
const definitions = [definitionFirst, definitionLast];
assert.deepStrictEqual([...Ranks.ranksForSkill(definitions, 123)], [3, NaN], 'book ranks use numeric LAST and Set semantics');
definitions.push({ selfId: 123, levels: [{ level: 9 }] });
assert.deepStrictEqual([...Ranks.ranksForSkill(definitions, 123)], [3, NaN], 'book snapshot ignores same-source append');
Ranks.ranksForSkill([], 123);
assert.deepStrictEqual([...Ranks.ranksForSkill(definitions, 123)], [9], 'source switch rebuilds even a previously used source');

require('../src/Global');
const Data = invoke('GameServer/DataCache');
Data.skills = [definitionFirst, definitionLast];
const warnings = utils.infoWarn;
let warned = 0;
utils.infoWarn = () => { warned++; };
try {
    let cloned;
    Data.fetchSkillFromSelfId('123', skill => { cloned = skill; });
    assert.deepStrictEqual(cloned, definitionLast, 'callback retains strict FIRST selection');
    assert.notStrictEqual(cloned, definitionLast);
    cloned.levels[0].level = 99;
    assert.strictEqual(definitionLast.levels[0].level, 3, 'callback owns its clone');
    Data.fetchSkillFromSelfId(999, () => assert.fail('absent definition has no callback'));
    assert.strictEqual(warned, 1);
    Data.skills = undefined;
    assert.throws(() => Data.fetchSkillFromSelfId(123, () => {}), TypeError, 'missing definition source still throws');
} finally { utils.infoWarn = warnings; }

// The common ID owner is used over the actual definition array, with the
// individual caller's FIRST/type contracts rather than a merged skill source.
assert.strictEqual(Items.findRequired([definitionFirst, definitionLast], '123'), definitionFirst);
assert.strictEqual(Items.findStrictRequired([definitionFirst, definitionLast], '123'), definitionLast);

const definition = { selfId: 24601, template: { name: 'indexed fixture', passive: false, spell: false },
    time: { hitTime: 0, reuse: 0, buff: 0 }, levels: [{ level: 5, power: 50 }, { level: 2, power: 20 }] };
const strictStringDefinition = { ...definition, selfId: '24601', levels: [{ level: 2, power: 99 }] };
Data.skills = [definition, strictStringDefinition];
const Skillset = invoke('GameServer/Actor/Skillset');
const owned = new Skillset().populateSnapshot([{ selfId: '24601', level: 6 }]);
assert.strictEqual(owned[0].fetchLevel(), 2, 'snapshot caller retains numeric FIRST and raw-last fallback');
owned[0].model.power = 10;
assert.strictEqual(definition.levels[1].power, 20, 'snapshot models remain caller-owned');
const Cold = invoke('GameServer/Bot/Population/ColdCombatProfile');
assert.strictEqual(Cold.skillSnapshotsFromRecords([{ selfId: '24601', level: 6 }])[0].power, 20,
    'cold snapshot uses the same raw-last policy');
const Backpack = invoke('GameServer/Actor/Backpack');
assert.strictEqual(Backpack.prototype.buildItemSkill.call({}, { skillId: '24601', level: 2 }).fetchPower(), 99,
    'item skill caller retains strict FIRST definitions and exact ranks');
Data.skills = [{ selfId: 1045, template: { name: 'merged source substitute' }, levels: [{ level: 6, power: 999 }] }];
const Admin = invoke('GameServer/World/Generics/NpcBypasses/AdminFullBuff');
assert.strictEqual(Admin.skillData(1045, 6).name, 'Bless the Body', 'admin retains its independent Active-only source');
console.log('skill rank index contracts ok');
