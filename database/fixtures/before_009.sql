insert into public.evidence_items (id, case_id, chain_evidence_id, file_hash, file_name, kind, collected_at,
                                   officer_id, officer_aadhaar_token, registration_tx_hash, created_at)
values
  ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000c1', 7,
   '0x' || repeat('11', 32), 'anchored.jpg', 'photo', now(), '00000000-0000-4000-8000-000000000001',
   '0x' || repeat('22', 32), '0x' || repeat('33', 32), '2025-03-05T10:00:00Z'),
  ('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-0000000000c1', null,
   '0x' || repeat('44', 32), 'orphan.jpg', 'photo', now(), '00000000-0000-4000-8000-000000000001',
   '0x' || repeat('22', 32), null, '2025-03-05T11:00:00Z');
