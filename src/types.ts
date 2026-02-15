export type EventType =
    | "text.incoming.sms"
    | "text.incoming.mms"
    | "text.delivery.confirmed"
    | "text.delivery.failed"
    | "imessage.incoming"
    | "numbers.substitution"
    | "email.incoming";

export interface Attachment {
    id: string;
    filename: string;
    content_type: string;
    size: number;
    url: string;
}

export interface Event<T = object> {
    id: string;
    type: EventType;
    timestamp: number; // Unix timestamp for now, will change to ISO 8601 format in future.
    api_version: string;
    data: T;
}

export interface EmailData {
    email_id: string;

    from: {
        name: string | null;
        address: string;
        complete: string;
    };
    to: {
        name: string | null;
        address: string;
        complete: string;
    };

    cc: string[];
    bcc: string[];
    reply_to: string | null;

    subject: string;
    body: {
        text: string;
        html: string;
        raw: string;
    };

    timestamp: number; // Unix timestamp for now, will change to ISO 8601 format in future.
    message_id: string | null;
    in_reply_to: string | null;
    references: string[];
    headers: Record<string, string>;
    attachments: Attachment[];
}

export interface EmailEvent extends Event<EmailData> {
    type: "email.incoming";
    data: EmailData;
}

export interface AliasRow {
    alias_address: string;
    real_address: string;
    token: string;
    verified: boolean;
    allow_reply: boolean;
    expires: number | null;
}

export interface ReverseAliasRow {
    reverse_alias: string;
    /**
     * The alias address that can reply to this reverse alias.
     */
    owner_alias_address: string;
    /**
     * The real address that this reverse alias maps to.
     */
    recipient_real_address: string;
}

export interface MessageIdsRow {
    real_id: string;
    alias_id: string;
}

export interface DeleteAliasRequest {
    /**
     * The real address associated with an alias address to delete.
     */
    address: string;
    token: string;
}
