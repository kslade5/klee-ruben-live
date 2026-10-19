-- Claim tokens make multi-step payment writes safe without relying on database-specific functions.
ALTER TABLE raffle_purchases ADD COLUMN claim_token TEXT;
ALTER TABLE referral_rewards ADD COLUMN claim_token TEXT;
