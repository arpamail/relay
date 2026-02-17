import { WorkerEntrypoint } from "cloudflare:workers";
import { send_email, send_reply } from "./email_api";
import { add_angle_brackets, is_email_reverse_alias } from "./helpers";
import type { EmailData, AliasRow } from "./types";

export class NotificationManager extends WorkerEntrypoint {
    system_address = `system@${this.env.EMAIL_DOMAIN}`;
    relay_address = `relay@${this.env.EMAIL_DOMAIN}`;
    reply_catchall_address = `replies@${this.env.EMAIL_DOMAIN}`;
    noreply_address = `no-reply@${this.env.EMAIL_DOMAIN}`;
    support_address = `support@${this.env.EMAIL_DOMAIN}`;

    /**
     * Notify the sender that their email was undeliverable.
     */
    notify_undeliverable(parent: EmailData, to_alias_address: string) {
        return this.#try_notification_with_rate_limit(
            send_reply(this.env, parent, {
                from: this.system_address,
                from_name: "ArpaMail",
                reply_to: this.noreply_address,
                subject: `Undeliverable: ${parent.subject}`,
                body: is_email_reverse_alias(to_alias_address, this.env.EMAIL_DOMAIN)
                    ? this.#undeliverable_reverse_message(add_angle_brackets(to_alias_address))
                    : this.#undeliverable_message(add_angle_brackets(to_alias_address)),
            }),
            {
                rate_limit_key: `undeliverable:${parent.from.address}`,
                warn_msg: "Failed to send undeliverable notification",
            },
        );
    }

    /**
     * Notify the sender of their new alias address.
     */
    notify_new_user(user: AliasRow, links: { verification_link: URL; deletion_link: URL }) {
        return this.#try_notification_with_rate_limit(
            send_email(this.env, {
                to: user.real_address,
                from: this.system_address,
                from_name: "ArpaMail",
                reply_to: this.support_address,
                subject: "Your new email alias",
                body: this.#unverified_user_message({
                    alias_address: add_angle_brackets(user.alias_address),
                    token: user.token,
                    deletion_link: links.deletion_link,
                    verification_link: links.verification_link,
                }),
            }),
            {
                rate_limit_key: `new_user:${user.real_address}`,
                warn_msg: "Failed to notify sender of new alias address",
            },
        );
    }

    /**
     * Notify the sender that they have been rate limited.
     */
    notify_rate_limited(parent: EmailData) {
        return this.#try_notification_with_rate_limit(
            send_reply(this.env, parent, {
                from: this.system_address,
                from_name: "ArpaMail",
                reply_to: this.noreply_address,
                subject: `Rate Limit Exceeded: ${parent.subject}`,
                body: "You have sent too many emails in a short period of time. Please wait a few minutes before sending more emails.",
            }),
            {
                rate_limit_key: `rate_limited:${parent.from.address}`,
                warn_msg: "Failed to send rate limit notification",
            },
        );
    }

    /**
     * Notify the sender that replies are not available.
     */
    notify_reply_unavailable(parent: EmailData) {
        return this.#try_notification_with_rate_limit(
            send_reply(this.env, parent, {
                from: this.system_address,
                from_name: "ArpaMail",
                reply_to: this.support_address,
                subject: `Reply Unavailable: ${parent.subject}`,
                body: this.#reply_unavailable_message(),
            }),
            {
                rate_limit_key: `reply_unavailable:${parent.from.address}`,
                warn_msg: "Failed to send reply unavailable notification",
            },
        );
    }

    /**
     * Try to send a notification email with rate limiting.
     * If rate limit is exceeded or sending fails, log a warning but do not throw.
     */
    async #try_notification_with_rate_limit(
        promise: Promise<Response>,
        params: { rate_limit_key: string; warn_msg: string },
    ) {
        try {
            await this.#rate_limit_notification(params.rate_limit_key);
            const response = await promise;
            if (!response.ok) {
                throw new Error(await response.text());
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : `${error}`;
            console.warn({ message: params.warn_msg, error: message });
        }
    }

    /**
     * Rate limit automated notifications to save our email API quota.
     * @throws Error if rate limit is exceeded.
     */
    async #rate_limit_notification(key: string) {
        const { success } = await this.env.NOTIFICATION_RATE_LIMITER.limit({ key });
        if (!success) {
            throw new Error(`Notification rate limit exceeded for key ${key}.`);
        }
    }

    #undeliverable_message(to_alias_address: string): string {
        return `Your email could not be delivered because the recipient address ${to_alias_address} does not exist.
It may have expired or been deleted.`;
    }

    #undeliverable_reverse_message(to_alias_address: string): string {
        return `Your email could not be delivered because the reverse alias ${to_alias_address} does not exist.
This may be because your alias used to receive the email has been deleted or expired.`;
    }

    #unverified_user_message(params: {
        alias_address: string;
        token: string;
        deletion_link: URL;
        verification_link: URL;
    }): string {
        return `Before you can start sending and receiving emails with your new email alias,
you must verify it by clicking the link below within 1 hour.

${params.verification_link}

Your new email alias is:

    ${params.alias_address}

Your alias token is:

    ${params.token}

This token grants you the ability to verify and delete your email address.
Keep it safe and do not share it.

Don't remember creating an alias? Use the link below to delete it:
${params.deletion_link}

Questions? Reply to this email or visit ${this.env.SITE_URL} for more information about ArpaMail.`;
    }

    #reply_unavailable_message(): string {
        return `Your account does not currently allow sending replies.
If you would like to enable this feature, please contact us at ${this.support_address}.`;
    }
}
