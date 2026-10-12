'use strict';

// Shared game-data relations. The current selected view owns no bot state.
const ItemTemplateIndex = require('../Item/ItemTemplateIndex');
const DataCache = invoke('GameServer/DataCache');
const BotRaidSafety = invoke('GameServer/Bot/AI/BotRaidSafety');

// No spots, no sources. A caller without spots (a default `[]`, a new array
// each call) must not evict the index built for the real spot list: the
// cache holds one list, and the next wish review would rebuild it in full.
const NO_SOURCES = new Map();
let sourceIndexCache = { spots: null, rewards: null, npcs: null, byItemId: NO_SOURCES };
// Static NPC metadata is shared across selections. Replacing either catalog
// releases the previous atlas; it never retains actors, clans or selected spots.
let sourceRewardAtlas = { rewards: null, npcs: null, byNpc: new Map(), byName: new Map() };
function sourceRewardAtlasFor(rewards, npcs) {
    if (sourceRewardAtlas.rewards === rewards && sourceRewardAtlas.npcs === npcs) return sourceRewardAtlas;
    const byNpc = new Map();
    const byName = new Map();
    const append = (index, key, row) => {
        const rows = index.get(key) || [];
        rows.push(row);
        index.set(key, rows);
    };
    rewards.forEach((reward, ordinal) => {
        const npc = ItemTemplateIndex.find(npcs, reward.selfId);
        const row = { reward, ordinal, npcLevel: Number(npc?.template?.level || 0),
            protectedRaid: BotRaidSafety.isProtectedRaidEntity(npc) };
        append(byNpc, Number(reward.selfId), row);
        append(byName, String(reward.template?.name || '').trim().toLowerCase(), row);
    });
    sourceRewardAtlas = { rewards, npcs, byNpc, byName };
    return sourceRewardAtlas;
}
function sourcesByItem(spots = []) {
    if (!spots?.length) return NO_SOURCES;
    const rewards = DataCache.npcRewards || [];
    const npcs = DataCache.npcs;
    if (sourceIndexCache.spots === spots && sourceIndexCache.rewards === rewards && sourceIndexCache.npcs === npcs) {
        return sourceIndexCache.byItemId;
    }

    const atlas = sourceRewardAtlasFor(rewards, npcs);
    const selectedRewards = new Set();
    const spotByNpc = new Map();
    const spotByName = new Map();
    // Counts and raid decorations belong to this current selection.
    // This scratch index dies after construction; records retain two numbers.
    const spotCounts = new Map();
    const appendSpot = (index, key, spot) => {
        if (!key || !spot) return;
        const existing = index.get(key) || new Map();
        if (!existing.has(spot.id)) existing.set(spot.id, spot);
        index.set(key, existing);
    };
    (spots || []).forEach((spot) => {
        let total = 0;
        const byNpc = new Map();
        for (const entry of spot.npcEntries || []) {
            if (entry.selfId) {
                const npcId = Number(entry.selfId);
                if (npcId && !spotByNpc.has(npcId)) {
                    for (const row of atlas.byNpc.get(npcId) || []) selectedRewards.add(row);
                }
                appendSpot(spotByNpc, npcId, spot);
            }
            if (entry.name) {
                const name = String(entry.name).trim().toLowerCase();
                if (name && !spotByName.has(name)) {
                    for (const row of atlas.byName.get(name) || []) selectedRewards.add(row);
                }
                appendSpot(spotByName, name, spot);
            }
            const count = Math.max(1, Number(entry.count || 1));
            const npcId = Number(entry.selfId);
            total += count;
            // Number(NaN) never matched the previous equality-based scan.
            if (!Number.isNaN(npcId)) byNpc.set(npcId, (byNpc.has(npcId) ? byNpc.get(npcId) : 0) + count);
        }
        spotCounts.set(spot, { total, byNpc });
    });

    const byItemId = new Map();
    // Scratch sets replace scans of each growing item's source list. A repeated
    // reward object/spot/kind keeps its first record, as before; all joins die
    // after construction, leaving only the current selected view.
    const recordsByReward = new Map();
    // Union ID/name matches, retaining original reward order for ties and aliases.
    [...selectedRewards].sort((left, right) => left.ordinal - right.ordinal).forEach(({ reward, npcLevel, protectedRaid }) => {
        const spotsForNpc = [...new Map([
            ...(spotByNpc.get(Number(reward.selfId)) || []),
            ...(spotByName.get(String(reward.template?.name || '').trim().toLowerCase()) || [])
        ]).values()];
        if (!spotsForNpc.length) return;
        // Only the explicit raid-source atlas may opt a protected NPC into
        // equipment planning. Mentioning that NPC in an ordinary spot never
        // bypasses the global bot raid guard.
        const eligibleSpots = protectedRaid
            ? spotsForNpc.filter((spot) => spot?.raidBoss === true
                && Number(spot.raidBossTemplateId || 0) === Number(reward.selfId))
            : spotsForNpc.filter((spot) => spot?.raidBoss !== true);
        if (!eligibleSpots.length) return;
        const itemKinds = [
            ['drop', reward.rewards || []],
            ['spoil', reward.spoils || []]
        ].flatMap(([kind, groups]) => groups.flatMap((group) => (
            (group.items || []).map((item) => ({ id: Number(item.selfId || 0), kind })).filter((item) => item.id)
        )));
        eligibleSpots.forEach((spot) => {
            // The same NPC/spot/kind serves many items. Its immutable index
            // record is shared rather than copied into every item's list.
            let recordsBySpot = recordsByReward.get(reward);
            if (!recordsBySpot) {
                recordsBySpot = new Map();
                recordsByReward.set(reward, recordsBySpot);
            }
            let records = recordsBySpot.get(spot.id);
            if (!records) {
                records = new Map();
                recordsBySpot.set(spot.id, records);
            }
            itemKinds.forEach(({ id, kind }) => {
                let entry = records.get(kind);
                if (!entry) {
                    const counts = spotCounts.get(spot);
                    const record = { reward, spot, kind, npcLevel, totalCount: counts.total,
                        sourceCount: counts.byNpc.get(Number(reward.selfId)) ?? 0 };
                    entry = { record, itemIds: new Set() };
                    records.set(kind, entry);
                }
                if (entry.itemIds.has(id)) return;
                entry.itemIds.add(id);
                const entries = byItemId.get(id) || [];
                entries.push(entry.record);
                byItemId.set(id, entries);
            });
        });
    });

    sourceIndexCache = { spots, rewards, npcs, byItemId };
    return byItemId;
}

module.exports = { sourcesByItem };
