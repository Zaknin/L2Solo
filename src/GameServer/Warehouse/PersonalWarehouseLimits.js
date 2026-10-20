const Skills = require('../PrivateStoreLimits');

function isPlayer(session) {
    return !!session?.accountId && session.botSession !== true
        && session.constructor?.name !== 'BotSession'
        && !String(session.accountId).toLowerCase().startsWith('bot_');
}

function playerCapacity() {
    const configured = Number(global.options?.default?.GameServer?.playerWarehouseSlots ?? 300);
    // A complete C4 withdrawal list must fit in one 16-bit transport frame.
    return Number.isSafeInteger(configured) && configured >= 1 && configured <= 1000 ? configured : 300;
}

function forActor(actor) {
    if (isPlayer(actor?.session)) return playerCapacity();
    return (Number(actor?.fetchRace?.()) === 4 ? 120 : 100)
        + Math.max(0, Math.min(8, Skills.skillLevel(actor, 1371))) * 6;
}

module.exports = { isPlayer, playerCapacity, forActor };
