const thirdClasses = {
    88: { parentClassId: 2, name: 'Duelist', cp: { baseCpMax: 2755.6, lvlCpAdd: 56.77, lvlCpMod: 0.22 } },
    89: { parentClassId: 3, name: 'Dreadnought', cp: { baseCpMax: 2619.3, lvlCpAdd: 55.78, lvlCpMod: 0.22 } },
    90: { parentClassId: 5, name: 'Phoenix Knight', cp: { baseCpMax: 1730.3, lvlCpAdd: 35.86, lvlCpMod: 0.22 } },
    91: { parentClassId: 6, name: 'Hell Knight', cp: { baseCpMax: 1730.3, lvlCpAdd: 35.86, lvlCpMod: 0.22 } },
    92: { parentClassId: 9, name: 'Sagittarius', cp: { baseCpMax: 1910.9, lvlCpAdd: 39.51, lvlCpMod: 0.22 } },
    93: { parentClassId: 8, name: 'Adventurer', cp: { baseCpMax: 1049.4, lvlCpAdd: 21.25, lvlCpMod: 0.22 } },
    94: { parentClassId: 12, name: 'Archmage', cp: { baseCpMax: 1440, lvlCpAdd: 29.05, lvlCpMod: 0.22 } },
    95: { parentClassId: 13, name: 'Soultaker', cp: { baseCpMax: 1440, lvlCpAdd: 29.05, lvlCpMod: 0.22 } },
    96: { parentClassId: 14, name: 'Arcana Lord', cp: { baseCpMax: 1823.5, lvlCpAdd: 37.85, lvlCpMod: 0.22 } },
    97: { parentClassId: 16, name: 'Cardinal', cp: { baseCpMax: 2227.8, lvlCpAdd: 44.16, lvlCpMod: 0.22 } },
    98: { parentClassId: 17, name: 'Hierophant', cp: { baseCpMax: 1671, lvlCpAdd: 34.03, lvlCpMod: 0.22 } },
    99: { parentClassId: 20, name: "Eva's Templar", cp: { baseCpMax: 1917.6, lvlCpAdd: 39.84, lvlCpMod: 0.22 } },
    100: { parentClassId: 21, name: 'Sword Muse', cp: { baseCpMax: 1651.1, lvlCpAdd: 34.86, lvlCpMod: 0.22 } },
    101: { parentClassId: 23, name: 'Wind Rider', cp: { baseCpMax: 1174.3, lvlCpAdd: 23.9, lvlCpMod: 0.22 } },
    102: { parentClassId: 24, name: 'Moonlight Sentinel', cp: { baseCpMax: 1521, lvlCpAdd: 31.54, lvlCpMod: 0.22 } },
    103: { parentClassId: 27, name: 'Mystic Muse', cp: { baseCpMax: 1506.5, lvlCpAdd: 30.71, lvlCpMod: 0.22 } },
    104: { parentClassId: 28, name: 'Elemental Master', cp: { baseCpMax: 1871.5, lvlCpAdd: 38.84, lvlCpMod: 0.22 } },
    105: { parentClassId: 30, name: "Eva's Saint", cp: { baseCpMax: 1711, lvlCpAdd: 34.86, lvlCpMod: 0.22 } },
    106: { parentClassId: 33, name: 'Shillien Templar', cp: { baseCpMax: 2024.4, lvlCpAdd: 41.83, lvlCpMod: 0.22 } },
    107: { parentClassId: 34, name: 'Spectral Dancer', cp: { baseCpMax: 1766.6, lvlCpAdd: 37.35, lvlCpMod: 0.22 } },
    108: { parentClassId: 36, name: 'Ghost Hunter', cp: { baseCpMax: 1245.5, lvlCpAdd: 25.23, lvlCpMod: 0.22 } },
    109: { parentClassId: 37, name: 'Ghost Sentinel', cp: { baseCpMax: 1610, lvlCpAdd: 33.2, lvlCpMod: 0.22 } },
    110: { parentClassId: 40, name: 'Storm Screamer', cp: { baseCpMax: 1519.5, lvlCpAdd: 30.71, lvlCpMod: 0.22 } },
    111: { parentClassId: 41, name: 'Spectral Master', cp: { baseCpMax: 1918.9, lvlCpAdd: 39.84, lvlCpMod: 0.22 } },
    112: { parentClassId: 43, name: 'Shillien Saint', cp: { baseCpMax: 1723.9, lvlCpAdd: 34.86, lvlCpMod: 0.22 } },
    113: { parentClassId: 46, name: 'Titan', cp: { baseCpMax: 2413, lvlCpAdd: 51.03, lvlCpMod: 0.22 } },
    114: { parentClassId: 48, name: 'Grand Khavatari', cp: { baseCpMax: 1646.6, lvlCpAdd: 34.76, lvlCpMod: 0.22 } },
    115: { parentClassId: 51, name: 'Dominator', cp: { baseCpMax: 2687.9, lvlCpAdd: 54.35, lvlCpMod: 0.22 } },
    116: { parentClassId: 52, name: 'Doomcryer', cp: { baseCpMax: 1679.9, lvlCpAdd: 33.93, lvlCpMod: 0.22 } },
    117: { parentClassId: 55, name: 'Fortune Seeker', cp: { baseCpMax: 2413, lvlCpAdd: 51.03, lvlCpMod: 0.22 } },
    118: { parentClassId: 57, name: 'Maestro', cp: { baseCpMax: 2634.5, lvlCpAdd: 55.68, lvlCpMod: 0.22 } }
};

const firstProfMap = {
    0: [1, 4, 7],
    10: [11, 15],
    18: [19, 22],
    25: [26, 29],
    31: [32, 35],
    38: [39, 42],
    44: [45, 47],
    49: [50],
    53: [54, 56]
};

const secondProfMap = {
    1: [2, 3],
    4: [5, 6],
    7: [8, 9],
    11: [12, 13, 14],
    15: [16, 17],
    19: [20, 21],
    22: [23, 24],
    26: [27, 28],
    29: [30],
    32: [33, 34],
    35: [36, 37],
    39: [40, 41],
    42: [43],
    45: [46],
    47: [48],
    50: [51, 52],
    54: [55],
    56: [57]
};

function getThirdClass(classId) {
    return thirdClasses[Number(classId)] || null;
}

function expandTemplates(templates) {
    Object.entries(thirdClasses).forEach(([classId, thirdClass]) => {
        if (templates.some((template) => template.classId === Number(classId))) return;

        const parent = templates.find((template) => template.classId === thirdClass.parentClassId);
        if (!parent) throw new Error(`third-class parent template ${thirdClass.parentClassId} is missing`);

        templates.push({
            ...structuredClone(parent),
            classId: Number(classId),
            template: { ...parent.template, class: thirdClass.name }
        });
    });
}

const nativeParents = new Map();
for (const map of [firstProfMap, secondProfMap]) {
    for (const [parent, children] of Object.entries(map)) for (const child of children) nativeParents.set(child, Number(parent));
}
const parents = new Map(nativeParents);
for (const [id, entry] of Object.entries(thirdClasses)) parents.set(Number(id), entry.parentClassId);
const knownClasses = new Set([...Object.keys(firstProfMap).map(Number), ...parents.keys()]);

function lineage(classId) {
    if (classId === null || classId === undefined || classId === '') return [];
    let current = Number(classId);
    if (!knownClasses.has(current)) return [];
    const result = [];
    while (current !== undefined) { result.unshift(current); current = parents.get(current); }
    return result;
}

// Cold execution also keeps an unknown finite class in its result. Canonical
// progression deliberately returns [] for that same input.
function coldLineage(classId) {
    const ids = [], seen = new Set();
    let current = finiteNumber(classId);
    while (Number.isFinite(current) && current >= 0 && !seen.has(current)) {
        seen.add(current);
        ids.unshift(current);
        const third = finiteNumber(getThirdClass(current)?.parentClassId, NaN);
        const parent = Number.isFinite(third) ? third : nativeParents.get(current) ?? null;
        if (parent === null || parent === current) break;
        current = parent;
    }
    return ids;
}

function finiteNumber(value, fallback = 0) {
    const result = Number(value);
    return Number.isFinite(result) ? result : fallback;
}

const loadedSources = new WeakSet();
const sourceIndices = new WeakMap();

// Only the DataCache loader declares immutable class IDs/order. Independently
// supplied arrays retain fresh reads, including same-length edits and reorders.
function registerLoadedSource(source) { if (Array.isArray(source)) loadedSources.add(source); }
function invalidateSource(source) { sourceIndices.delete(source); }
function classKey(value, policy) {
    return policy === 'strict' ? value : policy === 'finite' ? finiteNumber(value) : Number(value);
}
function firstClassRow(source, classId, policy = 'numeric') {
    const scan = () => source.find(row => classKey(row.classId, policy) === classKey(classId, policy));
    if (!Array.isArray(source)) return scan();
    if (!source.length) return undefined;
    if (classId !== null && ['object', 'function'].includes(typeof classId)) return scan();
    let policies = sourceIndices.get(source);
    if (!policies) { policies = new Map(); sourceIndices.set(source, policies); }
    let index = policies.get(policy);
    if (index && index.length === source.length && !loadedSources.has(source)) {
        try {
            for (let position = 0; position < source.length; position++) {
                if (source[position] !== index.sourceRows[position]
                    || !Object.is(source[position].classId, index.keys[position])) { index = null; break; }
            }
        } catch { return scan(); }
    }
    if (!index || index.length !== source.length) {
        index = { length: source.length, rows: new Map(), keys: [], sourceRows: [], scanRequired: false };
        for (let position = 0; position < source.length; position++) {
            const row = source[position];
            index.sourceRows.push(row);
            try {
                const raw = row.classId;
                index.keys.push(raw);
                if (policy !== 'strict' && raw !== null && ['object', 'function'].includes(typeof raw)) {
                    index.scanRequired = true;
                    continue;
                }
                const key = classKey(raw, policy);
                if (!Number.isNaN(key) && !index.rows.has(key)) index.rows.set(key, row);
            } catch { index.scanRequired = true; }
        }
        policies.set(policy, index);
    }
    if (index.scanRequired) return scan();
    const key = classKey(classId, policy);
    return Number.isNaN(key) ? undefined : index.rows.get(key);
}

// The different native projections are inputs to one merge. Cold keeps its
// first entry borrowed and ranks in insertion order; books collapse and sort.
function eachTreeEntry(rows, policy, visit) {
    if (policy === 'cold') rows.forEach(visit);
    else for (const row of rows) visit(row);
}
function mergedSkillTrees(source, classIds, policy = 'cold') {
    const normalize = policy === 'cold' ? finiteNumber : Number;
    const skills = new Map();
    for (const id of classIds) {
        const tree = firstClassRow(source, id, policy === 'cold' ? 'finite' : 'numeric');
        eachTreeEntry(tree?.skills || [], policy, entry => {
            const key = normalize(entry.selfId), previous = skills.get(key);
            if (policy === 'cold' && !previous) { skills.set(key, entry); return; }
            const ranks = new Map((previous?.levels || []).map(row => [normalize(row.level), row]));
            eachTreeEntry(entry.levels || [], policy, row => ranks.set(normalize(row.level), row));
            const levels = [...ranks.values()];
            if (policy === 'books') levels.sort((left, right) => left.level - right.level);
            skills.set(key, { ...(policy === 'cold' ? previous : null), ...entry, levels });
        });
    }
    return [...skills.values()];
}

function currentTreeSkill(source, classId, skillId) {
    return firstClassRow(source, classId)?.skills?.find(entry => Number(entry.selfId) === skillId);
}

// BotClassPolicy imports a strict LAST class snapshot once, independently of
// DataCache. Keep raw keys and its minimum character level through the lineage.
function learningLevels(source) {
    const trees = new Map(source.map(entry => [entry.classId, entry.skills]));
    const learning = new Map();
    for (const id of trees.keys()) {
        const skills = new Map();
        for (const current of lineage(id)) {
            for (const skill of trees.get(current) || []) {
                skills.set(skill.selfId, Math.min(skills.get(skill.selfId) ?? Infinity,
                    ...skill.levels.map(rank => rank.pLevel)));
            }
        }
        learning.set(id, skills);
    }
    return learning;
}

const directories = new WeakMap();
function normalizedClassId(value) {
    if (value === null || value === undefined || value === '') return null;
    const id = Number(value);
    return Number.isInteger(id) && id >= 0 ? id : null;
}
function classDirectory(source) {
    // Full directory output requires a fresh view. Validate the payload as well
    // as IDs; sorting can be reused without hiding mutable names or duplicates.
    const rows = source.map(template => ({ classId: normalizedClassId(template.classId),
        className: template.template?.class || null }));
    const previous = directories.get(source);
    if (previous && rows.length === previous.sourceRows.length && rows.every((row, index) =>
        row.classId === previous.sourceRows[index].classId && row.className === previous.sourceRows[index].className)) {
        return previous.sorted.map(row => ({ ...row }));
    }
    const sorted = rows.filter(row => row.classId !== null && row.className)
        .sort((left, right) => left.className.localeCompare(right.className, 'en', { sensitivity: 'base' }));
    directories.set(source, { sourceRows: rows, sorted });
    return sorted.map(row => ({ ...row }));
}

module.exports = { thirdClasses, firstProfMap, secondProfMap, getThirdClass, expandTemplates, lineage,
    coldLineage, firstClassRow, mergedSkillTrees, currentTreeSkill, learningLevels, classDirectory,
    registerLoadedSource, invalidateSource };
