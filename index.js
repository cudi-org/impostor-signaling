const WebSocket = require('ws');
const crypto = require('crypto');
const bcrypt = require('bcrypt');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

const syncRooms = new Map();
const connectionsPerIP = new Map();

const MAX_MESSAGE_SIZE = 64 * 1024; 
const HEARTBEAT_INTERVAL = 30000;
const TOKEN_TTL = 30 * 60 * 1000;

function heartbeat() { this.isAlive = true; }

wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    const currentIPCount = (connectionsPerIP.get(ip) || 0) + 1;
    
    if (currentIPCount > 20) return ws.terminate();
    connectionsPerIP.set(ip, currentIPCount);

    ws.isAlive = true;
    ws.id = crypto.randomBytes(4).toString('hex');
    ws.isPending = false;
    ws.msgCount = 0;
    ws.msgTs = Date.now();

    ws.on('pong', heartbeat);

    ws.on('message', async message => {
        const now = Date.now();
        if (now - ws.msgTs > 1000) { ws.msgTs = now; ws.msgCount = 0; }
        if (++ws.msgCount > 50) return;

        const messageString = message.toString();
        if (messageString.length > MAX_MESSAGE_SIZE) return ws.close(1009);

        let data;
        try { data = JSON.parse(messageString); } catch (e) { return; }

        if (data.appType === 'cudi-sync') await handleGameLogic(ws, data, messageString);
    });

    ws.on('close', () => {
        const count = connectionsPerIP.get(ip) - 1;
        if (count <= 0) connectionsPerIP.delete(ip);
        else connectionsPerIP.set(ip, count);
        limpiarRecursos(ws);
    });
});

async function handleGameLogic(ws, data, messageString) {
    switch (data.type) {
        case 'join':
            if (!data.room) return;
            ws.alias = data.alias || 'Jugador';

            // CREAR SALA (HOST)
            if (!syncRooms.has(data.room)) {
                let passwordHash = data.password ? await bcrypt.hash(data.password, 10) : null;
                syncRooms.set(data.room, {
                    clients: new Set(),
                    host: ws,
                    password: passwordHash,
                    token: crypto.randomBytes(8).toString('hex'),
                    createdAt: Date.now()
                });
                ws.room = data.room;
                ws.isHost = true;
                syncRooms.get(data.room).clients.add(ws);
                ws.send(JSON.stringify({ type: 'room_created', room: data.room, peerId: ws.id }));
                return;
            }

            // UNIRSE A SALA (CLIENTE)
            const room = syncRooms.get(data.room);
            if (room.clients.size >= 15) { // Máximo 15 jugadores
                return ws.send(JSON.stringify({ type: 'error', message: 'Sala llena' }));
            }

            if (room.password && !data.token) {
                if (!data.password || !(await bcrypt.compare(data.password, room.password))) {
                    return ws.send(JSON.stringify({ type: 'error', message: 'Contraseña incorrecta' }));
                }
            }

            ws.room = data.room;
            room.clients.add(ws);
            ws.send(JSON.stringify({ type: 'joined', room: ws.room, peerId: ws.id }));
            
            room.host.send(JSON.stringify({ 
                type: 'player_joined', 
                peerId: ws.id, 
                alias: ws.alias 
            }));
            break;

        case 'signal': // EL MOTOR DEL JUEGO: REPARTO DE ROLES
            if (!ws.room || !syncRooms.has(ws.room)) return;
            const rData = syncRooms.get(ws.room);

            if (data.targetId) {
                // Mensaje PRIVADO (Para enviar la palabra secreta a cada uno)
                const target = [...rData.clients].find(c => c.id === data.targetId);
                if (target) target.send(messageString);
            } else {
                rData.clients.forEach(client => {
                    if (client !== ws) client.send(messageString);
                });
            }
            break;
    }
}

function limpiarRecursos(ws) {
    if (ws.room && syncRooms.has(ws.room)) {
        const room = syncRooms.get(ws.room);
        if (ws.isHost) {
            room.clients.forEach(c => { if (c !== ws) c.send(JSON.stringify({ type: 'room_closed' })); });
            syncRooms.delete(ws.room);
        } else {
            room.clients.delete(ws);
            if (room.host) room.host.send(JSON.stringify({ type: 'player_left', peerId: ws.id }));
        }
    }
}

const interval = setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, HEARTBEAT_INTERVAL);
