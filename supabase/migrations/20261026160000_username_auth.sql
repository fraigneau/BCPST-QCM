begin;

alter table public.profiles add column username text;
alter table public.profiles add constraint profiles_username_format check (
  username = lower(trim(username)) and username ~ '^[a-z0-9][a-z0-9._-]{2,23}$'
);
alter table public.profiles add constraint profiles_username_key unique(username);

create function private.username_candidate(input_name text, suffix_number integer default 1) returns text
language sql immutable parallel safe set search_path = ''
as $$
  with normalized as (
    select regexp_replace(
      regexp_replace(translate(lower(coalesce(input_name,'')),
        'àáâãäåçèéêëìíîïñòóôõöùúûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy'),
        '[^a-z0-9._-]+', '_', 'g'),
      '^[^a-z0-9]+', '', 'g') as value
  ), base as (
    select left(case when char_length(value) < 3 then 'membre_' || value else value end,24) as value from normalized
  )
  select case when suffix_number <= 1 then value
    else left(value,24 - char_length('_' || suffix_number::text)) || '_' || suffix_number::text end
  from base
$$;

revoke all on function private.username_candidate(text,integer) from public,anon,authenticated,service_role;

do $backfill$
declare
  existing_profile record;
  suffix_number integer;
  next_username text;
begin
  for existing_profile in select id,display_name from public.profiles order by created_at,id loop
    suffix_number := 1;
    loop
      next_username := private.username_candidate(existing_profile.display_name,suffix_number);
      begin
        update public.profiles set username = next_username where id = existing_profile.id;
        exit;
      exception when unique_violation then suffix_number := suffix_number + 1;
      end;
    end loop;
  end loop;
end;
$backfill$;

alter table public.profiles alter column username set not null;

create or replace function private.on_auth_user_created() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  profile_name text;
  next_username text;
  suffix_number integer := 1;
  explicit_username boolean := coalesce(new.raw_user_meta_data ? 'username',false);
begin
  profile_name := case when char_length(trim(new.raw_user_meta_data ->> 'display_name')) >= 2
    then left(trim(new.raw_user_meta_data ->> 'display_name'),60) else 'Élève' end;
  if explicit_username then
    if jsonb_typeof(new.raw_user_meta_data -> 'username') is distinct from 'string' then
      raise exception 'Choisissez un pseudo de 3 à 24 caractères : lettres sans accent, chiffres, points, tirets ou underscores.' using errcode = '22023';
    end if;
    next_username := lower(trim(new.raw_user_meta_data ->> 'username'));
    if next_username !~ '^[a-z0-9][a-z0-9._-]{2,23}$' then
      raise exception 'Choisissez un pseudo de 3 à 24 caractères : lettres sans accent, chiffres, points, tirets ou underscores.' using errcode = '22023';
    end if;
    insert into public.profiles(id,display_name,username,role) values(new.id,profile_name,next_username,'student');
  else
    loop
      next_username := private.username_candidate(profile_name,suffix_number);
      begin
        insert into public.profiles(id,display_name,username,role) values(new.id,profile_name,next_username,'student');
        exit;
      exception when unique_violation then suffix_number := suffix_number + 1;
      end;
    end loop;
  end if;
  return new;
end;
$$;

revoke all on function private.on_auth_user_created() from public,anon,authenticated,service_role;

create or replace function private.get_current_profile() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  result jsonb;
begin
  if (select auth.uid()) is null then raise exception 'Authentification requise.' using errcode = '42501'; end if;
  select jsonb_build_object('id',p.id,'name',p.display_name,'username',p.username,'email',u.email,'role',p.role,'createdAt',p.created_at)
    into result from public.profiles p join auth.users u on u.id = p.id
    where p.id = (select auth.uid()) and p.disabled_at is null;
  if result is null then raise exception 'Profil indisponible.' using errcode = '42501'; end if;
  return result;
end;
$$;

revoke all on function private.get_current_profile() from public,anon,authenticated,service_role;
grant execute on function private.get_current_profile() to authenticated;

create function private.username_available(candidate text) returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce(lower(trim(candidate)) ~ '^[a-z0-9][a-z0-9._-]{2,23}$'
    and not exists(select 1 from public.profiles where username = lower(trim(candidate))),false)
$$;

revoke all on function private.username_available(text) from public,anon,authenticated,service_role;
grant usage on schema private to anon;
grant execute on function private.username_available(text) to anon,authenticated;

create function public.qcm_username_available(candidate text) returns boolean
language sql stable security invoker set search_path = ''
as $$ select private.username_available(candidate) $$;

revoke all on function public.qcm_username_available(text) from public,anon,authenticated,service_role;
grant execute on function public.qcm_username_available(text) to anon,authenticated;

create function private.set_username(candidate text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
  profile_row public.profiles%rowtype;
  next_username text := lower(trim(candidate));
begin
  if actor is null then raise exception 'Authentification requise.' using errcode = '42501'; end if;
  select * into profile_row from public.profiles where id = actor for update;
  if not found or profile_row.disabled_at is not null then raise exception 'Profil indisponible.' using errcode = '42501'; end if;
  if next_username is null or next_username !~ '^[a-z0-9][a-z0-9._-]{2,23}$' then
    raise exception 'Choisissez un pseudo de 3 à 24 caractères : lettres sans accent, chiffres, points, tirets ou underscores.' using errcode = '22023';
  end if;
  if next_username is distinct from profile_row.username then
    update public.profiles set username = next_username where id = actor;
    insert into private.audit_events(actor_id,action,target_id,payload)
      values(actor,'user.username_changed',actor::text,jsonb_build_object('previousUsername',profile_row.username,'username',next_username));
  end if;
  return private.get_current_profile();
end;
$$;

revoke all on function private.set_username(text) from public,anon,authenticated,service_role;
grant execute on function private.set_username(text) to authenticated;

create function public.qcm_set_username(candidate text) returns jsonb
language sql security invoker set search_path = ''
as $$ select private.set_username(candidate) $$;

revoke all on function public.qcm_set_username(text) from public,anon,authenticated,service_role;
grant execute on function public.qcm_set_username(text) to authenticated;

commit;
