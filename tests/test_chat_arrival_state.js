const assert = require('assert');

require('../src/Global');

const ChatArrivalState = invoke('GameServer/Bot/AI/ChatArrivalState');

function actor(id, x = 0) {
    return {
        fetchId: () => id,
        fetchLocX: () => x,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchIsOnline: () => true,
        isDead: () => false,
        state: { inMotion: () => false },
        unselect() {}
    };
}

try {
    const target = { actor: actor(9501, 0) };
    const session = { actor: actor(9502, 100), aiActive: true };
    ChatArrivalState.start(session, target, {
        reason: 'player_chat_follow',
        persistent: true,
        stopOnArrival: true
    });
    assert.strictEqual(session.chatArrivalPersistent, true);
    assert.strictEqual(session.chatArrivalUntil, 0);
    assert.strictEqual(ChatArrivalState.tick(session, session.actor), false, 'arrival should clear after reaching the player');
    assert.strictEqual(session.chatArrivalActive, false);

    // E277: the follow ends when the target connection selects another
    // character or returns to character selection (actor retired, kept on the session).
    const World = invoke('GameServer/World/World');
    const registered = World.registeredActorById;
    try {
        const follow = (target) => {
            const bot = { actor: actor(9602, 5000), aiActive: true };
            assert.strictEqual(ChatArrivalState.start(bot, target, { persistent: true }), true);
            return bot;
        };
        const switched = { actor: actor(9601, 0) };
        const switchedBot = follow(switched);
        assert.strictEqual(ChatArrivalState.tick(switchedBot, switchedBot.actor), true, 'control: a far target is followed');
        switched.actor = actor(9603, 0);
        assert.strictEqual(ChatArrivalState.tick(switchedBot, switchedBot.actor), false, 'another selected character ends the follow');
        assert.strictEqual(switchedBot.chatArrivalActive, false);

        const restarted = { actor: actor(9604, 0) };
        let retired = false;
        World.registeredActorById = id => Number(id) === 9604 ? { actor: restarted.actor, retired } : null;
        const restartedBot = follow(restarted);
        assert.strictEqual(ChatArrivalState.tick(restartedBot, restartedBot.actor), true, 'control: a registered target is followed');
        retired = true;
        assert.strictEqual(ChatArrivalState.tick(restartedBot, restartedBot.actor), false, 'a target retired to character selection ends the follow');
        assert.strictEqual(restartedBot.chatArrivalActive, false);
    } finally {
        World.registeredActorById = registered;
    }
    console.log('Chat arrival state checks passed');
} catch (error) {
    console.error(error);
    process.exitCode = 1;
}
