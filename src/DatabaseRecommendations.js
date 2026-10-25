const Rules = require('./GameServer/Recommendations/Rules');
const MemoryPolicy = require('./GameServer/Social/InteractionMemoryPolicy');

function install(connection) {
    const columns = new Set(connection.prepare('PRAGMA table_info(characters)').all().map(row => row.name));
    for (const [name, fallback] of [['recDay', -1], ['recSpent', 0], ['recRevision', 0]]) {
        if (!columns.has(name)) connection.exec(`ALTER TABLE characters ADD COLUMN ${name} INTEGER NOT NULL DEFAULT ${fallback}`);
    }
    connection.exec(`CREATE TABLE IF NOT EXISTS character_recommendations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        day INTEGER NOT NULL,
        sourceId INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        targetId INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        reason TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        UNIQUE(day, sourceId, targetId)
    );
    CREATE TABLE IF NOT EXISTS recommendation_hunts (
        sourceId INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        targetId INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        lastAt INTEGER NOT NULL, duration INTEGER NOT NULL,
        PRIMARY KEY(sourceId, targetId)
    );
    CREATE INDEX IF NOT EXISTS recommendation_hunts_expiry ON recommendation_hunts(lastAt);`);
}

function create({ one, all, write, enqueue, inTransaction, withCharacterFlushes, now }) {
    function character(id) {
        return one(`SELECT c.id,c.name,c.username,c.clanId,c.evalScore,c.recRemain,c.recDay,c.recSpent,c.recRevision,
            CASE WHEN l.phase='cold' THEN l.level ELSE c.level END AS level
            FROM characters c LEFT JOIN bot_life_state l ON l.characterId=c.id WHERE c.id=?`, [id]);
    }
    function refresh(id, at) {
        const row = character(id);
        if (!row) return null;
        // A clock moving backwards must not reopen an already consumed day.
        const day = Math.max(Rules.day(at), row.recDay), elapsed = row.recDay < 0 ? 0 : day - row.recDay;
        const spent = day !== row.recDay ? 0 : row.recSpent;
        const score = Math.max(0, Math.min(Rules.MAX_SCORE, row.evalScore) - elapsed * Rules.decay(row.level));
        const left = Math.max(0, Rules.allowance(row.level) - spent);
        if (day !== row.recDay || score !== row.evalScore || left !== row.recRemain) {
            write(`UPDATE characters SET evalScore=?,recRemain=?,recDay=?,recSpent=?,recRevision=recRevision+1 WHERE id=?`,
                [score, left, day, spent, id]);
            Object.assign(row, { evalScore: score, recRemain: left, recDay: day, recSpent: spent, recRevision: row.recRevision + 1 });
        }
        return row;
    }
    function give(sourceId, targetId, reason, at) {
        const source = refresh(sourceId, at), target = sourceId === targetId ? source : refresh(targetId, at);
        const rows = [source, target].filter(Boolean);
        const fail = code => ({ ok: false, code, rows });
        if (!source || !target) return fail('invalid_target');
        if (sourceId === targetId) return fail('self');
        if (source.level < 10) return fail('level');
        const day = source.recDay;
        if (one('SELECT 1 FROM character_recommendations WHERE day=? AND sourceId=? AND targetId=?', [day, sourceId, targetId])) return fail('duplicate');
        if (source.recRemain <= 0) return fail('exhausted');
        if (target.evalScore >= Rules.MAX_SCORE) return fail('full');
        const id = write(`INSERT INTO character_recommendations(day,sourceId,targetId,reason,createdAt) VALUES (?,?,?,?,?)`,
            [day, sourceId, targetId, reason, at]).insertId;
        write('UPDATE characters SET recSpent=recSpent+1,recRemain=recRemain-1,recRevision=recRevision+1 WHERE id=?', [sourceId]);
        write('UPDATE characters SET evalScore=evalScore+1,recRevision=recRevision+1 WHERE id=?', [targetId]);
        source.recSpent++; source.recRemain--; source.recRevision++;
        target.evalScore++; target.recRevision++;
        return { ok: true, rows, event: { id, day, sourceId, targetId, reason, createdAt: at } };
    }
    const bot = row => !!row && String(row.username).toLowerCase().startsWith('bot_');
    function leader(source, snapshot, at, reason) {
        if (!source.clanId) return;
        const clan = one('SELECT leaderId FROM clans WHERE id=?', [source.clanId]);
        if (!clan || clan.leaderId === source.id) return;
        const target = character(clan.leaderId);
        if (!target || target.clanId !== source.clanId) return;
        const relation = MemoryPolicy.view(snapshot).relation('character', target.id, at);
        // A hostile personal history overrides clan membership.
        if (relation && (relation.hostility >= 2 || relation.trust < 0)) return;
        give(source.id, target.id, `clan_leader:${reason}`, at);
    }
    function observe(events, snapshots, at) {
        for (const event of events) {
            if (event.kind !== 'character' || !['hunted_together', 'helped_in_combat', 'healed', 'resurrected',
                'resources_received', 'gave_useful_loot', 'trade_completed', 'crafted_for', 'gift', 'chat', 'supported_party'].includes(event.type)) continue;
            const source = character(event.sourceId), target = character(event.targetId);
            if (!bot(source) || !bot(target)) continue;
            const snapshot = snapshots.get(source.id);
            const relation = MemoryPolicy.view(snapshot).relation('character', target.id, at);
            let reason = Rules.closeFriend(relation) ? 'friendship' : null;
            if (event.type === 'hunted_together') {
                const previous = one('SELECT lastAt,duration FROM recommendation_hunts WHERE sourceId=? AND targetId=?', [source.id, target.id]);
                const progress = Rules.hunt(previous, event.at, event.huntMs);
                write(`INSERT INTO recommendation_hunts(sourceId,targetId,lastAt,duration) VALUES (?,?,?,?)
                    ON CONFLICT(sourceId,targetId) DO UPDATE SET lastAt=excluded.lastAt,duration=excluded.duration`,
                [source.id, target.id, progress.lastAt, progress.duration]);
                if (progress.duration >= Rules.HUNT_MS && Rules.friendly(relation)) reason = 'shared_hunt';
            }
            if (!reason || Rules.day(event.at) !== Rules.day(at)) continue;
            give(source.id, target.id, reason, at);
            // Successful cooperation in one's clan gives the leader another
            // opportunity, spending the same personal allowance.
            if (source.clanId && source.clanId === target.clanId) leader(source, snapshot, at, reason);
        }
    }
    function usefulTrade(trade, at) {
        const source = character(Number(trade.buyerCharacterId)), target = character(Number(trade.sellerCharacterId));
        if (!bot(source) || !bot(target) || source.id === target.id) return;
        const life = one('SELECT statsJson FROM bot_life_state WHERE characterId=?', [source.id]);
        if (!life) return;
        const stats = JSON.parse(life.statsJson || '{}'), plan = stats.equipmentPlan;
        const essential = ['active', 'component_ready', 'ready_to_craft'].includes(plan?.status)
            && Number(plan.target?.selfId) === Number(trade.selfId);
        if (!essential && !(Number(trade.recommendationHours) >= 0.5)) return;
        const snapshot = require('./GameServer/Social/InteractionMemoryRows').load({ one, all }, source.id);
        const relation = MemoryPolicy.view(snapshot).relation('character', target.id, at);
        if (relation && (relation.hostility >= 2 || relation.trust < 0)) return;
        give(source.id, target.id, 'needed_trade', at);
        if (source.clanId && source.clanId === target.clanId) leader(source, snapshot, at, 'needed_trade');
    }
    return {
        observe, usefulTrade,
        refreshRecommendations(ids, at = now()) {
            if (!Array.isArray(ids) || ids.length > 128 || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) return Promise.reject(Error('invalid recommendation characters'));
            return withCharacterFlushes(ids, () => inTransaction(() => [...new Set(ids)].map(id => refresh(id, at)).filter(Boolean), 'recommendations:refresh'));
        },
        giveRecommendation(sourceId, targetId, beforeWrite = () => true) {
            if (![sourceId, targetId].every(id => Number.isSafeInteger(id) && id > 0)) return Promise.resolve({ ok: false, code: 'invalid_target', rows: [] });
            return withCharacterFlushes([sourceId, targetId], () => inTransaction(() => beforeWrite()
                ? give(sourceId, targetId, 'player', now()) : { ok: false, code: 'invalid_target', rows: [] }, 'recommendations:give'));
        },
        fetchRecommendationEvents(cursor = 0) {
            return enqueue(() => all('SELECT * FROM character_recommendations WHERE id>? ORDER BY id LIMIT 128', [cursor]), { operation: 'recommendations:events', read: true });
        },
        recommendationHead() {
            return enqueue(() => Number(one('SELECT MAX(id) AS id FROM character_recommendations').id || 0), { operation: 'recommendations:head', read: true });
        },
        pruneRecommendations(at = now()) {
            return inTransaction(() => {
                write('DELETE FROM character_recommendations WHERE day<?', [Rules.day(at) - 7]);
                write('DELETE FROM recommendation_hunts WHERE lastAt<?', [at - Rules.HUNT_GAP_MS]);
            }, 'recommendations:prune');
        }
    };
}
module.exports = { install, create };
