"use client";
import { useState } from "react";
import { createMeeting } from "../../lib/meetingApi";
import { Language, Meeting } from "../../types/meeting";

const LANGUAGES: { value: Language; label: string }[] = [
  { value: "en-US", label: "English (US)" },
  { value: "es-US", label: "Spanish (US)" },
  { value: "pt-BR", label: "Portuguese (Brazil)" },
  { value: "ko-KR", label: "Korean" },
  { value: "ru-RU", label: "Russian" },
  { value: "zh-HK", label: "Chinese (Hong Kong)" },
  { value: "zh-CN", label: "Chinese (Mandarin)" },
];

export default function CreateMeeting() {
  const [ownerLanguage, setOwnerLanguage] = useState<Language>("en-US");
  const [attendeeLanguage, setAttendeeLanguage] = useState<Language>("es-US");
  const [createdMeeting, setCreatedMeeting] = useState<Meeting | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const handleCreate = async () => {
    setIsCreating(true);
    try {
      const meeting = await createMeeting(ownerLanguage, attendeeLanguage);
      setCreatedMeeting(meeting);
    } finally {
      setIsCreating(false);
    }
  };

  const getBaseUrl = () => {
    if (typeof window !== "undefined") {
      return window.location.origin;
    }
    return "http://localhost:3000";
  };

  return (
    <div className="min-h-screen bg-gray-100 py-8 px-4">
      <div className="max-w-md mx-auto">
        <h1 className="text-2xl font-bold mb-6">Create New Meeting</h1>

        <div className="bg-white rounded-lg shadow p-6 mb-6">
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Owner Language
            </label>
            <select
              value={ownerLanguage}
              onChange={(e) => setOwnerLanguage(e.target.value as Language)}
              className="w-full border border-gray-300 rounded-md py-2 px-3 focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={isCreating || !!createdMeeting}
            >
              {LANGUAGES.map((lang) => (
                <option key={lang.value} value={lang.value}>
                  {lang.label}
                </option>
              ))}
            </select>
          </div>

          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Attendee Language
            </label>
            <select
              value={attendeeLanguage}
              onChange={(e) => setAttendeeLanguage(e.target.value as Language)}
              className="w-full border border-gray-300 rounded-md py-2 px-3 focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={isCreating || !!createdMeeting}
            >
              {LANGUAGES.map((lang) => (
                <option key={lang.value} value={lang.value}>
                  {lang.label}
                </option>
              ))}
            </select>
          </div>

          <button
            onClick={handleCreate}
            disabled={isCreating || !!createdMeeting}
            className="w-full bg-blue-600 text-white py-2 px-4 rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-400"
          >
            {isCreating ? "Creating..." : "Create Meeting"}
          </button>
        </div>

        {createdMeeting && (
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-lg font-semibold text-green-600 mb-4">
              Meeting Created!
            </h2>

            <div className="mb-4">
              <p className="text-sm text-gray-600 mb-1">Meeting ID</p>
              <code className="block bg-gray-100 p-2 rounded text-sm">
                {createdMeeting.id}
              </code>
            </div>

            <div className="mb-4">
              <p className="text-sm text-gray-600 mb-1">
                Owner Link ({createdMeeting.owner.language})
              </p>
              <a
                href={`${getBaseUrl()}/meeting/${createdMeeting.id}?role=owner`}
                target="_blank"
                rel="noopener noreferrer"
                className="block bg-blue-50 p-2 rounded text-sm text-blue-600 hover:underline break-all"
              >
                {getBaseUrl()}/meeting/{createdMeeting.id}?role=owner
              </a>
            </div>

            <div className="mb-4">
              <p className="text-sm text-gray-600 mb-1">
                Attendee Link ({createdMeeting.attendee.language})
              </p>
              <a
                href={`${getBaseUrl()}/meeting/${createdMeeting.id}?role=attendee`}
                target="_blank"
                rel="noopener noreferrer"
                className="block bg-blue-50 p-2 rounded text-sm text-blue-600 hover:underline break-all"
              >
                {getBaseUrl()}/meeting/{createdMeeting.id}?role=attendee
              </a>
            </div>

            <button
              onClick={() => setCreatedMeeting(null)}
              className="w-full bg-gray-200 text-gray-700 py-2 px-4 rounded-md hover:bg-gray-300"
            >
              Create Another Meeting
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
