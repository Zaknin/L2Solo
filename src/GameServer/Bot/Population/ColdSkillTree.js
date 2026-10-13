'use strict';
const DataCache = invoke('GameServer/DataCache');
const ClassProgression = invoke('GameServer/ClassProgression');

// Native tree projection is independent of NpcSkills/Model.Skill/network.
// These are the original ColdCombatProfile tree bodies, shared by both paths.
function number(value, fallback = 0) {
    const resolved = Number(value);
    return Number.isFinite(resolved) ? resolved : fallback;
}

function classProgressionIds(classId) {
    return ClassProgression.coldLineage(classId);
}

function skillTreeEntries(classId) {
    return ClassProgression.mergedSkillTrees(DataCache.skillTree || [], classProgressionIds(classId), 'cold');
}

// The highest level row of a tree entry that a character of `level` has learned.
function learnedTreeRow(entry, level) {
    return (entry.levels || []).filter((row) => number(row.pLevel) <= level).at(-1);
}

// The level of one skill a class line knows at a character level, 0 if none.
function treeSkillLevel(classId, level, skillId) {
    const entry = skillTreeEntries(classId).find((candidate) => number(candidate.selfId) === number(skillId));
    return entry ? number(learnedTreeRow(entry, number(level))?.level) : 0;
}

module.exports = { classProgressionIds, skillTreeEntries, learnedTreeRow, treeSkillLevel };
