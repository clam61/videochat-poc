import fs from "fs";
import path from "path";
import { Meeting } from "../types/meeting";

const DB_PATH = path.join(process.cwd(), "data", "meetings.json");

interface Database {
  meetings: Record<string, Meeting>;
}

function ensureDbExists(): void {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(DB_PATH)) {
    const initialData: Database = {
      meetings: {
        "test-meeting": {
          id: "test-meeting",
          owner: {
            odoo_id: "user-001",
            peer_id: "",
            language: "en-US",
            role: "owner",
          },
          attendee: {
            odoo_id: "user-002",
            peer_id: "",
            language: "es-US",
            role: "attendee",
          },
          created_at: new Date().toISOString(),
        },
      },
    };
    fs.writeFileSync(DB_PATH, JSON.stringify(initialData, null, 2));
  }
}

function readDb(): Database {
  ensureDbExists();
  const data = fs.readFileSync(DB_PATH, "utf-8");
  return JSON.parse(data);
}

function writeDb(data: Database): void {
  ensureDbExists();
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

export function getMeeting(id: string): Meeting | null {
  const db = readDb();
  return db.meetings[id] || null;
}

export function createMeeting(meeting: Meeting): Meeting {
  const db = readDb();
  db.meetings[meeting.id] = meeting;
  writeDb(db);
  return meeting;
}

export function listMeetings(): Meeting[] {
  const db = readDb();
  return Object.values(db.meetings);
}

export function deleteMeeting(id: string): boolean {
  const db = readDb();
  if (db.meetings[id]) {
    delete db.meetings[id];
    writeDb(db);
    return true;
  }
  return false;
}
