'use strict';
const Policy = require('./ClanRaidFailurePolicy');

// Recover attempts that old equipment-goal rotation could forget. Read only
// retained terminal parties in the world file; no history scan or combat replay.
module.exports = function migrate(connection, timestamp) {
    const clans = new Map(connection.prepare('SELECT clanId,stateJson FROM clan_simulation_clans').all()
        .map(row => [Number(row.clanId), { row, state: JSON.parse(row.stateJson), retained: {} }]));
    for (const { state } of clans.values()) state.raidFailures = Policy.memory(state);
    const parties = connection.prepare(`SELECT partyId,statsJson FROM bot_background_parties
        WHERE json_extract(statsJson,'$.raidEncounter.status')='failed'
        ORDER BY json_extract(statsJson,'$.raidEncounter.failedAt'),partyId`).all();
    for (const row of parties) {
        const stats = JSON.parse(row.statsJson), entry = clans.get(Number(stats.objective?.clanId));
        if (!entry || !stats.objective?.clanGoalKey) continue;
        const encounter = stats.raidEncounter, id = Policy.bossTemplateId(encounter);
        if (!(id > 0)) continue;
        (entry.retained[id] ||= []).push({ ...encounter, partyId: row.partyId });
    }
    const save = connection.prepare('UPDATE clan_simulation_clans SET stateJson=?,updatedAt=? WHERE clanId=?');
    for (const { row, state, retained } of clans.values()) {
        for (const [id, attempts] of Object.entries(retained)) {
            const previous = state.raidFailures[id];
            if (previous) {
                // The checkpoint counts attempts whose parties may be purged.
                // Add it to the timeline only once, with its known count floor.
                const checkpoint = attempts.find(attempt => Number(attempt.failedAt) === Number(previous.failedAt)
                    && (!previous.partyId || attempt.partyId === previous.partyId));
                if (checkpoint) checkpoint.minimumCount = previous.consecutiveFailures;
                else attempts.push({ ...previous, minimumCount: previous.consecutiveFailures });
            }
            attempts.sort((left, right) => Number(left.failedAt) - Number(right.failedAt)
                || String(left.partyId || '').localeCompare(String(right.partyId || '')));
            let failure = null;
            for (const encounter of attempts) {
                const countBefore = Math.max(Number(failure?.consecutiveFailures || 0), Number(encounter.minimumCount || 0) - 1);
                failure = { ...Policy.decision({ bossTemplateId: Number(id), consecutiveFailures: countBefore }, encounter),
                    failedAt: encounter.failedAt, partyId: encounter.partyId,
                    failureReason: String(encounter.failureReason || 'party_death') };
            }
            if (!previous || Number(failure.failedAt) > Number(previous.failedAt)
                || Number(failure.failedAt) === Number(previous.failedAt)
                    && failure.consecutiveFailures > previous.consecutiveFailures) state.raidFailures[id] = failure;
        }
        if (JSON.stringify(JSON.parse(row.stateJson).raidFailures || {}) === JSON.stringify(state.raidFailures)) continue;
        state.updatedAt = Math.max(Number(state.updatedAt || 0) + 1, timestamp);
        save.run(JSON.stringify(state), state.updatedAt, row.clanId);
    }
};
