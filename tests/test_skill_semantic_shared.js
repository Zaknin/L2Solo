const assert = require('assert');

require('../src/Global');
const Rules = invoke('GameServer/Skills/C4SkillRules');
const Skill = invoke('GameServer/Model/Skill');

// Every NPC instance builds its own SkillModels: equal skill data must share
// one read-only semantic, while each model keeps its own data object.
const data = () => ({ selfId: 990001, level: 3, name: 'Test Strike', power: 40, spell: false, distance: 40 });
const a = new Skill(data());
const b = new Skill(data());
assert.strictEqual(a.fetchSemantic(), b.fetchSemantic(), 'equal skills share one semantic');
assert.strictEqual(a.fetchSemantic(), Rules.resolveCached(data()), 'the semantic comes from the resolve memo');
assert.deepStrictEqual(a.fetchSemantic(), Rules.resolve(data()), 'the shared semantic equals a fresh resolve');

assert.notStrictEqual(new Skill({ ...data(), level: 4 }).fetchSemantic(), a.fetchSemantic(), 'another level resolves apart');
assert.notStrictEqual(new Skill({ ...data(), power: 41 }).fetchSemantic(), a.fetchSemantic(), 'another power resolves apart');

assert.notStrictEqual(a.model, b.model, 'each model keeps its own data');
a.setCalculatedHitTime(5);
assert.strictEqual(a.model.calculatedHitTime, 5);
assert.strictEqual(b.model.calculatedHitTime, undefined, 'a hit time set on one model stays on it');

console.log('skill semantic shared: ok');
