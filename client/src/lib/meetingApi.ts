import { Meeting, Language } from "../types/meeting";

// In-memory store for stub meetings
// In a real implementation, this would be replaced with database calls
const meetings = new Map<string, Meeting>();

// Pre-populate with a test meeting
meetings.set("test-meeting", {
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
});

/**
 * Get a meeting by ID
 * Future: Replace with API call to backend
 */
export async function getMeeting(id: string): Promise<Meeting | null> {
  return meetings.get(id) || null;
}

/**
 * Create a new meeting
 * Future: Replace with API call to backend
 */
export async function createMeeting(
  ownerLanguage: Language,
  attendeeLanguage: Language
): Promise<Meeting> {
  const id = generateMeetingId();

  const meeting: Meeting = {
    id,
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

  meetings.set(id, meeting);
  return meeting;
}

/**
 * Generate a random meeting ID (6 characters)
 */
function generateMeetingId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * List all meetings (for debugging)
 */
export function listMeetings(): Meeting[] {
  return Array.from(meetings.values());
}
