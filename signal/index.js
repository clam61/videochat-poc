import dotenv from "dotenv";
import { WebSocketServer } from "ws";
dotenv.config();

const port = process.env.PORT || 10000;
console.log({ port });

const wss = new WebSocketServer({ port });
const peers = new Map();

wss.on("connection", (ws) => {
  console.log("On connection");
  ws.on("message", (messageString) => {
    const msg = messageString.toString("utf8");
    // console.log("Received message as string", msg);

    try {
      const data = JSON.parse(msg);
      const { type, from, to, lang } = data;

      switch (type) {
        // when receiving a join message, add the user to the peers map
        // case "join":
        //   peers.set(from, ws);
        //   console.log(`Peer joined: ${from}`);
        //   for (const key of peers.keys()) {
        //     console.log("\t", key);
        //   }
        //   break;

        case "join":
          peers.set(from, ws);
          // console.log(`Peer joined: ${from}`);
          // If there is already another client, we create a pair.
          const otherPeers = Array.from(peers.keys()).filter((id) => id !== from);
          if (otherPeers.length > 0) {
            const pairMessage = JSON.stringify({
              type: "pair",
              a: from,
              b: otherPeers[0], // take the first other customer
            });

            // Sending message to translation server
            const translationServer = peers.get("translation-server");
            if (translationServer) translationServer.send(pairMessage);
          }
          break;

        // when receiving these messages, find the target
        case "lang":
        case "offer":
        case "answer":
          if (!to) return;
          const target = peers.get(to);
          if (target) target.send(JSON.stringify(data));
          break;

        case "ice-candidate":
          if (!to) return;
          const targetCandidate = peers.get(to);
          if (targetCandidate) targetCandidate.send(JSON.stringify(data));
          break;

        case "translation-text":
          if (!to) return;
          const targetTranslation = peers.get(to);

          if (targetTranslation) {
            targetTranslation.send(JSON.stringify(data));
            console.log(`[signal] Sent translation text to ${to}:`, data.text);
          }

          break;

        default:
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
