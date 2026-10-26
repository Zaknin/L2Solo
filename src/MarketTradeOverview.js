'use strict';

// Older runtimes journaled AFK settlement through telemetry, and migration 32
// copied both sides of a matched AFK trade. The seller event is the canonical
// fill; the adjacent buyer event is only a second notification of that fill.
const CANONICAL_FILTER = `NOT (market_trades.eventKey GLOB 'market:*'
    AND market_trades.sourceType GLOB 'afk_*')
    AND NOT (market_trades.eventKey GLOB 'afk:*' AND market_trades.channel = 'wtb'
        AND EXISTS (
            SELECT 1 FROM market_trades paired
            WHERE paired.eventKey = 'afk:' || (CAST(SUBSTR(market_trades.eventKey, 5) AS INTEGER) - 1)
                AND paired.occurredAt = market_trades.occurredAt
                AND paired.selfId = market_trades.selfId
                AND paired.quantity = market_trades.quantity
                AND paired.unitPrice = market_trades.unitPrice
                AND paired.sellerCharacterId = market_trades.sellerCharacterId
                AND paired.buyerCharacterId = market_trades.buyerCharacterId
        ))`;

function tradeRow(row = {}) {
    return {
        id: Number(row.id || 0),
        eventKey: String(row.eventKey || ''),
        at: Number(row.occurredAt || 0),
        channel: String(row.channel || ''),
        sourceType: String(row.sourceType || ''),
        selfId: Number(row.selfId || 0),
        itemName: String(row.itemName || ''),
        quantity: Number(row.quantity || 0),
        unitPrice: Number(row.unitPrice || 0),
        adena: Number(row.totalPrice || 0),
        town: row.town || null,
        seller: {
            characterId: Number(row.sellerCharacterId || 0) || null,
            name: row.sellerName || null
        },
        buyer: {
            characterId: Number(row.buyerCharacterId || 0) || null,
            name: row.buyerName || null
        }
    };
}

function aggregate(all, since) {
    const row = all(`SELECT COUNT(*) AS trades,
        COALESCE(SUM(quantity), 0) AS units,
        COALESCE(SUM(totalPrice), 0) AS adena,
        COUNT(DISTINCT selfId) AS items,
        MIN(occurredAt) AS firstAt,
        MAX(occurredAt) AS lastAt
        FROM market_trades WHERE occurredAt >= ? AND ${CANONICAL_FILTER}`, [since])[0] || {};
    return {
        trades: Number(row.trades || 0),
        units: Number(row.units || 0),
        adena: Number(row.adena || 0),
        items: Number(row.items || 0),
        firstAt: Number(row.firstAt || 0) || null,
        lastAt: Number(row.lastAt || 0) || null
    };
}

// The newest trade id: it moves when a trade is added, so it says whether windows
// can have changed. A deleted character's trades leave at any age (HistoryStore)
// without moving it; with the id unchanged the reused windows can over-count for
// at most WINDOWS_MAX_MS (MarketTradeOverviewWorker.js).
function tailId(all) {
    return Number(all('SELECT MAX(id) AS id FROM market_trades')[0]?.id || 0);
}

function fetchRecent(all, { recentLimit = 200 } = {}) {
    const limit = Math.max(1, Math.min(500, Math.floor(Number(recentLimit) || 200)));
    return all(`SELECT * FROM market_trades
        WHERE ${CANONICAL_FILTER}
        ORDER BY occurredAt DESC, id DESC LIMIT ${limit}`).map(tradeRow);
}

// The day and week aggregates: a scan of the week's trades.
function fetchWindows(all, { timestamp = Date.now() } = {}) {
    const current = Math.max(1, Number(timestamp) || Date.now());
    const dayAgo = current - 24 * 60 * 60 * 1000;
    const weekAgo = current - 7 * 24 * 60 * 60 * 1000;
    const byItem = all(`SELECT selfId, MAX(itemName) AS name, COUNT(*) AS trades,
        COALESCE(SUM(quantity), 0) AS items, COALESCE(SUM(totalPrice), 0) AS adena,
        MAX(occurredAt) AS lastTradeAt
        FROM market_trades INDEXED BY market_trades_recent WHERE occurredAt >= ? AND ${CANONICAL_FILTER}
        GROUP BY selfId ORDER BY adena DESC, items DESC, selfId ASC`, [weekAgo])
        .map((row) => ({
            selfId: Number(row.selfId),
            name: row.name || `Item ${row.selfId}`,
            trades: Number(row.trades || 0),
            items: Number(row.items || 0),
            adena: Number(row.adena || 0),
            lastTradeAt: Number(row.lastTradeAt || 0) || null
        }));
    const byTown = Object.fromEntries(all(`SELECT COALESCE(town, 'Unknown') AS town,
        COUNT(*) AS trades, COALESCE(SUM(quantity), 0) AS items,
        COALESCE(SUM(totalPrice), 0) AS adena
        FROM market_trades WHERE occurredAt >= ? AND ${CANONICAL_FILTER}
        GROUP BY COALESCE(town, 'Unknown') ORDER BY adena DESC`, [weekAgo]).map((row) => [row.town, {
        trades: Number(row.trades || 0),
        items: Number(row.items || 0),
        adena: Number(row.adena || 0)
    }]));
    return {
        windows: {
            day: aggregate(all, dayAgo),
            week: aggregate(all, weekAgo)
        },
        byItem,
        byTown
    };
}

function fetch(all, options = {}) {
    const { windows, byItem, byTown } = fetchWindows(all, options);
    return { scope: 'persistent_90d', retentionDays: 90, windows, recent: fetchRecent(all, options), byItem, byTown };
}

module.exports = { fetch, fetchRecent, fetchWindows, tailId, CANONICAL_FILTER };
