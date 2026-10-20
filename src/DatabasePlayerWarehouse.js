const Limits = require('./GameServer/Warehouse/PersonalWarehouseLimits');
const MAX_AMOUNT = 0x7fffffff;

function migrate(connection) {
    // Preserve object IDs and individual equipment/pet rows. The new owner is
    // the account, so deleting even its last character cannot delete its stock.
    connection.exec(`
        INSERT INTO account_warehouse_items (id, accountName, selfId, name, amount, enchant, petData)
        SELECT stock.id, account.username, stock.selfId, stock.name, stock.amount, stock.enchant, stock.petData
        FROM warehouse_items stock JOIN characters owner ON owner.id = stock.characterId
        JOIN accounts account ON account.username = owner.username COLLATE NOCASE
        WHERE stock.amount > 0 AND substr(lower(owner.username), 1, 4) <> 'bot_'
            AND NOT EXISTS (SELECT 1 FROM bot_life_state life WHERE life.characterId = owner.id);
        DELETE FROM warehouse_items WHERE characterId IN (
            SELECT owner.id FROM characters owner WHERE substr(lower(owner.username), 1, 4) <> 'bot_'
                AND NOT EXISTS (SELECT 1 FROM bot_life_state life WHERE life.characterId = owner.id)
        );
    `);
}

function create({ one, all, write, inTransaction, withCharacterFlush }) {
    function owner(characterId, accountId) {
        const row = one(`SELECT account.username FROM characters c
            JOIN accounts account ON account.username = c.username COLLATE NOCASE
            WHERE c.id = ? AND c.username = ? COLLATE NOCASE
                AND substr(lower(c.username), 1, 4) <> 'bot_'
                AND NOT EXISTS (SELECT 1 FROM bot_life_state life WHERE life.characterId = c.id)`, [characterId, accountId]);
        if (!row) throw Error('player warehouse owner changed');
        return row.username;
    }

    function validateLines(lines) {
        const seen = new Set();
        if (!Array.isArray(lines) || lines.length > 100) throw Error('invalid player warehouse transfer');
        for (const item of lines) {
            if (!Number.isSafeInteger(item?.id) || item.id <= 0 || seen.has(item.id)
                || !Number.isSafeInteger(item.amount) || item.amount <= 0 || item.amount > MAX_AMOUNT) {
                throw Error('invalid player warehouse transfer');
            }
            seen.add(item.id);
        }
    }

    function sum(amount, added) {
        const result = Number(amount || 0) + added;
        if (!Number.isSafeInteger(result) || result > MAX_AMOUNT) throw Error('warehouse amount overflow');
        return result;
    }

    return {
        fetchPlayerWarehouseItems(characterId, accountId) {
            return inTransaction(() => all(`SELECT * FROM account_warehouse_items
                WHERE accountName = ? AND amount > 0 ORDER BY id`, [owner(characterId, accountId)]), 'warehouse:player-list');
        },
        transferPlayerWarehouseBatch(characterId, accountId, lines, mode) {
            validateLines(lines);
            if (!['deposit', 'withdraw'].includes(mode)) throw Error('invalid player warehouse mode');
            return withCharacterFlush(characterId, () => inTransaction(() => {
                const account = owner(characterId, accountId);
                const results = [];
                for (const item of lines) {
                    if (mode === 'deposit') {
                        const source = one('SELECT * FROM items WHERE id = ? AND characterId = ?', [item.id, characterId]);
                        if (!source || source.equipped || Number(source.selfId) !== item.selfId
                            || Number(source.amount) < item.amount) throw Error('inventory item changed');
                        const target = item.stackable && !source.petData ? one(`SELECT id, amount FROM account_warehouse_items
                            WHERE accountName = ? AND selfId = ? AND enchant = ? AND petData IS NULL ORDER BY id LIMIT 1`,
                        [account, source.selfId, source.enchant]) : null;
                        const slots = Number(one(`SELECT COUNT(*) AS total FROM account_warehouse_items
                            WHERE accountName = ? AND amount > 0`, [account]).total);
                        if (!target && slots >= Limits.playerCapacity()) throw Error('personal warehouse is full');
                        const warehouseAmount = sum(target?.amount, item.amount);
                        const warehouseId = target ? target.id : write(`INSERT INTO account_warehouse_items
                            (accountName, selfId, name, amount, enchant, petData) VALUES (?, ?, ?, ?, ?, ?)`,
                        [account, source.selfId, source.name, item.amount, source.enchant, source.petData]).insertId;
                        if (target) write('UPDATE account_warehouse_items SET amount = ? WHERE id = ?', [warehouseAmount, warehouseId]);
                        const inventoryAmount = Number(source.amount) - item.amount;
                        if (inventoryAmount) write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [inventoryAmount, source.id, characterId]);
                        else write('DELETE FROM items WHERE id = ? AND characterId = ?', [source.id, characterId]);
                        results.push({ sourceItemId: item.id, warehouseId: Number(warehouseId), warehouseAmount, inventoryAmount });
                    } else {
                        const source = one('SELECT * FROM account_warehouse_items WHERE id = ? AND accountName = ?', [item.id, account]);
                        if (!source || Number(source.selfId) !== item.selfId || Number(source.amount) < item.amount) throw Error('warehouse item changed');
                        const target = item.stackable && !source.petData ? one(`SELECT id, amount FROM items
                            WHERE characterId = ? AND selfId = ? AND enchant = ? AND petData IS NULL ORDER BY id LIMIT 1`,
                        [characterId, source.selfId, source.enchant]) : null;
                        const inventoryAmount = sum(target?.amount, item.amount);
                        const inventoryId = target ? target.id : write(`INSERT INTO items
                            (selfId, name, amount, enchant, petData, equipped, slot, characterId) VALUES (?, ?, ?, ?, ?, 0, 0, ?)`,
                        [source.selfId, source.name, item.amount, source.enchant, source.petData, characterId]).insertId;
                        if (target) write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [inventoryAmount, inventoryId, characterId]);
                        const warehouseAmount = Number(source.amount) - item.amount;
                        if (warehouseAmount) write('UPDATE account_warehouse_items SET amount = ? WHERE id = ?', [warehouseAmount, source.id]);
                        else write('DELETE FROM account_warehouse_items WHERE id = ?', [source.id]);
                        results.push({ sourceItemId: item.id, inventoryId: Number(inventoryId), inventoryAmount, warehouseAmount,
                            selfId: Number(source.selfId), enchant: Number(source.enchant), petData: source.petData });
                    }
                }
                return results;
            }, `warehouse:player-${mode}`));
        }
    };
}

module.exports = { migrate, create };
