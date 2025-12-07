import type { NextApiRequest, NextApiResponse } from "next";
import { getMeeting, deleteMeeting } from "../../../lib/db";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const { id } = req.query;

  if (typeof id !== "string") {
    return res.status(400).json({ error: "Invalid meeting ID" });
  }

  if (req.method === "GET") {
    const meeting = getMeeting(id);
    if (!meeting) {
      return res.status(404).json({ error: "Meeting not found" });
    }
    return res.status(200).json(meeting);
  }

  if (req.method === "DELETE") {
    const deleted = deleteMeeting(id);
    if (!deleted) {
      return res.status(404).json({ error: "Meeting not found" });
    }
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
