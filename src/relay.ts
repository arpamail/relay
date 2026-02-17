import { AliasManager } from "./aliases";
import { NotificationManager } from "./notifications";
import { send_email } from "./email_api";
import { hex_to_bytes, is_email_alias, is_email_reverse_alias } from "./helpers";
import type { Event, EmailEvent, EmailData, AliasRow, MessageIdsRow } from "./types";

/**
 * 10 MB maximum email body size.
 */
const MAX_BODY_SIZE = 10 * 1024 * 1024;

/**
 * Create a new alias message ID for the given email, and insert it into the database.
 */
const new_message_id = async (env: Env, data: EmailData, sender_alias_address: string): Promise<string | null> => {
    try {
        if (!data.message_id) {
            throw new Error("Incoming email missing Message-ID header.");
        }

        // Hash the email and convert the hash into a base64 string.
        const hash_buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data.body.raw));
        const base64 = btoa(Array.from(new Uint8Array(hash_buffer), (byte) => String.fromCodePoint(byte)).join(""));
        const aliased_id = `<${base64}@${env.EMAIL_DOMAIN}>`;

        await env.DB.prepare("INSERT INTO message_ids (real_id, aliased_id, sender_alias_address) VALUES (?, ?, ?)")
            .bind(data.message_id, aliased_id, sender_alias_address)
            .run();
        return aliased_id;
    } catch (error) {
        const message = error instanceof Error ? error.message : `${error}`;
        console.warn({ message: "Failed to create new aliased message ID", error: message });
        return null;
    }
};

/**
 * Translate the `References` and `In-Reply-To` headers from aliased IDs to their real IDs.
 */
const unalias_threading_headers = async (env: Env, data: EmailData): Promise<Record<string, string>> => {
    const aliased_in_reply_to = data.in_reply_to;
    const aliased_references = data.references;
    const translated_headers: Record<string, string> = {};
    const sql_stmt = env.DB.prepare("SELECT real_id FROM message_ids WHERE aliased_id = ?1 LIMIT 1");

    if (aliased_in_reply_to) {
        const real_in_reply_to = await sql_stmt.bind(aliased_in_reply_to).first<string>("real_id");
        if (real_in_reply_to) {
            translated_headers["In-Reply-To"] = real_in_reply_to;
        }
    }

    if (aliased_references.length > 0) {
        const queries = aliased_references.map((aliased_id) => sql_stmt.bind(aliased_id));
        const batch_result = await env.DB.batch<MessageIdsRow>(queries);
        const real_references = batch_result
            .map((result) => {
                if (result.results.length > 0) {
                    return result.results[0].real_id;
                }
                console.warn({ message: "Failed to unalias reference ID", result });
                return null;
            })
            .filter((message_id) => message_id !== null);
        if (real_references.length > 0) {
            translated_headers["References"] = real_references.join(" ");
        }
    }

    return translated_headers;
};

/**
 * Get full sender and recipient address information, handling reverse aliases if necessary.
 */
const resolve_addresses = async ({
    env,
    alias_manager,
    alias_to_address,
    real_from_address,
}: {
    env: Env;
    alias_manager: AliasManager;
    alias_to_address: string;
    real_from_address: string;
}): Promise<{
    recipient: Omit<AliasRow, "token" | "expires"> | null;
    sender: { alias_address: string | null; real_address: string } | null;
}> => {
    let recipient: Omit<AliasRow, "token" | "expires"> | null = null;
    let sender: {
        alias_address: string | null;
        real_address: string;
    } | null = null;

    // If the email is sent to a reverse alias, just get the recipient info from the reverse alias.
    // If it doesn't exist, return null.
    if (is_email_reverse_alias(alias_to_address, env.EMAIL_DOMAIN)) {
        // If sending to a reverse alias, and the sender doesn't exist in our database,
        // either someone leaked the reverse alias or the sender deleted their alias.
        // In either case return null for both sender and recipient to reject the email.
        const reverse_info = await alias_manager.resolve_reverse_alias({ reverse_alias: alias_to_address });
        if (reverse_info) {
            sender = await alias_manager.get_by_alias_address(reverse_info.owner_alias_address);
            // Ensure that the sender owns the reverse alias.
            // If this check fails, return null for the recipient.
            if (sender && sender.real_address === real_from_address) {
                recipient = {
                    alias_address: reverse_info.reverse_alias,
                    real_address: reverse_info.recipient_real_address,
                    verified: true,
                    allow_reply: true,
                };
            }
        }
    } else {
        // If the email is sent to a normal alias, we need to also create a reverse alias
        // for the sender if one doesn't exist.
        recipient = await alias_manager.get_by_alias_address(alias_to_address);
        if (recipient) {
            // A reverse alias can only be created if the recipient exists, is verified, and is allowed to reply.
            if (recipient.verified && recipient.allow_reply) {
                let reverse_info = await alias_manager.get_reverse_alias({
                    owner_alias_address: recipient.alias_address,
                    recipient_real_address: real_from_address,
                });
                if (!reverse_info) {
                    reverse_info = await alias_manager.create_reverse_alias({
                        owner_alias_address: recipient.alias_address,
                        recipient_real_address: real_from_address,
                    });
                }
                sender = {
                    alias_address: reverse_info.reverse_alias,
                    real_address: real_from_address,
                };
            } else {
                // If the recipient can't reply, still return the sender's real address.
                sender = {
                    alias_address: null,
                    real_address: real_from_address,
                };
            }
        }
    }

    return { recipient, sender };
};

/**
 * Verify the webhook signature of the incoming request.
 * @param body The raw request body as a string.
 */
const verify_webhook_signature = async (body: string, request: Request, env: Env): Promise<boolean> => {
    const header = request.headers.get("Contiguity-Signature");
    if (!body || !header || !env.CONTIGUITY_WH_SECRET) {
        return false;
    }

    const match = header.match(/^t=(\d+),v1=([a-f0-9]+)$/);
    if (!match) {
        return false;
    }
    const [, t, v1] = match;

    const timestamp = Number(t);
    if (Date.now() / 1000 > timestamp + env.WH_SIGNATURE_EXPIRY_SECONDS) {
        return false;
    }

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(env.CONTIGUITY_WH_SECRET),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
    );

    const signature = hex_to_bytes(v1);
    const payload = `${t}.${body}`;
    return await crypto.subtle.verify("HMAC", key, signature, encoder.encode(payload));
};

/**
 * Accept an incoming email webhook event and process it in the background.
 */
export const handle_incoming_email = async (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
    if (request.method !== "POST") {
        console.log({ message: "Received non-POST request", request });
        return new Response("Method Not Allowed", { status: 405 });
    }
    // Request body has to be read here since it can't be used after we return a Response.
    const body = await request.text();
    if (!verify_webhook_signature(body, request, env)) {
        console.warn({ message: "Received request with invalid signature", request });
        return new Response("Unauthorized", { status: 401 });
    }
    if (request.headers.get("Content-Type") !== "application/json") {
        console.log({ message: "Received request without JSON content type", request });
        return new Response("Bad Request", { status: 400 });
    }

    const event = JSON.parse(body) as Event;

    if (event.type !== "email.incoming") {
        console.warn({ message: "Received unsupported event type", event_type: event.type });
        return new Response("Bad Request", { status: 400 });
    }

    const { data } = event as EmailEvent;

    ctx.waitUntil(relay_email(data, env, ctx));
    return new Response("Accepted", { status: 202 });
};

/**
 * Relay an incoming email to the real recipient address, hiding the sender's address behind an alias.
 */
export const relay_email = async (data: EmailData, env: Env, ctx: ExecutionContext): Promise<Response> => {
    const alias_to_address = data.to.address.toLowerCase().trim();
    const real_from_address = data.from.address.toLowerCase().trim();
    const notification_manager = new NotificationManager(ctx, env);

    // Rate limit incoming emails from the same sender address.
    const { success } = await env.RELAY_RATE_LIMITER.limit({ key: real_from_address });
    if (!success) {
        console.log({ message: "Rate limit exceeded for sender", sender: real_from_address });
        ctx.waitUntil(notification_manager.notify_rate_limited(data));
        return new Response("Too Many Requests", { status: 429 });
    }

    // Drop emails sent to the system addresses.
    if (
        [
            notification_manager.system_address,
            notification_manager.relay_address,
            notification_manager.noreply_address,
        ].includes(alias_to_address)
    ) {
        console.log({ message: "Dropping email sent to system address", to: alias_to_address });
        return new Response("Not Found", { status: 404 });
    }

    // Reject replies sent to the reply catch-all address.
    if (alias_to_address === notification_manager.reply_catchall_address) {
        console.warn({ message: "Rejecting reply sent to catch-all address", sender: real_from_address });
        ctx.waitUntil(notification_manager.notify_reply_unavailable(data));
        return new Response("Forbidden", { status: 403 });
    }

    // Reject emails not sent to an alias address.
    if (!is_email_alias(alias_to_address, env.EMAIL_DOMAIN)) {
        console.warn({ message: "Incoming email sent to non-alias address", address: alias_to_address });
        return new Response("Bad Request", { status: 400 });
    }

    // Reject emails sent from an alias address.
    // This should never happen since incoming emails are sent from real addresses.
    if (is_email_alias(real_from_address, env.EMAIL_DOMAIN)) {
        console.warn({ message: "Incoming email sent from alias address", address: real_from_address });
        return new Response("Bad Request", { status: 400 });
    }

    // Reject emails with excessively large bodies.
    if (data.body.text && data.body.text.length > MAX_BODY_SIZE) {
        console.log({ message: "Email body too large", length: data.body.text.length, from: real_from_address });
        return new Response("Content Too Large", { status: 413 });
    }

    const alias_manager = new AliasManager(ctx, env);

    // Verify that the sender address is not blacklisted.
    if (await alias_manager.is_blacklisted(real_from_address)) {
        console.log({ message: "Rejected email from blacklisted sender", sender: real_from_address });
        return new Response("Forbidden", { status: 403 });
    }

    const { recipient, sender } = await resolve_addresses({ env, alias_manager, alias_to_address, real_from_address });

    // Verify that the recipient alias address exists and is verified,
    // and the real recipient address is not blacklisted.
    // Also verify that the sender real address exists in our database if sending to a reverse alias.
    const recipient_blacklisted = recipient && (await alias_manager.is_blacklisted(recipient.real_address));
    if (!sender || !recipient || !recipient.verified || recipient_blacklisted) {
        console.log({
            message: "Sender or recipient could not be resolved or is unverified/blacklisted",
            sender,
            recipient,
            recipient_blacklisted,
        });
        ctx.waitUntil(notification_manager.notify_undeliverable(data, alias_to_address));
        return new Response("Not Found", { status: 404 });
    }

    if (recipient.allow_reply && !sender.alias_address) {
        console.warn({ message: "Sender alias could not be resolved for reply-enabled recipient" });
    }

    // Refresh the recipient alias. If it's a reverse alias, nothing will happen.
    ctx.waitUntil(alias_manager.update_alias_expiry(recipient.alias_address));
    // Refresh the sender alias in case the email is a reply to a reverse alias.
    // If instead it's a reverse alias, nothing will happen.
    if (sender.alias_address) {
        ctx.waitUntil(alias_manager.update_alias_expiry(sender.alias_address));
    }

    // Create a new alias message ID for the email.
    // TODO: WIP (waiting for Contiguity to support fetching real Message-IDs)
    // Disabled for now, pending ability to get real message IDs from the email API.
    // let headers: Record<string, string> = {};
    // if (recipient.allow_reply && sender.alias_address) {
    //     const message_id = await new_message_id(env, data, sender.alias_address);
    //     const headers = await unalias_threading_headers(env, data);
    //     if (message_id) {
    //         headers["Message-ID"] = message_id;
    //     }
    // }

    // Relay the email.
    // `sender.alias_address` is only available if `recipient.allow_reply` is true.
    const email_promise = send_email(env, {
        to: recipient.real_address,
        from:
            recipient.allow_reply && sender.alias_address ? sender.alias_address : notification_manager.relay_address,
        from_name: "Anonymous",
        reply_to:
            recipient.allow_reply && sender.alias_address
                ? sender.alias_address
                : notification_manager.reply_catchall_address,
        subject: data.subject,
        body: data.body.text,
        // headers,
    });
    ctx.waitUntil(email_promise); // Prevent the worker from being cancelled before the email is sent.
    try {
        const response = await email_promise;
        if (!response.ok) {
            console.error({ message: "API error while relaying email", response: await response.json() });
            return new Response("Bad Gateway", { status: 502 });
        }
        return new Response("OK", { status: 200 });
    } catch (error) {
        const message = error instanceof Error ? error.message : `${error}`;
        console.error({ message: "Failed to relay email", error: message });
        return new Response("Internal Server Error", { status: 500 });
    }
};
