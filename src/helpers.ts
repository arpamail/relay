import { BadAddressError } from "./errors";

export const bytes_to_hex = (bytes: Uint8Array): string => {
    return Array.from(bytes)
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
};

export const hex_to_bytes = (hex: string): Uint8Array<ArrayBuffer> => {
    if (hex.length % 2 !== 0) {
        throw new Error("Invalid hex string");
    }
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
    }
    return bytes;
};

export const strip_angle_brackets = (address: string): string => {
    if (address.startsWith("<") && address.endsWith(">")) {
        return address.slice(1, -1);
    }
    return address;
};

export const add_angle_brackets = (address: string): string => {
    if (!address.startsWith("<") && !address.endsWith(">")) {
        return `<${address}>`;
    }
    return address;
};

/**
 * Strip the subaddress (anything after the `+` in the local part) from an email address.
 * @throws BadAddressError if the email address is invalid.
 */
export const strip_subaddress = (address: string): string => {
    address = strip_angle_brackets(address);
    if (address.length > 320) {
        throw new BadAddressError("Email address is too long.");
    }

    const parts = address.split("@");
    if (parts.length !== 2) {
        throw new BadAddressError("Invalid email address format.");
    }
    const [local, domain] = parts;

    const stripped_local = local.split("+")[0];
    if (!stripped_local || !domain) {
        throw new BadAddressError("Invalid email address format.");
    }

    return `${stripped_local}@${domain}`;
};

/**
 * Check if an address is an email alias (including reverse aliases).
 */
export const is_email_alias = (address: string, domain: string): boolean => {
    return strip_angle_brackets(address).toLowerCase().endsWith(`@${domain}`);
};

/**
 * Check if an address is specifically a reverse email alias.
 */
export const is_email_reverse_alias = (address: string, domain: string): boolean => {
    return is_email_alias(address, domain) && strip_angle_brackets(address).toLowerCase().startsWith("r-");
};
