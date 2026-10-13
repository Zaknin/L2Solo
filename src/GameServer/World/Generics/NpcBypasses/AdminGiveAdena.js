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
    if (targetSession && targetSession.actor) {
        const backpack = targetSession.actor.backpack;
        // The writes are returned so that a failure reaches the NPC dialog's
        // log; only a missing stack gets a new one (a failed update of an
        // existing stack must not fall through to a second stack).
        return backpack.stackableExists(57).then((item) => {
            const total = item.fetchAmount() + amount;
            return Database.updateItemAmount(targetSession.actor.fetchId(), item.fetchId(), total).then(() => {
                backpack.updateAmount(item.fetchId(), total);
                targetSession.dataSendToMe(ServerResponse.userInfo(targetSession.actor));
                targetSession.dataSendToMe(ServerResponse.itemsList(backpack.fetchItems()));
                
                targetSession.dataSendToMe(ServerResponse.speak(targetSession.actor, { kind: 0, text: `Received ${amount} Adena from Admin.` }));
                if (session !== targetSession) {
                    session.dataSendToMe(ServerResponse.speak(session.actor, { kind: 0, text: `Successfully gave ${amount} Adena to ${targetSession.actor.fetchName()}.` }));
                }
            });
        }, () => {
            return Database.setItem(targetSession.actor.fetchId(), {
                selfId: 57,
                name: "Adena",
                amount: amount,
                equipped: false,
                slot: 0
            }).then((packet) => {
                backpack.insertItem(Number(packet.insertId), 57, { amount: amount });
                targetSession.dataSendToMe(ServerResponse.userInfo(targetSession.actor));
                targetSession.dataSendToMe(ServerResponse.itemsList(backpack.fetchItems()));
                
                targetSession.dataSendToMe(ServerResponse.speak(targetSession.actor, { kind: 0, text: `Received ${amount} Adena from Admin.` }));
                if (session !== targetSession) {
                    session.dataSendToMe(ServerResponse.speak(session.actor, { kind: 0, text: `Successfully gave ${amount} Adena to ${targetSession.actor.fetchName()}.` }));
                }
            });
        });
    } else {
        return Database.fetchCharacterName(targetName).then((rows) => {
            if (rows && rows[0]) {
                const charId = rows[0].id;
                const charRealName = rows[0].name;
                return Database.fetchItems(charId, 'admin_give_adena').then((items) => {
                    const adenaItem = items.find(ob => ob.selfId === 57);
                    if (adenaItem) {
                        const total = adenaItem.amount + amount;
                        return Database.updateItemAmount(charId, adenaItem.id, total).then(() => {
                            session.dataSendToMe(ServerResponse.speak(session.actor, { kind: 0, text: `Successfully gave ${amount} Adena to offline character ${charRealName}.` }));
                        });
                    } else {
                        return Database.setItem(charId, {
                            selfId: 57,
                            name: "Adena",
                            amount: amount,
                            equipped: false,
                            slot: 0
                        }).then(() => {
                            session.dataSendToMe(ServerResponse.speak(session.actor, { kind: 0, text: `Successfully gave ${amount} Adena to offline character ${charRealName}.` }));
                        });
                    }
                });
            } else {
                session.dataSendToMe(ServerResponse.speak(session.actor, { kind: 0, text: `Character with name "${targetName}" does not exist.` }));
            }
        });
    }
};
