'use strict';
const hennaData = require('../../../data/Henna/c4-henna.json');
const symbols = hennaData.symbols;
const trees = require('../../../data/Henna/c4-henna-trees.json').trees;
const ClassProgression = require('../ClassProgression');
const STAT_KEYS = ['STR','DEX','CON','INT','WIT','MEN'];
const currentIndex = require('../Knowledge/NativeServiceIndex').currentIndex;
const symbolIndex = currentIndex(['id'], rows => new Map(rows.map(row => [row.id, row])));
const byId = symbolIndex(symbols) || new Map(symbols.map(row => [row.id, row]));
const dyeIndex = currentIndex(['dyeSelfId'], rows =>
    new Set(rows.map(row => row.dyeSelfId)));
function availableForClass(classId) { return (trees[Number(classId)] || []).map(id => byId.get(id)).filter(Boolean); }
// The service originally took its own import-time snapshots. Share a symbol
// Map only while its row/order/ID snapshot is identical to the earlier rules.
function serviceView(data = require('../../../data/Henna/c4-henna.json'),
    treeData = require('../../../data/Henna/c4-henna-trees.json')) {
    const serviceSymbols = symbolIndex(data.symbols) || new Map(data.symbols.map(row => [row.id, row]));
    const classIds = new Map(Object.entries(treeData.trees).map(([classId, ids]) => [Number(classId), ids]));
    return {
        symbolStrict: id => serviceSymbols.get(id),
        symbol: id => serviceSymbols.get(Number(id)) || null,
        hasSymbolForClass: (classId, symbolId) => (classIds.get(Number(classId)) || []).includes(symbolId),
        isTattooDye: id => isTattooDye(id, data)
    };
}
function symbolForClass(classId, symbolId) {
    // This class-owned list preserves the tree's map/filter contract, including
    // sparse entries and malformed trees, before the strict first row match.
    return availableForClass(classId).find(symbol => symbol.id === symbolId);
}
function isTattooDye(selfId, data = hennaData) {
    const rows = data.symbols;
    if (Array.isArray(rows) && !rows.length) return false;
    if (selfId && ['object', 'function'].includes(typeof selfId))
        return rows.some(row => row.dyeSelfId === Number(selfId));
    const index = dyeIndex(rows);
    if (!index) return rows.some(row => row.dyeSelfId === Number(selfId));
    const id = Number(selfId);
    return !Number.isNaN(id) && index.has(id);
}
function slotsForClass(classId) { return Math.min(3, ClassProgression.lineage(classId).length); }
function totals(slots = []) { return Object.fromEntries(STAT_KEYS.map(stat => [stat,
    Math.min(5, slots.reduce((sum, id) => sum + Number(byId.get(Number(id))?.[stat] || 0), 0))])); }
module.exports = { STAT_KEYS, availableForClass, serviceView, symbolForClass, isTattooDye,
    slotsForClass, totals, symbolStrict: id => byId.get(id), symbol: id => byId.get(Number(id)) || null };
