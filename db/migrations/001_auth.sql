-- 字段大小写遵循 @auth/pg-adapter；业务外键使用同一个 UUID user id。
CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text,
    email text UNIQUE,
    "emailVerified" timestamptz,
    image text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "userId" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type text NOT NULL,
    provider text NOT NULL,
    "providerAccountId" text NOT NULL,
    refresh_token text,
    access_token text,
    expires_at bigint,
    token_type text,
    scope text,
    id_token text,
    session_state text,
    UNIQUE (provider, "providerAccountId")
);
CREATE INDEX accounts_user_idx ON accounts ("userId");

CREATE TABLE sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "userId" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires timestamptz NOT NULL,
    "sessionToken" text NOT NULL UNIQUE
);
CREATE INDEX sessions_user_idx ON sessions ("userId");

CREATE TABLE verification_token (
    identifier text NOT NULL,
    token text NOT NULL UNIQUE,
    expires timestamptz NOT NULL,
    PRIMARY KEY (identifier, token)
);
