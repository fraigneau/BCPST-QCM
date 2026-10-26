begin;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

create function private.valid_answer_indices(input_indices smallint[], allow_empty boolean default false) returns boolean
language sql immutable parallel safe set search_path = ''
as $$
  select case
    when input_indices is null then false
    when cardinality(input_indices) = 0 then allow_empty
    when array_ndims(input_indices) <> 1 then false
    else cardinality(input_indices) <= 4
      and array_position(input_indices, null) is null
      and input_indices <@ array[0,1,2,3]::smallint[]
      and (select count(distinct value) = count(*) from unnest(input_indices) value)
  end
$$;

create function private.valid_question_options(input_options text[]) returns boolean
language sql immutable parallel safe set search_path = ''
as $$
  select input_options is not null and array_ndims(input_options) = 1 and cardinality(input_options) = 4
    and (select count(*) filter(where value is not null and char_length(trim(value)) between 1 and 1000) = 4
      and count(distinct lower(trim(value))) = 4 from unnest(input_options) value)
$$;

revoke all on function private.valid_answer_indices(smallint[], boolean) from public, anon, authenticated;
revoke all on function private.valid_question_options(text[]) from public, anon, authenticated;
grant execute on function private.valid_answer_indices(smallint[], boolean) to service_role;
grant execute on function private.valid_question_options(text[]) to service_role;

create type public.app_role as enum ('student', 'contributor', 'admin');
create type public.question_status as enum ('draft', 'pending', 'published', 'rejected');
create type public.question_difficulty as enum ('easy', 'medium', 'hard');
create type public.game_status as enum ('waiting', 'playing', 'finished', 'abandoned');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 2 and 60),
  role public.app_role not null default 'student',
  disabled_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.chapters (
  id text primary key,
  name text not null,
  short_name text not null,
  description text not null,
  color text not null,
  icon text not null,
  sort_order integer not null default 0
);

create table public.questions (
  id uuid primary key default gen_random_uuid(),
  chapter_id text not null references public.chapters(id),
  author_id uuid not null references public.profiles(id),
  difficulty public.question_difficulty not null,
  prompt text not null check (char_length(trim(prompt)) between 10 and 5000),
  options text[] not null check (private.valid_question_options(options)),
  image_path text,
  status public.question_status not null default 'draft',
  revision integer not null default 1 check (revision > 0),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table private.question_keys (
  question_id uuid primary key references public.questions(id) on delete cascade,
  correct_answers smallint[] not null check (private.valid_answer_indices(correct_answers)),
  explanation text not null check (char_length(explanation) between 10 and 10000)
);

create table private.question_reviews (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.questions(id),
  reviewer_id uuid not null references public.profiles(id),
  revision integer not null check (revision > 0),
  decision public.question_status not null check (decision in ('published', 'rejected')),
  note text not null default '',
  created_at timestamptz not null default now(),
  unique(question_id, revision)
);

create table public.games (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references public.profiles(id),
  invitation_code text unique,
  mode text not null check (mode in ('solo', 'multi')),
  status public.game_status not null default 'waiting',
  phase text not null default 'question' check (phase in ('question', 'correction')),
  question_index integer not null default 0 check (question_index >= 0),
  question_count integer not null check (question_count between 1 and 50),
  question_duration_ms integer not null default 30000 check (question_duration_ms between 5000 and 120000),
  question_started_at timestamptz,
  deadline timestamptz,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  check (question_index < question_count),
  check (mode <> 'solo' or deadline is null),
  check (deadline is null or question_started_at is not null and deadline > question_started_at),
  check (mode <> 'multi' or status <> 'playing' or phase <> 'question' or (deadline is not null and question_started_at is not null))
);

create table public.game_players (
  game_id uuid not null references public.games(id) on delete cascade,
  player_id uuid not null references public.profiles(id),
  joined_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key(game_id, player_id)
);

create table private.game_questions (
  game_id uuid not null references public.games(id) on delete cascade,
  position integer not null check (position >= 0),
  question_id uuid not null references public.questions(id),
  chapter_id text not null references public.chapters(id),
  public_snapshot jsonb not null,
  correct_answers smallint[] not null check (private.valid_answer_indices(correct_answers)),
  explanation text not null,
  primary key(game_id, position),
  unique(game_id, question_id)
);

create table public.submissions (
  game_id uuid not null,
  player_id uuid not null,
  question_index integer not null,
  selected smallint[] not null check (private.valid_answer_indices(selected, true)),
  received_at timestamptz not null default now(),
  elapsed_ms integer not null check (elapsed_ms >= 0),
  is_correct boolean not null,
  points integer not null check (points between 0 and 150),
  timed_out boolean not null default false,
  primary key(game_id, player_id, question_index),
  foreign key(game_id, player_id) references public.game_players(game_id, player_id),
  foreign key(game_id, question_index) references private.game_questions(game_id, position),
  check ((is_correct and not timed_out and points between 100 and 150) or (not is_correct and points = 0))
);

create table public.chapter_results (
  game_id uuid not null references public.games(id),
  player_id uuid not null references public.profiles(id),
  chapter_id text not null references public.chapters(id),
  points integer not null check (points >= 0),
  answered integer not null check (answered >= 0),
  correct integer not null check (correct between 0 and answered),
  created_at timestamptz not null default now(),
  primary key(game_id, player_id, chapter_id),
  foreign key(game_id, player_id) references public.game_players(game_id, player_id)
);

create table private.audit_events (
  id bigint generated always as identity primary key,
  actor_id uuid references public.profiles(id),
  action text not null,
  target_id text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index questions_published_chapter_idx on public.questions(chapter_id, difficulty) where status = 'published' and deleted_at is null;
create index questions_author_status_idx on public.questions(author_id, status);
create index question_reviews_reviewer_idx on private.question_reviews(reviewer_id);
create index games_host_idx on public.games(host_id);
create index game_players_player_idx on public.game_players(player_id, game_id);
create index game_questions_question_idx on private.game_questions(question_id);
create index game_questions_chapter_idx on private.game_questions(chapter_id);
create index submissions_player_idx on public.submissions(player_id, received_at);
create index submissions_game_question_idx on public.submissions(game_id, question_index);
create index chapter_results_leaderboard_idx on public.chapter_results(chapter_id, player_id);
create index chapter_results_player_idx on public.chapter_results(player_id, chapter_id);
create index audit_events_actor_idx on private.audit_events(actor_id, created_at);

create function private.current_role() returns public.app_role
language sql stable security definer set search_path = ''
as $$
  select role from public.profiles where id = (select auth.uid()) and disabled_at is null
$$;

revoke all on function private.current_role() from public, anon;
grant execute on function private.current_role() to authenticated;

create function private.is_game_member(target uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists(select 1 from public.game_players where game_id = target and player_id = (select auth.uid()))
    and private.current_role() is not null
$$;

revoke all on function private.is_game_member(uuid) from public, anon;
grant execute on function private.is_game_member(uuid) to authenticated;

create function private.on_auth_user_created() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles(id, display_name, role)
  values(new.id, case when char_length(trim(new.raw_user_meta_data ->> 'display_name')) >= 2 then left(trim(new.raw_user_meta_data ->> 'display_name'), 60) else 'Élève' end, 'student');
  return new;
end;
$$;

revoke all on function private.on_auth_user_created() from public, anon, authenticated;
create trigger create_profile_after_signup after insert on auth.users for each row execute function private.on_auth_user_created();

create function public.current_profile() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  result jsonb;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentification requise.' using errcode = '42501';
  end if;
  select jsonb_build_object('id', p.id, 'name', p.display_name, 'email', u.email, 'role', p.role, 'createdAt', p.created_at)
    into result
    from public.profiles p join auth.users u on u.id = p.id
    where p.id = (select auth.uid()) and p.disabled_at is null;
  if result is null then
    raise exception 'Profil indisponible.' using errcode = '42501';
  end if;
  return result;
end;
$$;

revoke all on function public.current_profile() from public, anon;
grant execute on function public.current_profile() to authenticated;

alter table public.profiles enable row level security;
alter table public.chapters enable row level security;
alter table public.questions enable row level security;
alter table public.games enable row level security;
alter table public.game_players enable row level security;
alter table public.submissions enable row level security;
alter table public.chapter_results enable row level security;
alter table private.question_keys enable row level security;
alter table private.question_reviews enable row level security;
alter table private.game_questions enable row level security;
alter table private.audit_events enable row level security;

revoke all on public.profiles, public.chapters, public.questions, public.games, public.game_players, public.submissions, public.chapter_results from anon, authenticated;
revoke all on private.question_keys, private.question_reviews, private.game_questions, private.audit_events from anon, authenticated;
grant select on public.profiles, public.chapters, public.questions, public.games, public.game_players, public.submissions, public.chapter_results to authenticated;
grant select, insert, update, delete on public.profiles, public.chapters, public.questions, public.games, public.game_players, public.submissions, public.chapter_results to service_role;
grant select, insert, update, delete on private.question_keys, private.question_reviews, private.game_questions, private.audit_events to service_role;
grant usage on schema private to service_role;
grant usage, select on sequence private.audit_events_id_seq to service_role;

create policy profiles_read on public.profiles for select to authenticated using ((id = (select auth.uid()) and (select private.current_role()) is not null) or (select private.current_role()) = 'admin');
create policy chapters_read on public.chapters for select to authenticated using ((select private.current_role()) is not null);
create policy questions_read on public.questions for select to authenticated using (
  (select private.current_role()) is not null and (
    (status = 'published' and deleted_at is null)
    or author_id = (select auth.uid())
    or (select private.current_role()) = 'admin'
  )
);
create policy games_read on public.games for select to authenticated using (private.is_game_member(id) or (select private.current_role()) = 'admin');
create policy players_read on public.game_players for select to authenticated using (private.is_game_member(game_id) or (select private.current_role()) = 'admin');
create policy submissions_read on public.submissions for select to authenticated using (
  (select private.current_role()) = 'admin'
  or (player_id = (select auth.uid()) and private.is_game_member(game_id) and exists(
    select 1 from public.games g where g.id = submissions.game_id and submissions.question_index <= g.question_index
      and (g.mode = 'solo' or g.status = 'finished' or submissions.question_index < g.question_index or g.phase = 'correction')
  ))
);
create policy results_read on public.chapter_results for select to authenticated using (
  (select private.current_role()) = 'admin'
  or (player_id = (select auth.uid()) and private.is_game_member(game_id)
    and exists(select 1 from public.games g where g.id = game_id and g.status = 'finished'))
);

create function public.chapter_leaderboard(target_chapter text)
returns table(player_id uuid, display_name text, points bigint, answered bigint, correct bigint, "position" bigint)
language sql stable security definer set search_path = ''
as $$
  with totals as (
    select p.id, p.display_name,
      coalesce(sum(r.points), 0)::bigint as points,
      coalesce(sum(r.answered), 0)::bigint as answered,
      coalesce(sum(r.correct), 0)::bigint as correct
    from public.profiles p
    left join public.chapter_results r on r.player_id = p.id and r.chapter_id = target_chapter
      and exists(select 1 from public.games g where g.id = r.game_id and g.status = 'finished')
    where p.disabled_at is null and private.current_role() is not null
      and exists(select 1 from public.chapters where id = target_chapter)
    group by p.id, p.display_name
  )
  select id, totals.display_name, totals.points, totals.answered, totals.correct,
    rank() over(order by totals.points desc, case when totals.answered > 0 then round(totals.correct::numeric / totals.answered * 100) else 0 end desc)
  from totals order by totals.points desc, case when totals.answered > 0 then round(totals.correct::numeric / totals.answered * 100) else 0 end desc, totals.display_name, id
$$;

revoke all on function public.chapter_leaderboard(text) from public, anon;
grant execute on function public.chapter_leaderboard(text) to authenticated;

insert into public.chapters(id, name, short_name, description, color, icon, sort_order) values
  ('cellulaire', 'Biologie cellulaire et génétique', 'Cellule & génétique', 'Du fonctionnement cellulaire à la transmission du vivant.', '#718b69', 'Cell', 0),
  ('vegetale', 'Biologie végétale', 'Biologie végétale', 'Comprendre les plantes, de la racine à la photosynthèse.', '#a2a86c', 'Leaf', 1),
  ('physiologie', 'Physiologie', 'Physiologie', 'Explorer les fonctions et les régulations des organismes.', '#bd8c78', 'Heart', 2),
  ('geologie', 'Géologie', 'Géologie', 'Lire les roches et décrypter la dynamique de la Terre.', '#b59b70', 'Mountain', 3),
  ('ecologie', 'Écologie', 'Écologie', 'Relier les populations, les écosystèmes et leur évolution.', '#7b9b98', 'Sprout', 4);

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values('question-images', 'question-images', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict(id) do nothing;

create policy image_owner_upload on storage.objects for insert to authenticated with check (
  bucket_id = 'question-images'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and (select private.current_role()) in ('contributor', 'admin')
);

create policy image_owner_read on storage.objects for select to authenticated using (
  bucket_id = 'question-images'
  and ((select private.current_role()) = 'admin'
    or ((storage.foldername(name))[1] = (select auth.uid())::text and (select private.current_role()) = 'contributor')
    or ((select private.current_role()) is not null and exists(
      select 1 from public.questions q where q.image_path = name and q.status = 'published' and q.deleted_at is null
    )))
);

commit;
