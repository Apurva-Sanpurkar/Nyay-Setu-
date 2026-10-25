do $$
declare r record;
begin
  for r in select * from public.evidence_items loop
    if r.public_ref !~ '^NSE-[0-9A-Z]{32}$' then raise exception 'bad public_ref %', r.public_ref; end if;
    if r.anchored_digest <> r.file_hash then raise exception 'anchored_digest not back-filled'; end if;
    if r.source <> 'upload' or r.anchor_mode <> 'file' then raise exception '1.0 items must be file-anchored uploads'; end if;
  end loop;
  if (select count(distinct public_ref) from public.evidence_items) <> (select count(*) from public.evidence_items) then
    raise exception 'public refs are not unique';
  end if;
  begin
    update public.evidence_items set anchor_mode = 'manifest' where id = '00000000-0000-4000-8000-0000000000e1';
    raise exception 'manifest mode without a manifest was accepted';
  exception when check_violation then null;
  end;
end $$;
