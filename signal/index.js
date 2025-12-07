import dotenv from "dotenv";
import { WebSocketServer } from "ws";
dotenv.config();

const port = process.env.PORT || 10000;
console.log({ port });

const wss = new WebSocketServer({ port });
const webSockets = new Map(); // peerId -> WebSocket
const meetings = new Map(); // meetingId -> { owner: peerId, attendee: peerId }
const peerMeetings = new Map(); // peerId -> { meetingId, role }

wss.on("connection", (ws) => {
  console.log("On connection");
  ws.on("message", (messageString) => {
    const msg = messageString.toString("utf8");

    try {
      const data = JSON.parse(msg);
      const { type, from, to, lang, meetingId, role } = data;
      console.log("Received message as string", { type, from, to, meetingId, role });

      switch (type) {
        // when receiving a join message, add the user to the peers map
        case "join":
          webSockets.set(from, ws);

          // If joining with a meeting context, track the meeting
          if (meetingId && role) {
            peerMeetings.set(from, { meetingId, role });

            // Get or create meeting entry
            if (!meetings.has(meetingId)) {
              meetings.set(meetingId, { owner: null, attendee: null });
            }

            const meeting = meetings.get(meetingId);
            meeting[role] = from;

            console.log(`Peer ${from} joined meeting ${meetingId} as ${role}`);

            // Check if both participants are present
            if (meeting.owner && meeting.attendee) {
              console.log(`Meeting ${meetingId} has both participants, notifying...`);

              // Notify owner about attendee
              const ownerWs = webSockets.get(meeting.owner);
              if (ownerWs) {
                ownerWs.send(
                  JSON.stringify({
                    type: "peer-ready",
                    peerId: meeting.attendee,
                    role: "attendee",
                  })
                );
              }

              // Notify attendee about owner
              const attendeeWs = webSockets.get(meeting.attendee);
              if (attendeeWs) {
                attendeeWs.send(
                  JSON.stringify({
                    type: "peer-ready",
                    peerId: meeting.owner,
                    role: "owner",
                  })
                );
              }
            }
          }
          break;
        // when receiving these messages, find the target
        case "lang":
        case "offer":
        case "answer":
          if (!to) return;
          const target = webSockets.get(to);
          if (target) target.send(JSON.stringify(data));

          // if an answer and we are joining two clients
          // that are not the translation server
          if (
            type === "answer" &&
            from !== "translation-server" &&
            to !== "translation-server"
          ) {
            console.log("MATCH MAKING");
            const ts = webSockets.get("translation-server");
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
          if (!to) {
            console.log("ice-candidate without to, not sending");
            return;
          }
          const webSocket = webSockets.get(to);
          if (webSocket) {
            console.log("SENDING MESSAGE CE", JSON.stringify(data));
            webSocket.send(JSON.stringify(data));
          } else
            console.log("Cant find websocket for ice-candidate message", to);
          break;

        default:
          break;
      }
    } catch (e) {
      console.error(e);
    }
  });

  ws.on("close", () => {
    for (const [id, socket] of webSockets.entries()) {
      if (socket === ws) {
        console.log(`Peer ${id} disconnected`);
        webSockets.delete(id);

        // Clean up meeting data
        const peerMeeting = peerMeetings.get(id);
        if (peerMeeting) {
          const { meetingId, role } = peerMeeting;
          const meeting = meetings.get(meetingId);
          if (meeting) {
            meeting[role] = null;
            // If meeting is now empty, remove it
            if (!meeting.owner && !meeting.attendee) {
              meetings.delete(meetingId);
              console.log(`Meeting ${meetingId} removed (empty)`);
            }
          }
          peerMeetings.delete(id);
        }
      }
    }
  });
});
