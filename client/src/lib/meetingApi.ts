import { Meeting, Language } from "../types/meeting";

/**
 * Get a meeting by ID
 * Calls the API which reads from the JSON file database
 */
export async function getMeeting(id: string): Promise<Meeting | null> {
  try {
    const response = await fetch(`/api/meetings/${id}`);
    if (!response.ok) {
      if (response.status === 404) return null;
      throw new Error("Failed to fetch meeting");
    }
    return response.json();
  } catch (error) {
    console.error("Error fetching meeting:", error);
    return null;
  }
}

/**
 * Create a new meeting
 * Calls the API which writes to the JSON file database
 */
export async function createMeeting(
  ownerLanguage: Language,
  attendeeLanguage: Language
): Promise<Meeting> {
  const response = await fetch("/api/meetings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ownerLanguage, attendeeLanguage }),
  });

  if (!response.ok) {
    throw new Error("Failed to create meeting");
  }

  return response.json();
}

/**
 * List all meetings
 */
export async function listMeetings(): Promise<Meeting[]> {
  const response = await fetch("/api/meetings");
  if (!response.ok) {
    throw new Error("Failed to list meetings");
  }
  return response.json();
}
