-- A case exactly as 1.0 created it: keyed by keccak256(FIR), FIR mandatory.
insert into public.users (id, email, password_hash, full_name, role, theme)
values ('00000000-0000-4000-8000-000000000001', 'legacy.police@example.invalid', 'x', 'Legacy Officer', 'police', 'dark');

insert into public.cases (id, fir_number, case_id_hash, title, offence_type, police_station, registered_by, registered_at)
values ('00000000-0000-4000-8000-0000000000c1', 'SHIVAJINAGAR/0042/2025',
        '0x' || repeat('ab', 32), 'Legacy theft', 'Theft', 'Shivajinagar PS',
        '00000000-0000-4000-8000-000000000001', '2025-03-04T10:00:00Z');
