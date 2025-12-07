import type { NextApiRequest, NextApiResponse } from "next";
import { createMeeting, listMeetings } from "../../../lib/db";
import { Meeting, Language } from "../../../types/meeting";

function generateMeetingId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    // List all meetings
    const meetings = listMeetings();
    return res.status(200).json(meetings);
  }

  if (req.method === "POST") {
    // Create a new meeting
    const { ownerLanguage, attendeeLanguage } = req.body as {
      ownerLanguage: Language;
      attendeeLanguage: Language;
    };

    if (!ownerLanguage || !attendeeLanguage) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const meeting: Meeting = {
      id: generateMeetingId(),
      owner: {
        odoo_id: "",
        peer_id: "",
        language: ownerLanguage,
        role: "owner",
      },
      attendee: {
        odoo_id: "",
        peer_id: "",
        language: attendeeLanguage,
        role: "attendee",
      },
      created_at: new Date().toISOString(),
    };

    const created = createMeeting(meeting);
    return res.status(201).json(created);
  }

  return res.status(405).json({ error: "Method not allowed" });
}
