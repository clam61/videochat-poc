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

    try {
      const data = JSON.parse(msg);
      const { type, from, to, lang } = data;
      console.log("Received message as string", { type, from, to });

      switch (type) {
        // when receiving a join message, add the user to the peers map
        case "join":
          peers.set(from, ws);
          console.log(`Peer joined: ${from}`);
          for (const key of peers.keys()) {
            console.log("\t", key);
          }
          break;
        // when receiving these messages, find the target
        case "lang":
        case "offer":
        case "answer":
          if (!to) return;
          const target = peers.get(to);
          if (target) target.send(JSON.stringify(data));

          // if an answer and we are joining two clients
          // that are not the translation server
          if (
            type === "answer" &&
            from !== "translation-server" &&
            to !== "translation-server"
          ) {
            console.log("MATCH MAKING");
            const ts = peers.get("translation-server");
            if (!ts) return;
            ts.send(JSON.stringify({ to, from, type: "pairing" }));
          }
          // if (
          //   (type === "answer" || type === "offer") &&
          //   from !== "translation-server"
          // ) {
          //   const ts = peers.get("translation-server");
          //   if (!ts) return;
          //   ts.send(JSON.stringify(data));
          // }
          break;

        case "ice-candidate":
          if (!to) return;
          const targetCandidate = peers.get(to);
          if (targetCandidate) targetCandidate.send(JSON.stringify(data));
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
