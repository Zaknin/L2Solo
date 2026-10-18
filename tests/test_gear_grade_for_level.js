'use strict';
// Pins the level -> gear grade rule used by BotEquipmentUpgrade (through rankAllowed) and
// GearAcquisitionPlanner (gradeForLevel): none below 20, D 20-39, C 40-51, B 52-60, A 61-75, S from 76.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
require('../src/Global');

const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');

function expectedGrade(level) {
    const value = Number(level || 1);
    for (const [min, grade] of [[76, 's'], [61, 'a'], [52, 'b'], [40, 'c'], [20, 'd']]) if (value >= min) return grade;
    return 'none';
}

// rankAllowed is private to BotEquipmentUpgrade: load a copy of the module that exposes it.
const file = path.join(__dirname, '..', 'src', 'GameServer', 'Bot', 'AI', 'BotEquipmentUpgrade.js');
const upgrade = new Module(file, module);
upgrade.filename = file;
upgrade.paths = Module._nodeModulePaths(path.dirname(file));
upgrade._compile(`${fs.readFileSync(file, 'utf8')}\nmodule.exports.__rankAllowed = rankAllowed;`, file);
const rankAllowed = upgrade.exports.__rankAllowed;

const ranks = ['none', 'd', 'c', 'b', 'a', 's'];
const levels = [undefined, null, 0, '', 'x', NaN, '25', 1, 19, 20, 21, 39, 40, 41, 51, 52, 53, 60, 61, 62, 75, 76, 77, 80, 99];
for (let level = 0; level <= 100; level++) levels.push(level);
for (const level of levels) {
    const grade = expectedGrade(level);
    assert.strictEqual(Planner.gradeForLevel(level), grade, `Planner.gradeForLevel(${String(level)})`);
    const actor = { fetchLevel: () => level };
    ranks.forEach((rank, index) => {
        assert.strictEqual(rankAllowed({ fetchRank: () => rank }, actor), index <= ranks.indexOf(grade),
            `rankAllowed(${rank}) at level ${String(level)}`);
    });
    assert.strictEqual(rankAllowed({}, actor), true, 'an item with no rank counts as none');
    assert.strictEqual(rankAllowed({ fetchRank: () => 'x' }, actor), false, 'an unknown rank is refused');
}
console.log('test_gear_grade_for_level: ok');
