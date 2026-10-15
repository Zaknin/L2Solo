'use strict';

const SkillRankIndex = require('./SkillRankIndex');
const data = require('../../../data/Skills/c4-skill-books.json');
const ClassProgression = require('../ClassProgression');
const books = new Map(data.skills);
const bookIds = new Set(books.values());
let treeSource = null;
let indexed = new Map();

function ranksFor(skillId) {
    const definitions = invoke('GameServer/DataCache').skills || [];
    return SkillRankIndex.ranksForSkill(definitions, skillId);
}

function entries(classId) {
    const trees = invoke('GameServer/DataCache').skillTree || [];
    if (trees !== treeSource) { treeSource = trees; indexed = new Map(); }
    if (!indexed.has(Number(classId))) {
        indexed.set(Number(classId), ClassProgression.mergedSkillTrees(trees, ClassProgression.lineage(classId), 'books'));
    }
    return indexed.get(Number(classId));
}

function nextTraining(classId, characterLevel, skillId, learnedLevel = 0) {
    const entry = entries(classId).find((row) => Number(row.selfId) === Number(skillId));
    const defined = ranksFor(skillId);
    const rank = entry?.levels.find((row) => Number(row.level) > Number(learnedLevel) && defined?.has(Number(row.level)));
    if (!rank || Number(rank.pLevel) > Number(characterLevel)) return null;
    return { skillId: Number(skillId), name: entry.name, level: Number(rank.level),
        sp: 0, bookId: null };
}

function learned(state) {
    return new Map((state.stats?.coldCombat?.skills || state.skills || [])
        .map((row) => [Number(row.selfId), Number(row.level)]));
}

function requiredBooks() {
    return [];
}

function missingBooks() {
    return [];
}

function needsTraining(state = {}) {
    const known = learned(state);
    const classId = Number(state.stats?.classId ?? state.classId);
    return entries(classId).some((entry) => {
        const training = nextTraining(classId, state.level, entry.selfId, known.get(Number(entry.selfId)) || 0);
        return training !== null;
    });
}

function nextTrainingSp(state = {}) {
    return needsTraining(state) ? 0 : Infinity;
}

// Automatic grants preserve the incoming rewards and physical inventory.
function applyTraining(state) {
    return state;
}

module.exports = { entries, nextTraining, requiredBooks, missingBooks, needsTraining, nextTrainingSp, applyTraining,
    bookFor: (skillId) => books.get(Number(skillId)) || null, isBook: (itemId) => bookIds.has(Number(itemId)) };
