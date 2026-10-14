const ServerResponse = invoke('GameServer/Network/Response');
const Database       = invoke('Database');

module.exports = function(session, parts) {
    const targetName = parts[1];
    const amount = Number(parts[2]);
    const World = invoke('GameServer/World/World');

    if (!targetName || isNaN(amount)) {
        utils.infoWarn('GameServer', 'Invalid give-adena command parameters');
        return;
    }

    const targetSession = World.user.sessions.find(ob => ob.actor && ob.actor.fetchName().toLowerCase() === targetName.toLowerCase());
    // The grant is the character's that was named; its messages are not sent
    // after Restart to another character on either connection.
    const actor = session.actor;
    if (targetSession && targetSession.actor) {
        const target = targetSession.actor;
        const backpack = target.backpack;
        const notify = () => {
            if (targetSession.actor === target) {
                targetSession.dataSendToMe(ServerResponse.userInfo(target));
                targetSession.dataSendToMe(ServerResponse.itemsList(backpack.fetchItems()));
                targetSession.dataSendToMe(ServerResponse.speak(target, { kind: 0, text: `Received ${amount} Adena from Admin.` }));
            }
            if (session !== targetSession && session.actor === actor) {
                session.dataSendToMe(ServerResponse.speak(actor, { kind: 0, text: `Successfully gave ${amount} Adena to ${target.fetchName()}.` }));
            }
        };
        // The writes are returned so that a failure reaches the NPC dialog's
        // log; only a missing stack gets a new one (a failed update of an
        // existing stack must not fall through to a second stack).
        return backpack.stackableExists(57).then((item) => {
            const total = item.fetchAmount() + amount;
            return Database.updateItemAmount(target.fetchId(), item.fetchId(), total).then(() => {
                backpack.updateAmount(item.fetchId(), total);
                notify();
            });
        }, () => {
            return Database.setItem(target.fetchId(), {
                selfId: 57,
                name: "Adena",
                amount: amount,
                equipped: false,
                slot: 0
            }).then((packet) => {
                backpack.insertItem(Number(packet.insertId), 57, { amount: amount });
                notify();
            });
        });
    } else {
        return Database.fetchCharacterName(targetName).then((rows) => {
            if (rows && rows[0]) {
                const charId = rows[0].id;
                const charRealName = rows[0].name;
                const confirmOfflineGrant = () => {
                    if (session.actor === actor) session.dataSendToMe(ServerResponse.speak(actor, { kind: 0, text: `Successfully gave ${amount} Adena to offline character ${charRealName}.` }));
                };
                return Database.fetchItems(charId, 'admin_give_adena').then((items) => {
                    const adenaItem = items.find(ob => ob.selfId === 57);
                    if (adenaItem) {
                        const total = adenaItem.amount + amount;
                        return Database.updateItemAmount(charId, adenaItem.id, total).then(() => {
                            confirmOfflineGrant();
                        });
                    } else {
                        return Database.setItem(charId, {
                            selfId: 57,
                            name: "Adena",
                            amount: amount,
                            equipped: false,
                            slot: 0
                        }).then(() => {
                            confirmOfflineGrant();
                        });
                    }
                });
            } else {
                if (session.actor === actor) session.dataSendToMe(ServerResponse.speak(actor, { kind: 0, text: `Character with name "${targetName}" does not exist.` }));
            }
        });
    }
};
