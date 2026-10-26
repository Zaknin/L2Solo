function recommend(session, buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length !== 5) {
        session.dataSendToMe(invoke('GameServer/Network/Response').actionFailed());
        return;
    }
    return invoke('GameServer/Recommendations/Runtime').recommend(session, buffer.readInt32LE(1));
}
module.exports = recommend;
