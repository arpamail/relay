CREATE TABLE aliases (
    alias_address TEXT PRIMARY KEY NOT NULL,
    real_address TEXT NOT NULL,
    token TEXT NOT NULL,
    verified BOOL NOT NULL,
    allow_reply BOOL NOT NULL,
    expires INTEGER
);

CREATE TABLE blacklist (
    real_address TEXT PRIMARY KEY NOT NULL,
    timestamp INTEGER NOT NULL,
    reason TEXT
);

CREATE TABLE message_ids (
    aliased_id TEXT PRIMARY KEY NOT NULL,
    real_id TEXT NOT NULL,
    sender_alias_address TEXT NOT NULL,
    FOREIGN KEY(sender_alias_address) REFERENCES aliases(alias_address) ON DELETE CASCADE
);

CREATE TABLE reverse_aliases (
    reverse_alias TEXT PRIMARY KEY NOT NULL,
    owner_alias_address TEXT NOT NULL,
    recipient_real_address TEXT NOT NULL,
    FOREIGN KEY(owner_alias_address) REFERENCES aliases(alias_address) ON DELETE CASCADE
);

CREATE INDEX idx_message_ids_real_id ON message_ids(real_id);
CREATE INDEX idx_reverse_aliases_recipient_real_address ON reverse_aliases(recipient_real_address);
