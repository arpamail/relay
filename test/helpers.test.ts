import { describe, expect, test } from "bun:test";

import { is_sender_authenticated, strip_subaddress } from "../src/helpers";

describe("is_sender_authenticated", () => {
    const ID = "amazonses.com";
    // Real header from a production delivery.
    const real =
        "amazonses.com; spf=pass (spfCheck: domain of lemonyte.com designates 165.173.182.54 as permitted sender) client-ip=165.173.182.54; envelope-from=hi@lemonyte.com; helo=sender5-of-o54.zoho.com; dkim=pass header.i=@lemonyte.com; dmarc=pass header.from=lemonyte.com;";
    const h = (value: unknown) => ({ "authentication-results": value });

    test("accepts a DMARC pass for the sender's domain", () => {
        expect(is_sender_authenticated(h(real), "hi@lemonyte.com", ID)).toBe(true);
        expect(is_sender_authenticated(h(real), "<HI@Lemonyte.com>", ID)).toBe(true);
    });

    test("trusts only the first header", () => {
        const fake = "amazonses.com; dmarc=pass header.from=victim.com";
        const failing = "amazonses.com; dmarc=fail header.from=victim.com";
        expect(is_sender_authenticated(h([real, failing]), "hi@lemonyte.com", ID)).toBe(true);
        expect(is_sender_authenticated(h([failing, fake]), "a@victim.com", ID)).toBe(false);
    });

    test("rejects other domains", () => {
        for (const address of ["a@victim.com", "a@sub.lemonyte.com", "a@evil-lemonyte.com"]) {
            expect(is_sender_authenticated(h(real), address, ID)).toBe(false);
        }
    });

    test("rejects non-pass results, missing headers, and other servers", () => {
        expect(is_sender_authenticated(h(real.replace("dmarc=pass", "dmarc=fail")), "hi@lemonyte.com", ID)).toBe(false);
        expect(is_sender_authenticated(h(real.replace("dmarc=pass", "dmarc=none")), "hi@lemonyte.com", ID)).toBe(false);
        expect(is_sender_authenticated({}, "hi@lemonyte.com", ID)).toBe(false);
        expect(is_sender_authenticated(h(real.replace("amazonses.com;", "evil.com;")), "hi@lemonyte.com", ID)).toBe(
            false,
        );
    });

    test("ignores a fake result injected through sender-controlled fields", () => {
        const injected = `amazonses.com; spf=pass envelope-from="a; dmarc=pass header.from=victim.com"@x.com; dkim=none; dmarc=fail header.from=victim.com;`;
        expect(is_sender_authenticated(h(injected), "a@victim.com", ID)).toBe(false);
    });
});

describe("strip_subaddress", () => {
    test("strips the tag", () => {
        expect(strip_subaddress("<user+tag@example.com>")).toBe("user@example.com");
    });

    test("rejects malformed addresses", () => {
        for (const address of ["no-at", "a@b@c", "+tag@example.com", "user@"]) {
            expect(() => strip_subaddress(address)).toThrow();
        }
    });
});
