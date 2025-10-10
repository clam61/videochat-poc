import dotenv from "dotenv";
import http from "http";
import { WebSocketServer } from "ws";
dotenv.config();

const server = http.createServer();

const PORT = process.env.PORT || 3001;
console.log(process.env.PORT, 'process.env.PORT')

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
    ws.on("message", (msg) => {
        try {
            const data = JSON.parse(msg);
            const { type, from, to } = data;

            switch (type) {
                case "join":
                    peers.set(from, ws);
                    console.log(`Peer joined: ${from}`);
                    break;
                case "offer":
                case "answer":
                case "ice-candidate":
                    if (!to) return;
                    const target = peers.get(to);
                    if (target) target.send(JSON.stringify(data));
                    break;
            }
        } catch { }
    });

    ws.on("close", () => {
        for (const [id, socket] of peers.entries()) {
            if (socket === ws) peers.delete(id);
        }
    });
});

const peers = new Map();

server.listen(PORT, () => {
    console.log(`Signaling server running on ws://localhost:${PORT}`);
});
