const ActorQueries = require('../../World/ActorSpatialQueries');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Pressure = require('./PopulationPressure');
const TableChannel = require('./ColdTableChannel').shared;

function median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2) return sorted[mid];
    return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function percentileFromHistogram(rows, percentile) {
    const total = rows.reduce((sum, row) => sum + row.count, 0);
    if (total <= 0) return null;

    const target = Math.max(1, Math.ceil(total * percentile));
    let seen = 0;
    for (const row of rows) {
        seen += row.count;
        if (seen >= target) return row.level;
    }
    return rows[rows.length - 1]?.level || null;
}

function summarizeHistogram(histogram, targetLevel) {
    const byLevel = new Map();
    histogram.levels.forEach((row) => {
        byLevel.set(row.level, (byLevel.get(row.level) || 0) + row.count);
    });

    const rows = [...byLevel.entries()]
        .map(([level, count]) => ({ level, count }))
        .sort((a, b) => a.level - b.level);

    const total = rows.reduce((sum, row) => sum + row.count, 0);
    const radius = Config.directorTargetBandRadius;
    let below = 0;
    let inBand = 0;
    let above = 0;
    let newbies = 0;

    rows.forEach((row) => {
        if (row.level <= 5) newbies += row.count;
        if (!targetLevel) return;
        if (row.level < targetLevel - radius) below += row.count;
        else if (row.level > targetLevel + radius) above += row.count;
        else inBand += row.count;
    });

    return {
        total,
        min: rows[0]?.level || null,
        max: rows[rows.length - 1]?.level || null,
        median: percentileFromHistogram(rows, 0.5),
        p90: percentileFromHistogram(rows, 0.9),
        below,
        inBand,
        above,
        newbies,
        inBandRatio: total > 0 ? inBand / total : 0,
        newbieRatio: total > 0 ? newbies / total : 0
    };
}

function realPlayerLevels() {
    const World = invoke('GameServer/World/World');
    return ActorQueries.humans(World)
        .filter((session) => (
            session.actor &&
            session.actor.fetchIsOnline() &&
            session.accountId &&
            !String(session.accountId).startsWith('bot_')
        ))
        .map((session) => Number(session.actor.fetchLevel() || 1))
        .filter((level) => Number.isFinite(level) && level > 0);
}

// The 'pressure' table (ColdTableChannel, one row, key 'world'): the two
// snapshot values the pressure formula reads (PopulationPressure), published
// when either changes. The worker's party and solo steps read it.
function pressureRow(snapshot) {
    return { key: 'world', targetLevel: snapshot?.targetLevel ?? null, reason: snapshot?.reason || null };
}

TableChannel.register('pressure', {
    key: row => row.key,
    allRows: () => [pressureRow(PopulationDirector.lastSnapshot)]
});

const PopulationDirector = {
    timer: null,
    lastSnapshot: {
        updatedAt: 0,
        targetLevel: null,
        reason: 'not_started',
        player: { count: 0, highest: null, median: null },
        bots: { total: 0, median: null, inBandRatio: 0, newbieRatio: 0 }
    },

    init() {
        this.refresh();
    },

    start() {
        if (this.timer || Config.directorEnabled === false) return;

        this.refresh();
        this.timer = setInterval(() => {
            this.refresh();
        }, Config.directorIntervalMs);

        if (typeof this.timer.unref === 'function') {
            this.timer.unref();
        }
    },

    stop() {
        if (!this.timer) return;
        clearInterval(this.timer);
        this.timer = null;
    },

    // The one writer of lastSnapshot: a new target level or reason reaches
    // the worker's 'pressure' row.
    setSnapshot(next) {
        const before = pressureRow(this.lastSnapshot), after = pressureRow(next);
        this.lastSnapshot = next;
        if (before.targetLevel !== after.targetLevel || before.reason !== after.reason) TableChannel.changed('pressure', after);
        return next;
    },

    refresh() {
        if (Config.directorEnabled === false) {
            this.setSnapshot({
                ...this.lastSnapshot,
                updatedAt: Date.now(),
                targetLevel: null,
                reason: 'disabled'
            });
            return Promise.resolve(this.lastSnapshot);
        }

        const playerLevels = realPlayerLevels();
        const playerMedian = median(playerLevels);
        const targetLevel = playerMedian || null;

        return LifeState.levelHistogram().then((histogram) => {
            const bots = summarizeHistogram(histogram, targetLevel);
            this.setSnapshot({
                updatedAt: Date.now(),
                targetLevel,
                reason: targetLevel ? 'active_players' : 'no_active_players',
                player: {
                    count: playerLevels.length,
                    highest: playerLevels.length ? Math.max(...playerLevels) : null,
                    median: playerMedian
                },
                bots,
                phases: histogram.phases
            });
            return this.lastSnapshot;
        });
    },

    pressureForState(state) {
        return Pressure.pressureFor(state, this.lastSnapshot);
    },

    snapshot() {
        return this.lastSnapshot;
    },

    statusLine() {
        const snapshot = this.lastSnapshot;
        if (!snapshot || !snapshot.targetLevel) {
            return `director=${snapshot?.reason || 'idle'}`;
        }

        const inBand = Math.round((snapshot.bots?.inBandRatio || 0) * 100);
        const newbies = Math.round((snapshot.bots?.newbieRatio || 0) * 100);
        const floor = Math.round(Config.newbieAnchorFloorRatio * 100);
        return `director=target:${snapshot.targetLevel} botsMedian:${snapshot.bots?.median || '-'} inBand:${inBand}% newbie:${newbies}%/${floor}%`;
    }
};

module.exports = PopulationDirector;
