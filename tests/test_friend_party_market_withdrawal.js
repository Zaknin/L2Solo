const assert = require('assert');

require('../src/Global');

const World = invoke('GameServer/World/World');
const BotManager = invoke('GameServer/Bot/BotManager');
const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
const InteractionMemory = invoke('GameServer/Social/InteractionMemoryRuntime');
const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');
const BotMerchantStoreService = invoke('GameServer/Bot/Economy/BotMerchantStoreService');

function actor(id, name, store = null) {
    let privateStore = store;
    let privateStoreType = store ? Number(store.storeType || 1) : 0;
    return {
        fetchId: () => id,
        fetchName: () => name,
        fetchLevel: () => 25,
        fetchClanId: () => 0,
        fetchLocX: () => 0,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        isDead: () => false,
        fetchPrivateStore: () => privateStore,
        setPrivateStore: (next) => { privateStore = next; },
        fetchPrivateStoreType: () => privateStoreType,
        setPrivateStoreType: (next) => { privateStoreType = next; }
    };
}

async function run() {
    const player = { accountId: 'party_player', actor: actor(80001, 'PartyLeader'), dataSendToMe() {} };
    const store = { storeType: 1, title: 'Apprentice Earring', items: [{ selfId: 114, count: 1, price: 1000 }] };
    const seller = {
        accountId: 'bot_dynamic_seller',
        actor: actor(80002, 'DynamicSeller', store),
        plan: 'merchant',
        coldMarketState: {
            characterId: 80002,
            activity: 'merchant',
            stats: { marketStore: store }
        }
    };
    const hunter = { accountId: 'bot_dynamic_hunter', actor: actor(80003, 'DynamicHunter'), plan: 'hunting' };

    const originals = {
        snapshot: BotSocialMemory.getSnapshot,
        assess: InteractionMemory.assess,
        recordEvent: BotSocialMemory.recordEvent,
        attach: PartyCompanionService.attach,
        withdrawForParty: BotMerchantStoreService.withdrawForParty,
        botTell: BotManager.botTell,
        setTimeout: global.setTimeout
    };

    let sellerWithdrawn = false;
    let attached = null;
    try {
        BotSocialMemory.getSnapshot = () => ({ trust: 8, familiarity: 8, recentlyAbandonedAt: null });
        InteractionMemory.assess = () => ({ ready: true, personal: null });
        BotSocialMemory.recordEvent = () => Promise.resolve(null);
        BotManager.botTell = () => {};
        global.setTimeout = (callback) => { callback(); return 0; };
        BotMerchantStoreService.withdrawForParty = async (session) => {
            assert.strictEqual(session, seller);
            await Promise.resolve();
            sellerWithdrawn = true;
            session.plan = 'hunting';
            session.actor.setPrivateStoreType(0);
            session.actor.setPrivateStore(null);
            session.coldMarketState = null;
            return { ok: true, withdrawn: true };
        };
        PartyCompanionService.attach = (_leader, companion) => {
            if (companion === seller) {
                assert.strictEqual(sellerWithdrawn, true, 'store withdrawal must complete before party attach');
                assert.strictEqual(companion.actor.fetchPrivateStoreType(), 0);
                assert.strictEqual(companion.actor.fetchPrivateStore(), null);
            }
            attached = companion;
            return true;
        };

        const merchantInvite = World.inviteBotCompanion(player, player.actor, seller, 1, 'friend_const', {
            forceFriend: true
        });
        assert(merchantInvite && typeof merchantInvite.then === 'function', 'merchant invite must wait for store withdrawal');
        assert.strictEqual(await merchantInvite, true);
        assert.strictEqual(attached, seller);

        attached = null;
        const hunterInvite = World.inviteBotCompanion(player, player.actor, hunter, 1, 'friend_const', {
            forceFriend: true
        });
        assert.strictEqual(hunterInvite, true, 'ordinary friend invite must preserve the synchronous native party path');
        assert.strictEqual(attached, hunter);

        // The delayed "joined" reply must not fire for a bot dismissed
        // within that second. Attach/detach are simulated by the same state
        // fields the real attach sets and detachState clears.
        PartyCompanionService.attach = (leader, companion) => {
            companion.followPlayerSession = leader;
            companion.partyCompanion = true;
            return true;
        };
        const tells = [];
        BotManager.botTell = (botSession, targetSession, text) => tells.push({ botSession, targetSession, text });
        let pendingReply = null;
        global.setTimeout = (callback) => { pendingReply = callback; return 0; };

        const dismissed = { accountId: 'bot_dismissed', actor: actor(80004, 'DismissedHunter'), plan: 'hunting' };
        assert.strictEqual(World.inviteBotCompanion(player, player.actor, dismissed, 1, 'friend_const', { forceFriend: true }), true);
        assert.strictEqual(typeof pendingReply, 'function', 'join reply should be scheduled');
        dismissed.followPlayerSession = null;
        dismissed.partyCompanion = false;
        pendingReply();
        assert.deepStrictEqual(tells, [], 'a bot dismissed before the reply timer must not say it joined');

        pendingReply = null;
        const staying = { accountId: 'bot_staying', actor: actor(80005, 'StayingHunter'), plan: 'hunting' };
        assert.strictEqual(World.inviteBotCompanion(player, player.actor, staying, 1, 'friend_const', { forceFriend: true }), true);
        pendingReply();
        assert.strictEqual(tells.length, 1, 'a bot still in the party should send its join reply');
        assert.strictEqual(tells[0].botSession, staying);
        assert.strictEqual(tells[0].targetSession, player);
    } finally {
        BotSocialMemory.getSnapshot = originals.snapshot;
        InteractionMemory.assess = originals.assess;
        BotSocialMemory.recordEvent = originals.recordEvent;
        PartyCompanionService.attach = originals.attach;
        BotMerchantStoreService.withdrawForParty = originals.withdrawForParty;
        BotManager.botTell = originals.botTell;
        global.setTimeout = originals.setTimeout;
    }

    console.log('Friend party market withdrawal checks passed');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
