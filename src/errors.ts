export class RecordNotFoundError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RecordNotFoundError";
        Object.setPrototypeOf(this, RecordNotFoundError.prototype);
    }
}

export class LimitExceededError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "LimitExceededError";
        Object.setPrototypeOf(this, LimitExceededError.prototype);
    }
}

export class BadAddressError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "BadAddressError";
        Object.setPrototypeOf(this, BadAddressError.prototype);
    }
}
