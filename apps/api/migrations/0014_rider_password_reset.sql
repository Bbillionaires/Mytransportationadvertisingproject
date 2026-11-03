-- Rider password reset tokens.
ALTER TABLE rider_tokens DROP CONSTRAINT rider_tokens_kind_check;
ALTER TABLE rider_tokens ADD CONSTRAINT rider_tokens_kind_check CHECK (kind IN ('EMAIL_VERIFY','PHONE_SESSION','TABLET_SESSION','PASSWORD_RESET'));
