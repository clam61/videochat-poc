export type Language = "en-US" | "es-US" | "pt-BR" | "ko-KR" | "ru-RU" | "zh-HK" | "zh-CN";

export type Role = "owner" | "attendee";

export interface Participant {
  odoo_id: string;      // Will be populated from real DB later
  peer_id: string;      // Generated at runtime
  language: Language;
  role: Role;
}

export interface Meeting {
  id: string;           // Meeting ID (URL slug)
  owner: Participant;
  attendee: Participant;
  created_at?: string;
}
