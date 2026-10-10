const Skills = require('../PrivateStoreLimits');

// C4 inventory size and Expand Inventory (1372), matching ExStorageMaxCount.
function capacity(race, skillLevel = 0) {
    return (Number(race) === 4 ? 100 : 80) + Math.max(0, Math.min(8, Number(skillLevel) || 0)) * 6;
}

function forActor(actor) {
    return capacity(actor?.fetchRace?.(), Skills.skillLevel(actor, 1372));
}

module.exports = { capacity, forActor };
