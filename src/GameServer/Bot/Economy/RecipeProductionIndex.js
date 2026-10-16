'use strict';
const Sources = require('../../Items/ItemAcquisitionCatalog');
const RecipeCatalog = require('../../Knowledge/RecipeCatalog');
const { createHash } = require('node:crypto');
const EMPTY_CONTENT_IDENTITY = createHash('sha256').update('[]').digest('hex');

// Public candidate admission only. Prices, ownership, funds and executable
// demand are still evaluated through the existing per-item quote readers.
const boards = new WeakMap();
let catalog = null;
function recipeCatalog() {
    if (!catalog) {
        const unique = new Map();
        for (const recipe of RecipeCatalog.recipeItemRows(invoke('GameServer/Items/C4RecipeItems'))) {
            if (!Sources.allowsRecipe(recipe) || recipe?.type !== 'dwarven' || !Number.isInteger(Number(recipe.level))
                || recipe.level < 1 || recipe.level > 9 || !(recipe.recipeItemId > 0) || !(recipe.productId > 0)) continue;
            unique.set(Number(recipe.recipeId), recipe);
        }
        const rows = Object.freeze([...unique.values()]);
        const reverse = new Map();
        for (const recipe of rows) for (const id of new Set([Number(recipe.recipeItemId), Number(recipe.productId)])) {
            if (!reverse.has(id)) reverse.set(id, []);
            reverse.get(id).push(recipe);
        }
        for (const rows of reverse.values()) Object.freeze(rows);
        catalog = Object.freeze({ rows, reverse });
    }
    return catalog;
}
class RecipeProductionIndex {
    constructor(board, { fixedBuyer = () => false, accept = () => true } = {}) {
        this.board = board; this.fixedBuyer = fixedBuyer; this.accept = accept;
        this.catalog = recipeCatalog();
        this.rows = Array.from({ length: 10 }, () => new Set());
        this.revisions = new Uint32Array(10);
        this.identities = Array(10).fill(EMPTY_CONTENT_IDENTITY);
        const changed = new Set();
        for (const recipe of this.catalog.rows) this.refresh(recipe, changed);
        this.publishIdentities(changed);
    }
    scopeFor(level) { return `recipe-production:${Math.max(0, Math.min(9, Math.floor(Number(level) || 0)))}`; }
    revision(scope) {
        const match = /^recipe-production:([0-9])$/.exec(String(scope));
        return match ? this.revisions[Number(match[1])] : 0;
    }
    contentIdentity(scope) {
        const match = /^recipe-production:([0-9])$/.exec(String(scope));
        return match ? this.identities[Number(match[1])] : null;
    }
    publishIdentities(levels) {
        // Recipe data belongs to the code generation already bound by the
        // decision proof. This owner publishes membership in native order.
        for (const level of levels) this.identities[level] = createHash('sha256')
            .update(JSON.stringify([...this.rows[level]].map(recipe => Number(recipe.recipeId)))).digest('hex');
    }
    rowsFor(level) { return this.rows[Math.max(0, Math.min(9, Math.floor(Number(level) || 0)))].values(); }
    refresh(recipe, changed = new Set()) {
        if (!this.accept(recipe)) return changed;
        const available = this.board.list(Number(recipe.productId), 3).length > 0 || this.fixedBuyer(recipe);
        for (let level = Number(recipe.level); level <= 9; level++) {
            const rows = this.rows[level];
            if (available === rows.has(recipe)) continue;
            if (available) rows.add(recipe); else rows.delete(recipe);
            changed.add(level);
        }
        return changed;
    }
    update(id) {
        const changed = new Set();
        for (const recipe of this.catalog.reverse.get(Number(id)) || []) this.refresh(recipe, changed);
        this.publishIdentities(changed);
        const scopes = [];
        for (const level of changed) { this.revisions[level]++; scopes.push(this.scopeFor(level)); }
        return scopes;
    }
    reset() {
        const changed = [], levels = [];
        for (let level = 1; level <= 9; level++) {
            if (!this.rows[level].size) continue;
            // Snapshot replacement clears public bids, while enabled authored
            // buyers still support the same indexed recipes without board rows.
            const rows = this.rows[level]; rows.clear();
            for (const recipe of this.catalog.rows) if (recipe.level <= level && this.accept(recipe) && this.fixedBuyer(recipe)) rows.add(recipe);
            this.revisions[level]++;
            levels.push(level);
            changed.push(this.scopeFor(level));
        }
        this.publishIdentities(levels);
        return changed;
    }
}
function forBoard(board, options) {
    let index = boards.get(board);
    if (!index) { index = new RecipeProductionIndex(board, options); boards.set(board, index); }
    return index;
}
// Lossless transport of the captured content, independent of the current
// board: one byte with the level, +16 and the raw digest after it unless the
// digest is exactly the canonical empty content.
function packScopeIdentity(value, write) {
    if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string'
        || typeof value[1] !== 'string' || !/^[a-f0-9]{64}$/.test(value[1])) return false;
    const match = /^recipe-production:([0-9])$/.exec(value[0]);
    if (!match) return false;
    if (value[1] === EMPTY_CONTENT_IDENTITY) write.byte(Number(match[1]));
    else { write.byte(16 + Number(match[1])); write.raw(Buffer.from(value[1], 'hex')); }
    return true;
}
function unpackScopeIdentity(read) {
    const tag = read.byte(), level = tag % 16;
    if (tag >= 32 || level > 9) return null;
    const identity = tag < 16 ? EMPTY_CONTENT_IDENTITY : read.raw(32).toString('hex');
    if (tag >= 16 && identity === EMPTY_CONTENT_IDENTITY) return null;
    return Object.freeze([`recipe-production:${level}`, identity]);
}
module.exports = { forBoard, packScopeIdentity, unpackScopeIdentity };
