const Config = require('./PopulationConfig');

// The director's pressure on one bot's step: its exp and death multipliers
// from the bot's level against the director's target level. One function
// for both threads: main reads its own snapshot (PopulationDirector), the
// worker the 'pressure' table row ({ targetLevel, reason }).
function pressureFor(state, snapshot) {
    if (state?.stats?.newbieAnchor) {
        const level = Number(state.level || 1);
        return {
            expMultiplier: level >= Config.newbieAnchorMaxLevel ? 0 : Config.newbieAnchorExpMultiplier,
            deathChanceMultiplier: 0.8,
            directorReason: 'newbie_anchor'
        };
    }

    const targetLevel = Number(snapshot?.targetLevel || 0);
    if (!targetLevel) {
        return {
            expMultiplier: 1,
            deathChanceMultiplier: 1,
            directorReason: snapshot?.reason || 'no_target'
        };
    }

    const level = Number(state?.level || 1);
    const radius = Config.directorTargetBandRadius;
    const delta = targetLevel - level;

    if (delta > radius) {
        const catchUp = Math.min(
            Config.directorMaxCatchUpMultiplier,
            1 + (delta - radius) * 0.06
        );
        return {
            expMultiplier: catchUp,
            deathChanceMultiplier: 0.95,
            directorReason: 'catch_up'
        };
    }

    if (delta < -radius) {
        return {
            expMultiplier: Config.directorSlowdownMultiplier,
            deathChanceMultiplier: 1.05,
            directorReason: 'ahead_slowdown'
        };
    }

    return {
        expMultiplier: 1,
        deathChanceMultiplier: 1,
        directorReason: 'in_band'
    };
}

module.exports = { pressureFor };
