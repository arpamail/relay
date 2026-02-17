import { WorkerEntrypoint } from "cloudflare:workers";
import { NotificationManager } from "./notifications";
import { BadAddressError, LimitExceededError, RecordNotFoundError } from "./errors";
import { bytes_to_hex, strip_subaddress, is_email_alias, is_email_reverse_alias } from "./helpers";
import type { DeleteAliasRequest, AliasRow, ReverseAliasRow } from "./types";

interface AliasApiEndpointHandler {
    (real_address: string, token: string): Promise<D1Result<Record<string, unknown>>>;
}

// NOTE: RPC methods cannot be arrow functions.
export class AliasManager extends WorkerEntrypoint {
    async fetch(request: Request) {
        let { pathname } = new URL(request.url);
        if (!pathname.endsWith("/")) {
            pathname += "/";
        }
        if (pathname === "/alias/verify/") {
            return this.#handle_fetch(request, this.verify_address.bind(this));
        } else if (pathname === "/alias/delete/") {
            return this.#handle_fetch(request, this.delete_address.bind(this));
        }
        console.log({ message: "Not found", pathname });
        return new Response("Not Found", { status: 404 });
    }

    /**
     * Parse the address and token from the request.
     * @throws Response if the request should be aborted with the given response.
     */
    async #parse_payload(request: Request): Promise<{ address: string; token: string }> {
        let address: string | undefined;
        let token: string | undefined;
        if (request.method === "POST" && request.headers.get("Content-Type") === "application/json") {
            try {
                const json = (await request.json()) as DeleteAliasRequest;
                address = json.address;
                token = json.token;
            } catch (error) {
                const message = error instanceof Error ? error.message : `${error}`;
                console.error({ message: "Failed to parse JSON in API request", error: message });
                throw new Response("Bad Request", { status: 400 });
            }
        } else {
            const params = new URL(request.url).searchParams;
            address = params.get("address")?.toLowerCase().trim();
            token = params.get("token")?.toLowerCase().trim();
        }
        if (!address || !token) {
            throw new Response("Bad Request", { status: 400 });
        }

        const { success } = await this.env.API_RATE_LIMITER.limit({ key: address });
        if (!success) {
            throw new Response("Too Many Requests", { status: 429 });
        }

        return { address, token };
    }

    /**
     * Handle a fetch request using the given function.
     * Accepts `verify_address`, `delete_address`, and others with the same signature.
     */
    async #handle_fetch(request: Request, func: AliasApiEndpointHandler): Promise<Response> {
        try {
            const { address, token } = await this.#parse_payload(request);
            const promise = func(address, token);
            this.ctx.waitUntil(promise);
            const result = await promise;
            if (result.meta.changes === 0) {
                // Intentionally using Not Found instead of Forbidden
                // to not reveal whether the address exists.
                throw new RecordNotFoundError("Not Found");
            }
            return new Response("OK", { status: 200 });
        } catch (error) {
            if (error instanceof Response) {
                return error;
            } else if (error instanceof RecordNotFoundError) {
                return new Response("Not Found", { status: 404 });
            }
            return new Response("Internal Server Error", { status: 500 });
        }
    }

    /**
     * Generate a random token as a SHA-256 hex string.
     */
    async #generate_token(): Promise<string> {
        const bytes = new TextEncoder().encode(crypto.randomUUID());
        const hash_buffer = await crypto.subtle.digest("SHA-256", bytes);
        return bytes_to_hex(new Uint8Array(hash_buffer));
    }

    #generate_alias(): string {
        return `${crypto.randomUUID()}@${this.env.EMAIL_DOMAIN}`;
    }

    #generate_reverse_alias(): string {
        return `r-${this.#generate_alias()}`;
    }

    alias_ttl(verified: boolean = false): { hours: number; seconds: number } {
        const ttl_hours = verified ? this.env.ALIAS_TTL_DAYS * 24 : this.env.UNVERIFIED_ALIAS_TTL_HOURS;
        return {
            hours: ttl_hours,
            seconds: ttl_hours * 60 * 60,
        };
    }

    /**
     * Create a new alias address and token for the given real address, and insert it into the database.
     * @throws BadAddressError if `real_address` is empty.
     * @throws BadAddressError if `real_address` is already an alias address.
     * @throws BadAddressError if `real_address` is blacklisted.
     * @throws LimitExceededError if the maximum number of aliases for `real_address` has been reached.
     * @throws Error if unable to create a unique alias address after `max_attempts`.
     * @throws Error if unable to retrieve the alias address from the database.
     */
    async create_alias({
        real_address,
        verified = false,
        allow_reply = true, // TODO: revert to false
        ttl = this.alias_ttl(verified).seconds,
        max_attempts = 10,
    }: {
        real_address: string;
        verified?: boolean;
        allow_reply?: boolean;
        ttl?: number;
        max_attempts?: number;
    }): Promise<AliasRow> {
        real_address = strip_subaddress(real_address.toLowerCase().trim());
        if (!real_address) {
            throw new BadAddressError("Real address cannot be empty.");
        }

        if (is_email_alias(real_address, this.env.EMAIL_DOMAIN)) {
            throw new BadAddressError("You cannot create an alias for an alias address.");
        }

        const blacklisted = await this.is_blacklisted(real_address);
        if (blacklisted) {
            throw new BadAddressError("This address is blacklisted and cannot create aliases.");
        }

        const existing_alias_count = await this.get_alias_count(real_address);
        if (existing_alias_count >= this.env.MAX_FREE_ALIASES) {
            throw new LimitExceededError("You cannot create more aliases for this address.");
        }

        const token = await this.#generate_token();
        const expires = Math.floor(Date.now() / 1000) + ttl;
        let alias_address = this.#generate_alias();
        let fail = true;
        let fail_error;
        const sql_stmt = this.env.DB.prepare(
            "INSERT INTO aliases (alias_address, real_address, token, verified, allow_reply, expires) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        );

        for (let i = 0; i < max_attempts; i++) {
            try {
                await sql_stmt.bind(alias_address, real_address, token, verified, allow_reply, expires).run();
                fail = false;
                break;
            } catch (error) {
                fail_error = error;
                alias_address = this.#generate_alias();
            }
        }
        if (fail) {
            throw new Error(`Failed to generate unique alias address after ${max_attempts} attempts: ${fail_error}`);
        }

        const record = await this.env.DB.prepare("SELECT * FROM aliases WHERE alias_address = ?1 LIMIT 1")
            .bind(alias_address)
            .first<AliasRow>();
        if (!record) {
            throw new Error("Failed to retrieve newly created alias address record.");
        }

        this.ctx.waitUntil(
            new NotificationManager(this.ctx, this.env).notify_new_user(record, {
                verification_link: this.verification_link(real_address, token),
                deletion_link: this.deletion_link(real_address, token),
            }),
        );

        return record;
    }

    /**
     * Create a new reverse alias address, and insert it into the database.
     * @throws BadAddressError if `owner_alias_address` is empty.
     * @throws BadAddressError if `recipient_real_address` is empty.
     * @throws BadAddressError if `owner_alias_address` is not a valid alias address.
     * @throws BadAddressError if `owner_alias_address` is a reverse alias address.
     * @throws BadAddressError if `recipient_real_address` is not a real address.
     * @throws Error if unable to create a unique reverse alias address after `max_attempts`.
     * @throws Error if unable to retrieve the reverse alias address from the database.
     */
    async create_reverse_alias({
        owner_alias_address,
        recipient_real_address,
        max_attempts = 10,
    }: {
        owner_alias_address: string;
        recipient_real_address: string;
        max_attempts?: number;
    }): Promise<ReverseAliasRow> {
        if (!owner_alias_address) {
            throw new BadAddressError("Owner alias address cannot be empty.");
        }
        if (!recipient_real_address) {
            throw new BadAddressError("Recipient real address cannot be empty.");
        }

        owner_alias_address = strip_subaddress(owner_alias_address.toLowerCase().trim());
        recipient_real_address = strip_subaddress(recipient_real_address.toLowerCase().trim());

        if (!is_email_alias(owner_alias_address, this.env.EMAIL_DOMAIN)) {
            throw new BadAddressError("Owner address must be a valid alias address.");
        }
        if (is_email_reverse_alias(owner_alias_address, this.env.EMAIL_DOMAIN)) {
            throw new BadAddressError("Owner alias address cannot be a reverse alias address.");
        }
        if (is_email_alias(recipient_real_address, this.env.EMAIL_DOMAIN)) {
            throw new BadAddressError("Recipient address must be a real address.");
        }

        let reverse_alias = this.#generate_reverse_alias();
        let fail = true;
        let fail_error;
        const sql_stmt = this.env.DB.prepare(
            "INSERT INTO reverse_aliases (reverse_alias, owner_alias_address, recipient_real_address) VALUES (?1, ?2, ?3)",
        );

        for (let i = 0; i < max_attempts; i++) {
            try {
                await sql_stmt.bind(reverse_alias, owner_alias_address, recipient_real_address).run();
                fail = false;
                break;
            } catch (error) {
                fail_error = error;
                reverse_alias = this.#generate_reverse_alias();
            }
        }
        if (fail) {
            throw new Error(
                `Failed to generate unique reverse alias address after ${max_attempts} attempts: ${fail_error}`,
            );
        }

        const record = await this.env.DB.prepare("SELECT * FROM reverse_aliases WHERE reverse_alias = ?1 LIMIT 1")
            .bind(reverse_alias)
            .first<ReverseAliasRow>();
        if (!record) {
            throw new Error("Failed to retrieve newly created reverse alias address record.");
        }
        return record;
    }

    /**
     * Retrieve an alias and real address pair using the real address and token.
     * The token is required to differentiate between multiple aliases for the same real address.
     */
    get_by_real_address(real_address: string, token: string): Promise<AliasRow | null> {
        return this.env.DB.prepare("SELECT * FROM aliases WHERE real_address = ?1 AND token = ?2 LIMIT 1")
            .bind(real_address, token)
            .first<AliasRow>();
    }

    /**
     * Retrieve an alias and real address pair using the alias address.
     */
    get_by_alias_address(alias_address: string): Promise<AliasRow | null> {
        return this.env.DB.prepare("SELECT * FROM aliases WHERE alias_address = ?1 LIMIT 1")
            .bind(alias_address)
            .first<AliasRow>();
    }

    /**
     * Get the number of aliases associated with a real address.
     */
    async get_alias_count(real_address: string): Promise<number> {
        const result = await this.env.DB.prepare("SELECT COUNT(*) as count FROM aliases WHERE real_address = ?1")
            .bind(real_address)
            .first<{ count: number }>();
        return result ? result.count : 0;
    }

    /**
     * Retrieve a reverse alias for a particular owner alias address
     * and recipient real address combination, if it exists.
     */
    get_reverse_alias({
        owner_alias_address,
        recipient_real_address,
    }: {
        owner_alias_address: string;
        recipient_real_address: string;
    }): Promise<ReverseAliasRow | null> {
        return this.env.DB.prepare(
            "SELECT * FROM reverse_aliases WHERE owner_alias_address = ?1 AND recipient_real_address = ?2 LIMIT 1",
        )
            .bind(owner_alias_address, recipient_real_address)
            .first<ReverseAliasRow>();
    }

    /**
     * Resolve addresses from a reverse alias, if it exists.
     */
    resolve_reverse_alias({ reverse_alias }: { reverse_alias: string }): Promise<ReverseAliasRow | null> {
        return this.env.DB.prepare("SELECT * FROM reverse_aliases WHERE reverse_alias = ?1 LIMIT 1")
            .bind(reverse_alias)
            .first<ReverseAliasRow>();
    }

    /**
     * Update the expiry time of an alias entry. If `ttl` is not provided, use the default **verified** TTL.
     */
    update_alias_expiry(alias_address: string, ttl: number = this.alias_ttl(true).seconds) {
        // Do nothing for reverse aliases since their expiration is tied to the owner alias.
        if (is_email_reverse_alias(alias_address, this.env.EMAIL_DOMAIN)) {
            return Promise.resolve();
        }
        const new_expires = Math.floor(Date.now() / 1000) + ttl;
        return this.env.DB.prepare(
            "UPDATE aliases SET expires = ?1 WHERE alias_address = ?2 AND expires IS NOT NULL LIMIT 1",
        )
            .bind(new_expires, alias_address)
            .run();
    }

    /**
     * Mark an address as verified.
     */
    async verify_address(real_address: string, token: string) {
        const alias_record = await this.get_by_real_address(real_address, token);
        if (!alias_record) {
            throw new RecordNotFoundError("No matching record found to verify.");
        }
        await this.update_alias_expiry(alias_record.alias_address);
        return this.env.DB.prepare("UPDATE aliases SET verified = TRUE WHERE real_address = ?1 AND token = ?2 LIMIT 1")
            .bind(real_address, token)
            .run();
    }

    /**
     * Add a real address to the blacklist, preventing it from creating aliases and sending emails.
     */
    blacklist_address(real_address: string, reason?: string) {
        const timestamp = Math.floor(Date.now() / 1000);
        return this.env.DB.prepare("INSERT INTO blacklist (real_address, timestamp, reason) VALUES (?1, ?2, ?3)")
            .bind(real_address, timestamp, reason || null)
            .run();
    }

    /**
     * Check if a real address is blacklisted.
     */
    async is_blacklisted(real_address: string): Promise<boolean> {
        const record = await this.env.DB.prepare("SELECT * FROM blacklist WHERE real_address = ?1 LIMIT 1")
            .bind(real_address)
            .first();
        return record !== null;
    }

    /**
     * Delete an address record from the database.
     * @throws RecordNotFoundError if no matching record is found.
     */
    async delete_address(real_address: string, token: string) {
        const existing = await this.get_by_real_address(real_address, token);
        if (!existing) {
            throw new RecordNotFoundError("No matching record found to delete.");
        }
        const promise = this.env.DB.prepare("DELETE FROM aliases WHERE real_address = ?1 AND token = ?2 LIMIT 1")
            .bind(real_address, token)
            .run();
        this.ctx.waitUntil(promise);
        return promise;
    }

    /**
     * Clean up expired alias address records from the database.
     */
    async delete_expired_aliases() {
        try {
            return this.env.DB.prepare("DELETE FROM aliases WHERE expires < ?1")
                .bind(Math.floor(Date.now() / 1000))
                .run();
        } catch (error) {
            const message = error instanceof Error ? error.message : `${error}`;
            console.warn({ message: "Failed to delete expired records", error: message });
        }
    }

    #build_link(path: string, address: string, token: string): URL {
        const url = new URL(path, this.env.RELAY_URL);
        url.searchParams.set("address", address);
        url.searchParams.set("token", token);
        return url;
    }

    /**
     * Return a link that can be used to verify an address row.
     */
    verification_link(address: string, token: string): URL {
        return this.#build_link("/alias/verify", address, token);
    }

    /**
     * Return a link that can be used to delete an address row.
     */
    deletion_link(address: string, token: string): URL {
        return this.#build_link("/alias/delete", address, token);
    }

    get max_free_aliases(): number {
        return this.env.MAX_FREE_ALIASES;
    }
}
