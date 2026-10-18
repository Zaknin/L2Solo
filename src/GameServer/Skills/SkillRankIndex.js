'use strict';

const ItemTemplateIndex = require('../Item/ItemTemplateIndex');
const indexes = new WeakMap();
let definitionSource;
let definitionRanks;
const identity = value => value;
function finiteLevel(value) {
    const converted = Number(value);
    return Number.isFinite(converted) ? converted : 0;
}

// Native ranks retain their raw order and duplicates. Each caller explicitly
// chooses its original equality and fallback policy; returned rows are borrowed.
function indexFor(levels, policy) {
    let policies = indexes.get(levels);
    if (!policies) { policies = new Map(); indexes.set(levels, policies); }
    let index = policies.get(policy);
    if (index && index.length === levels.length) return index;
    index = { length: levels.length, first: new Map(), scanRequired: false };
    for (let position = 0; position < levels.length; position++) {
        try {
            const row = levels[position];
            const key = policy === 'strict' ? row.level : policy === 'finite' ? finiteLevel(row.level) : Number(row.level);
            if (!Number.isNaN(key) && !index.first.has(key)) index.first.set(key, row);
        } catch { index.scanRequired = true; }
    }
    policies.set(policy, index);
    return index;
}

function exact(levels, requested, policy) {
    const convert = policy === 'strict' ? identity : policy === 'finite' ? finiteLevel : Number;
    if (!Array.isArray(levels)) return levels.find(row => convert(row.level) === (policy === 'numericRow' ? requested : convert(requested)));
    if (!levels.length) return undefined;
    const index = indexFor(levels, policy === 'numericRow' ? 'numeric' : policy);
    if (index.scanRequired) return levels.find(row => convert(row.level) === (policy === 'numericRow' ? requested : convert(requested)));
    const key = policy === 'numericRow' ? requested : convert(requested);
    return policy === 'numericRow' && typeof key !== 'number' ? undefined : index.first.get(key);
}

function lastEligible(levels, requested, policy) {
    const convert = policy === 'finite' ? finiteLevel : Number;
    if (!Array.isArray(levels)) return levels.filter(row => convert(row.level) <= convert(requested)).at(-1);
    if (!levels.length) return undefined;
    const index = indexFor(levels, policy);
    if (index.scanRequired) return levels.filter(row => convert(row.level) <= convert(requested)).at(-1);
    if (!index.eligible) {
        const positions = new Map();
        levels.forEach((row, position) => {
            const key = convert(row.level);
            if (!Number.isNaN(key)) positions.set(key, position);
        });
        // The answer at a threshold is the greatest RAW position below it,
        // which may have a smaller level than another eligible row.
        index.eligible = [...positions].sort((a, b) => a[0] - b[0]);
        let rawPosition = -1;
        for (const entry of index.eligible) {
            rawPosition = Math.max(rawPosition, entry[1]);
            entry[1] = rawPosition;
        }
    }
    const threshold = convert(requested);
    if (Number.isNaN(threshold)) return undefined;
    let low = 0, high = index.eligible.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (index.eligible[middle][0] <= threshold) low = middle + 1;
        else high = middle;
    }
    return low ? levels[index.eligible[low - 1][1]] : undefined;
}

const find = (levels, requested) => exact(levels, requested, 'numeric');
const findStrict = (levels, requested) => exact(levels, requested, 'strict');
function has(levels, requested) {
    if (!Array.isArray(levels)) return levels.some(row => Number(row.level) === Number(requested));
    if (!levels.length) return false;
    const index = indexFor(levels, 'numeric');
    if (index.scanRequired) return levels.some(row => Number(row.level) === Number(requested));
    return index.first.has(Number(requested));
}
const findOrLastEligible = (levels, requested) => find(levels, requested) || lastEligible(levels, requested, 'numeric');
const findFiniteOrLastEligible = (levels, requested) => exact(levels, requested, 'finite') || lastEligible(levels, requested, 'finite');
const findOrPosition = (levels, requested) => exact(levels, requested, 'numericRow')
    || levels[Math.max(0, Math.min(levels.length - 1, requested - 1))];

// SkillBookCatalog's relation is an identity snapshot: numeric LAST skill ID
// and a Set of Number(rank.level), including NaN. Do not rebuild on append.
function ranksForSkill(definitions, skillId) {
    if (definitionSource !== definitions) {
        const ranks = new Map(definitions.map(skill => [skill, new Set((skill.levels || []).map(rank => Number(rank.level)))]));
        const rows = ItemTemplateIndex.currentLastIndex(definitions);
        const selected = new Set(rows.values());
        for (const skill of ranks.keys()) if (!selected.has(skill)) ranks.delete(skill);
        definitionRanks = { rows, ranks };
        definitionSource = definitions;
    }
    return definitionRanks.ranks.get(definitionRanks.rows.get(Number(skillId)));
}

module.exports = { find, findStrict, has, findOrLastEligible, findFiniteOrLastEligible, findOrPosition, ranksForSkill };
