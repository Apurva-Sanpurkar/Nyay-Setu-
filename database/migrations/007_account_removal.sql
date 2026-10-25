-- ===========================================================================
-- NyaySetu :: 007_account_removal.sql
-- Makes an account removable when nothing evidentiary depends on it.
--
-- Run after 006_invitations.sql.
--
-- THE PROBLEM
--   An account created by mistake could not be deleted. Not because of a policy
--   decision, but because chain_tx.submitted_by referenced it with no ON DELETE
--   clause, so Postgres refused. chain_tx is an operational log — a transaction
--   hash, the gas it burned, the block it landed in, whether it failed — and it
--   was quietly making every account permanent.
--
-- WHY SET NULL IS THE RIGHT ANSWER HERE, AND NOT ELSEWHERE
--   Who did what is recorded in three places, and chain_tx is the weakest of the
--   three:
--
--     1. on chain, as the actor's Aadhaar token, written into the contract by
--        registerEvidence / transferCustody / acknowledgeSummons. Immutable, and
--        not ours to delete even if we wanted to.
--     2. action_log, which records the attempt including refusals that left no
--        row behind. Its actor_id is already ON DELETE SET NULL, and it keeps
--        actor_role alongside, so the trail survives the account.
--     3. chain_tx.submitted_by, which exists so an operator can ask "who ran up
--        this gas bill".
--
--   Losing (3) for a deleted account costs an operational convenience. Keeping it
--   costs the ability to ever remove anybody, which collides with the DPDP Act's
--   erasure obligations for, say, an accused person whose case has closed. So the
--   convenience gives way.
--
--   What is deliberately NOT changed: evidence_items.officer_id,
--   cases.registered_by, custody_events.actor_id, summons.issued_by and
--   bail_conditions.granted_by all keep their restrictive references. Those are
--   the evidentiary links. An officer who collected an exhibit is part of that
--   exhibit's provenance, and the database should refuse to erase them — which is
--   exactly what the API now reports back as "deactivate instead".
-- ===========================================================================

alter table public.chain_tx
  drop constraint if exists chain_tx_submitted_by_fkey;

alter table public.chain_tx
  add constraint chain_tx_submitted_by_fkey
  foreign key (submitted_by) references public.users (id) on delete set null;

comment on column public.chain_tx.submitted_by is
  'Who triggered this transaction, for gas accounting. Nulled if the account is later removed; the authoritative actor is on chain and in action_log.';

-- otp_challenges.user_id and email_log.user_id already cascade and set null
-- respectively, from migration 004, for the same reason: a spent challenge and a
-- delivery record are operational. Nothing to change there.

do $$
begin
  raise notice 'Migration 007 complete. An account with no evidentiary trail can now be removed.';
end $$;
