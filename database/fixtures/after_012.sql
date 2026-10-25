do $$
declare v_id uuid;
begin
  if not exists (select 1 from public.document_templates where template_key = 'section63_certificate') then
    raise exception 'Section 63 template not seeded';
  end if;

  insert into public.approval_requests (action, subject_type, subject_id, case_id, requested_by, requested_role, reason)
  values ('case_close', 'case', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000c1',
          '00000000-0000-4000-8000-000000000001', 'police', 'Investigation complete; closing.')
  returning id into v_id;

  begin
    update public.approval_requests set approver_id = requested_by, status = 'approved' where id = v_id;
    raise exception 'the same person approved their own request';
  exception when check_violation then null;
  end;

  begin
    update public.discrepancy_alerts set status = 'resolved' where false;
    insert into public.discrepancy_alerts (kind, severity, explanation, dedupe_key, status)
    values ('HASH_MISMATCH', 'serious', 'x', 'fixture-1', 'resolved');
    raise exception 'an alert was resolved without a written resolution';
  exception when check_violation then null;
  end;
end $$;
