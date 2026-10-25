do $$
declare r record;
begin
  select * into r from public.cases where id = '00000000-0000-4000-8000-0000000000c1';
  if r.case_reference <> 'NS/FIR/SHIVAJINAGAR/0042/2025' then
    raise exception 'back-filled case_reference is %', r.case_reference;
  end if;
  if r.case_key_scheme <> 'fir_v1' or r.case_salt is not null then
    raise exception 'a 1.0 case must keep its FIR key scheme';
  end if;
  if not exists (select 1 from public.fir_records f
                  where f.case_id = r.id and f.fir_year = 2025 and f.backfilled
                    and f.police_station_norm = 'shivajinagar-ps') then
    raise exception 'FIR record was not back-filled';
  end if;
  if (select theme from public.users where id = '00000000-0000-4000-8000-000000000001') <> 'light' then
    raise exception 'theme was not reset to light';
  end if;
  -- The station/year/number uniqueness is enforced.
  begin
    insert into public.fir_records (case_id, fir_number, fir_number_norm, fir_year, police_station, police_station_norm)
    values (r.id, 'x', 'SHIVAJINAGAR/0042/2025', 2025, 'Shivajinagar PS', 'shivajinagar-ps');
    raise exception 'duplicate FIR was accepted';
  exception when unique_violation then null;
  end;
  -- References are handed out in order, per station and year.
  if public.next_case_reference('Kothrud PS', 2026) <> 'NS/KOTHRUD-PS/2026/000001'
     or public.next_case_reference('Kothrud PS', 2026) <> 'NS/KOTHRUD-PS/2026/000002'
     or public.next_case_reference('Kothrud PS', 2027) <> 'NS/KOTHRUD-PS/2027/000001' then
    raise exception 'case reference serials are wrong';
  end if;
end $$;
