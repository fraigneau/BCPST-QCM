begin;

create temporary table username_fixture(label text primary key,id uuid not null default gen_random_uuid(),username text,data jsonb);
insert into username_fixture(label) values('admin'),('student'),('generated_a'),('generated_b'),('claim');
update username_fixture set username = 'u_' || left(replace(id::text,'-',''),16);
grant select,update on username_fixture to authenticated,anon;

insert into auth.users(id,email,aud,role,raw_user_meta_data,raw_app_meta_data)
select id,label || '-' || id::text || '@username-test.invalid','authenticated','authenticated',
  jsonb_build_object('display_name','Username ' || label,'username','  ' || upper(username) || '  ','role','admin'),'{}'::jsonb
from username_fixture where label in ('admin','student');

insert into auth.users(id,email,aud,role,raw_user_meta_data,raw_app_meta_data)
select u.id,u.label || '-' || u.id::text || '@username-test.invalid','authenticated','authenticated',
  jsonb_build_object('display_name','Étude ' || left(c.id::text,8),'role','admin'),'{}'::jsonb
from username_fixture u cross join username_fixture c where u.label in ('generated_a','generated_b') and c.label='claim';

do $$
declare
  duplicate_id uuid := gen_random_uuid();
  invalid_id uuid := gen_random_uuid();
begin
  if exists(select 1 from public.profiles p join username_fixture f on f.id=p.id where p.role <> 'student') then
    raise exception 'FAIL: signup metadata granted a role';
  end if;
  if exists(select 1 from public.profiles p join username_fixture f on f.id=p.id where f.label in ('admin','student') and p.username <> f.username) then
    raise exception 'FAIL: explicit username was not normalized';
  end if;
  if (select count(distinct p.username) from public.profiles p join username_fixture f on f.id=p.id where f.label in ('generated_a','generated_b')) <> 2
    or exists(select 1 from public.profiles p join username_fixture f on f.id=p.id where p.username !~ '^[a-z0-9][a-z0-9._-]{2,23}$') then
    raise exception 'FAIL: generated username collision or invalid format';
  end if;
  begin
    insert into auth.users(id,email,aud,role,raw_user_meta_data,raw_app_meta_data)
    select duplicate_id,'duplicate-' || duplicate_id::text || '@username-test.invalid','authenticated','authenticated',
      jsonb_build_object('display_name','Duplicate user','username',upper(username)),'{}'::jsonb from username_fixture where label='student';
    raise exception 'FAIL: duplicate username accepted by signup trigger';
  exception when unique_violation then null;
  end;
  if exists(select 1 from auth.users where id=duplicate_id) or exists(select 1 from public.profiles where id=duplicate_id) then
    raise exception 'FAIL: failed signup left an identity behind';
  end if;
  begin
    insert into auth.users(id,email,aud,role,raw_user_meta_data,raw_app_meta_data)
    values(invalid_id,'invalid-' || invalid_id::text || '@username-test.invalid','authenticated','authenticated',
      jsonb_build_object('display_name','Invalid user','username','bad@email.test'),'{}'::jsonb);
    raise exception 'FAIL: email or invalid username accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    update public.profiles set username=upper(username) where id=(select id from username_fixture where label='student');
    raise exception 'FAIL: noncanonical username stored';
  exception when check_violation then null;
  end;
  if has_function_privilege('anon','private.username_candidate(text,integer)','execute')
    or has_function_privilege('anon','private.get_current_profile()','execute')
    or has_function_privilege('anon','public.qcm_set_username(text)','execute')
    or not has_function_privilege('anon','public.qcm_username_available(text)','execute')
    or (select prosecdef from pg_proc where oid='public.qcm_username_available(text)'::regprocedure)
    or (select prosecdef from pg_proc where oid='public.qcm_set_username(text)'::regprocedure) then
    raise exception 'FAIL: username grants or invoker wrappers';
  end if;
end;
$$;

update public.profiles set role='admin' where id=(select id from username_fixture where label='admin');

set local role anon;
do $$
begin
  if public.qcm_username_available((select upper(username) from username_fixture where label='student'))
    or public.qcm_username_available(null)
    or public.qcm_username_available('ab')
    or public.qcm_username_available('a space')
    or public.qcm_username_available('bad@email.test')
    or public.qcm_username_available(repeat('a',25))
    or not public.qcm_username_available((select username from username_fixture where label='claim')) then
    raise exception 'FAIL: anonymous availability contract';
  end if;
  if pg_typeof(public.qcm_username_available('test')) <> 'boolean'::regtype then
    raise exception 'FAIL: availability returned account details';
  end if;
  begin
    perform public.qcm_set_username('cannot-set');
    raise exception 'FAIL: anonymous profile mutation';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.profiles;
    raise exception 'FAIL: anonymous profile directory';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

select set_config('request.jwt.claim.sub',(select id::text from username_fixture where label='admin'),true);
select set_config('request.jwt.claims',jsonb_build_object('sub',(select id from username_fixture where label='admin'),'role','authenticated')::text,true);
set local role authenticated;

do $$
declare
  next_username text := (select username from username_fixture where label='claim');
  result jsonb;
begin
  result := public.qcm_set_username('  ' || upper(next_username) || '  ');
  if result->>'id' <> (select id::text from username_fixture where label='admin')
    or result->>'username' <> next_username
    or result->>'role' <> 'admin'
    or result->>'name' <> 'Username admin'
    or result->>'email' <> (select 'admin-' || id::text || '@username-test.invalid' from username_fixture where label='admin') then
    raise exception 'FAIL: own username update or profile contract';
  end if;
  if public.current_profile()->>'username' <> next_username then raise exception 'FAIL: current_profile username missing'; end if;
  perform public.qcm_set_username(upper(next_username));
  begin
    perform public.qcm_set_username((select upper(username) from username_fixture where label='student'));
    raise exception 'FAIL: duplicate username accepted by RPC';
  exception when unique_violation then null;
  end;
  begin
    perform public.qcm_set_username('_bad-start');
    raise exception 'FAIL: invalid username accepted by RPC';
  exception when invalid_parameter_value then null;
  end;
  begin
    update public.profiles set username='malicious' where id=(select id from username_fixture where label='student');
    raise exception 'FAIL: direct profile mutation allowed';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

do $$
begin
  if (select count(*) from private.audit_events where actor_id=(select id from username_fixture where label='admin') and action='user.username_changed') <> 1 then
    raise exception 'FAIL: username audit absent or duplicated by no-op';
  end if;
  if (select username from public.profiles where id=(select id from username_fixture where label='student')) <> (select username from username_fixture where label='student')
    or (select role from public.profiles where id=(select id from username_fixture where label='admin')) <> 'admin' then
    raise exception 'FAIL: another profile or role was changed';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub',(select id::text from username_fixture where label='student'),true);
select set_config('request.jwt.claims',jsonb_build_object('sub',(select id from username_fixture where label='student'),'role','authenticated')::text,true);
set local role authenticated;
do $$
begin
  begin
    perform public.qcm_set_username((select upper(username) from username_fixture where label='claim'));
    raise exception 'FAIL: database uniqueness did not reject a claim taken after availability check';
  exception when unique_violation then null;
  end;
end;
$$;
reset role;

update public.profiles set disabled_at=clock_timestamp() where id=(select id from username_fixture where label='student');
set local role authenticated;
do $$
begin
  begin
    perform public.qcm_set_username('disabled-change');
    raise exception 'FAIL: disabled profile changed username';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.current_profile();
    raise exception 'FAIL: disabled profile disclosed';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

set local role anon;
do $$
begin
  if public.qcm_username_available((select username from username_fixture where label='student')) then
    raise exception 'FAIL: disabled username became claimable';
  end if;
end;
$$;
reset role;

rollback;
select 'passed' as username_auth_test_status,'Username fixtures and Auth users rolled back.' as detail;
