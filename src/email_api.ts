import { BadAddressError } from "./errors";
import { add_angle_brackets, is_email_alias } from "./helpers";
import type { EmailData } from "./types";

const API_URL = new URL("https://api.contiguity.com/");
const EMAIL_ENDPOINT = new URL("/send/email", API_URL);

/**
 * Send an email.
 * Performs validation of the from & to addresses to ensure we only
 * send from alias addresses to real addresses.
 * @throws BadAddressError if `from` is not an alias address.
 * @throws BadAddressError if `to` is an alias address.
 */
export const send_email = (
    env: Env,
    data: {
        to: string;
        from: string;
        from_name?: string;
        reply_to?: string;
        subject: string;
        body: string;
        headers?: Record<string, string>;
    },
): Promise<Response> => {
    if (!is_email_alias(data.from, env.EMAIL_DOMAIN)) {
        throw new BadAddressError("`from` address must be an alias address.");
    }
    if (is_email_alias(data.to, env.EMAIL_DOMAIN)) {
        throw new BadAddressError("`to` address must be a real address.");
    }
    return fetch(EMAIL_ENDPOINT, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${env.CONTIGUITY_TOKEN}`,
        },
        body: JSON.stringify({
            to: add_angle_brackets(data.to),
            from: data.from_name ? `${data.from_name} ${add_angle_brackets(data.from)}` : data.from,
            subject: data.subject,
            reply_to: data.reply_to || data.from,
            body: {
                text: data.body,
                // TODO: html?
            },
            headers: data.headers || {},
        }),
    });
};

/**
 * Reply directly to an email received from a user.
 */
export const send_reply = (
    env: Env,
    parent: EmailData,
    data: {
        from: string;
        from_name?: string;
        reply_to?: string;
        subject: string;
        body: string;
        headers?: Record<string, string>;
    },
): Promise<Response> => {
    // Add headers for email clients to thread the reply correctly.
    const reference_headers: Record<string, string> = {};
    const references = parent.references;
    if (parent.message_id) {
        references.push(parent.message_id);
        reference_headers["In-Reply-To"] = parent.message_id;
    }
    if (references.length > 0) {
        reference_headers["References"] = references.join(" ");
    }

    return send_email(env, {
        to: parent.reply_to || parent.from.address,
        ...data,
        headers: {
            ...reference_headers,
            ...data.headers,
        },
    });
};
