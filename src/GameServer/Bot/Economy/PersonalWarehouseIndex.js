'use strict';
const { isMainThread } = require('node:worker_threads');
let ItemTemplateIndex = null;
const records = new Map(), pending = new Set();
let source = id => records.get(id), initialized = false, draining = false, revision = 0;
let ready = null;
const LIMIT = 64;
function publish(id, rows) {
    const quantities = new Map();
    for (const item of rows) {
        const key = `${item.selfId}:${Number(item.enchant || 0)}`;
        const row = quantities.get(key) || [Number(item.selfId), 0, Number(item.enchant || 0)];
        row[1] += Math.max(0, Number(item.amount) || 0); quantities.set(key, row);
    }
    const values = [...quantities.values()].filter(row => row[1] > 0).slice(0, LIMIT);
    if (JSON.stringify(records.get(id)?.[2] || []) === JSON.stringify(values)) return;
    const row = [id, ++revision, values];
    records.set(id, row);
    require('../Population/ColdTableChannel').shared.changed('personal_warehouse', row);
}
async function drain() {
    if (draining || !initialized) return;
    draining = true;
    try {
        const Database = invoke('Database');
        for (const id of [...pending].slice(0, 8)) {
            pending.delete(id);
            publish(id, await Database.fetchWarehouseItems(id));
        }
    } catch (error) { utils.infoWarn('BotWarehouse', 'asset projection: %s', error.message); }
    finally {
        draining = false;
        if (pending.size) setImmediate(drain);
    }
}
async function init() {
    if (!isMainThread || initialized) return;
    if (ready) return ready;
    ready = initialize();
    return ready;
}
async function initialize() {
    const rows = await invoke('Database').execute([`SELECT stock.characterId, stock.selfId, stock.enchant, SUM(stock.amount) AS amount
        FROM warehouse_items stock JOIN bot_life_state life ON life.characterId = stock.characterId
        WHERE stock.amount > 0 GROUP BY stock.characterId, stock.selfId, stock.enchant ORDER BY stock.characterId, stock.selfId`, []], 'warehouse:asset-projection');
    const byOwner = new Map();
    for (const row of rows) {
        const list = byOwner.get(Number(row.characterId)) || [];
        if (list.length < LIMIT) list.push(row);
        byOwner.set(Number(row.characterId), list);
    }
    for (const [id, items] of byOwner) publish(id, items);
    initialized = true;
    void drain();
}
function inventory(state) {
    const row = source(Number(state?.characterId));
    const Data = invoke('GameServer/DataCache'), Index = ItemTemplateIndex ||= require('../../Item/ItemTemplateIndex');
    const result = {};
    for (const [id, amount, enchant] of row?.[2] || []) {
        const item = Index.find(Data.items, id);
        if (!item) continue;
        const old = result[id];
        result[id] = { selfId: id, amount: amount + Number(old?.amount || 0), name: item.template.name,
            kind: item.template.kind, rank: item.etc?.rank, stackable: item.etc?.stackable,
            equipped: false, equippedCount: 0, slot: 0, enchant: Math.max(enchant, Number(old?.enchant || 0)),
            ...(item.etc?.stackable !== true ? { instances: [...(old?.instances || []),
                { id: 0, amount, enchant, equipped: false }] } : {}) };
    }
    return result;
}
if (isMainThread) require('../Population/ColdTableChannel').shared.register('personal_warehouse', {
    key: row => row[0], allRows: () => records.values(), eventDriven: true
});
module.exports = { init, inventory, LIMIT,
    saleState(state) {
        const stored = inventory(state), bag = { ...state.inventory };
        for (const [id, item] of Object.entries(stored)) {
            const held = bag[id];
            bag[id] = { ...item, ...held, amount: Number(held?.amount || 0) + item.amount,
                ...(item.instances ? { instances: [...(held?.instances || (held ? [{ id: 0, amount: held.amount,
                    enchant: held.enchant || 0, equipped: held.equipped }] : [])), ...item.instances] } : {}) };
        }
        return { ...state, inventory: bag };
    },
    version(state) { return Number(source(Number(state?.characterId))?.[1] || 0); },
    changed(id) { if (isMainThread) { pending.add(Number(id)); if (initialized) setImmediate(drain); } },
    useRowSource(reader) { source = reader || (id => records.get(id)); } };
