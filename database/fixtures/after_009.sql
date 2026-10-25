do $$
declare a1 record; a2 record;
begin
  select a.* into a1 from public.anchors a join public.evidence_items e on e.anchor_id = a.id
   where e.id = '00000000-0000-4000-8000-0000000000e1';
  select a.* into a2 from public.anchors a join public.evidence_items e on e.anchor_id = a.id
   where e.id = '00000000-0000-4000-8000-0000000000e2';

  if a1.state <> 'SUBMITTED' or a1.chain_record_id <> 7 or a1.expected_digest <> '0x' || repeat('11', 32) then
    raise exception 'anchored item back-filled wrongly: % %', a1.state, a1.chain_record_id;
  end if;
  if a2.state <> 'SYNC_ERROR' or a2.failure_code <> 'NEVER_ANCHORED' then
    raise exception 'unanchored item back-filled wrongly: %', a2.state;
  end if;
  if (select count(*) from public.anchor_state_events where reason_code = 'BACKFILL_2_0') <> 2 then
    raise exception 'back-fill history missing';
  end if;

  -- CONFIRMED without proof is impossible at the database level.
  begin
    update public.anchors set state = 'CONFIRMED' where id = a2.id;
    raise exception 'CONFIRMED without a receipt was accepted';
  exception when check_violation then null;
  end;

  -- History cannot be rewritten.
  begin
    update public.anchor_state_events set reason = 'edited' where anchor_id = a1.id;
    raise exception 'anchor_state_events accepted an UPDATE';
  exception when raise_exception then
    if sqlerrm not like '%append-only%' then raise; end if;
  end;
end $$;
