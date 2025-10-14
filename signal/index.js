import dotenv from "dotenv";
import { WebSocketServer } from "ws";
dotenv.config();

const port = process.env.PORT || 10000;
console.log({ port });

const wss = new WebSocketServer({ port });

wss.on("connection", (ws) => {
  console.log("On connection");
  ws.on("message", (messageString) => {
    const msg = messageString.toString("utf8");
    console.log("Received message as string", msg);

    try {
      const data = JSON.parse(msg);
      const { type, from, to } = data;

      switch (type) {
        // when receiving a join message, add the user to the peers map
        case "join":
          peers.set(from, ws);
          console.log(`Peer joined: ${from}`);
          for (const key of peers.keys()) {
            console.log(key);
          }
          break;
        // when receiving these messages, find the target
        // if the target exists forward the message
        case "offer":
        case "answer":
        case "ice-candidate":
          if (!to) return;
          const target = peers.get(to);
          console.log("offer|answer|ice-candidate", target);
          if (target) target.send(JSON.stringify(data));
          break;
      }
    } catch (e) {
      console.error(e);
    }
  });

  ws.on("close", () => {
    for (const [id, socket] of peers.entries()) {
      if (socket === ws) peers.delete(id);
    }
  });
});

const peers = new Map();
