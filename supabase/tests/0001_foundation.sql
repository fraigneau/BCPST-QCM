begin;

create temporary table foundation_fixture(label text primary key, id uuid not null default gen_random_uuid());
insert into foundation_fixture(label) values('student'), ('other'), ('disabled'), ('game'), ('question'), ('future_question');
grant select on foundation_fixture to authenticated, anon, service_role;

insert into auth.users(id, email, aud, role, raw_user_meta_data, raw_app_meta_data)
select id, label || '-' || id::text || '@foundation.invalid', 'authenticated', 'authenticated',
  jsonb_build_object('display_name', 'Test ' || label, 'role', 'admin'), '{}'::jsonb
from foundation_fixture where label in ('student', 'other', 'disabled');

update public.profiles set disabled_at = now() where id = (select id from foundation_fixture where label = 'disabled');

do $$
declare
  invalid_indices smallint[];
  invalid_options text[];
begin
  if (select count(*) from public.profiles where id in (select id from foundation_fixture where label in ('student', 'other', 'disabled')) and role = 'student') <> 3 then
    raise exception 'FAIL: signup role must ignore user metadata';
  end if;
  if not private.valid_answer_indices(array[0,2]::smallint[]) or not private.valid_answer_indices(array[]::smallint[], true) then
    raise exception 'FAIL: valid answer sets rejected';
  end if;
  foreach invalid_indices slice 1 in array array[array[0,0], array[0,null], array[-1,0], array[0,4]]::smallint[][] loop
    if private.valid_answer_indices(invalid_indices) then raise exception 'FAIL: invalid indices accepted'; end if;
  end loop;
  if private.valid_answer_indices(null::smallint[]) or private.valid_answer_indices(array[]::smallint[]) or private.valid_answer_indices(array[array[0,1],array[2,3]]::smallint[]) then
    raise exception 'FAIL: null, empty or multidimensional answer key accepted';
  end if;
  if not private.valid_question_options(array['A','B','C','D']) then raise exception 'FAIL: valid options rejected'; end if;
  foreach invalid_options slice 1 in array array[array['A','a','C','D'],array['A',null,'C','D'],array['A',' ','C','D']]::text[][] loop
    if private.valid_question_options(invalid_options) then raise exception 'FAIL: invalid options accepted'; end if;
  end loop;
  if has_function_privilege('anon', 'public.current_profile()', 'execute') or has_function_privilege('anon', 'public.chapter_leaderboard(text)', 'execute') then
    raise exception 'FAIL: anonymous function access';
  end if;
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public','private') and p.proname in ('current_profile','chapter_leaderboard','current_role','is_game_member','on_auth_user_created','valid_answer_indices','valid_question_options')
      and not coalesce(p.proconfig @> array['search_path=""'], false)) then
    raise exception 'FAIL: function search_path is not empty';
  end if;
end;
$$;

insert into public.questions(id, chapter_id, author_id, difficulty, prompt, options, status)
select f.id, 'cellulaire', u.id, 'easy', 'Question de test de la fondation ' || f.label, array['A','B','C','D'], 'published'
from foundation_fixture f cross join foundation_fixture u where f.label in ('question','future_question') and u.label = 'other';

insert into private.question_keys(question_id, correct_answers, explanation)
select id, array[0]::smallint[], 'Une explication de test suffisamment longue.' from foundation_fixture where label in ('question','future_question');

do $$
begin
  begin
    update private.question_keys set correct_answers = array[0,0]::smallint[] where question_id = (select id from foundation_fixture where label = 'question');
    raise exception 'FAIL: duplicate answer key write accepted';
  exception when check_violation then null;
  end;
  begin
    update private.question_keys set correct_answers = array[0,null]::smallint[] where question_id = (select id from foundation_fixture where label = 'question');
    raise exception 'FAIL: null answer key element accepted';
  exception when check_violation then null;
  end;
  begin
    update public.questions set options = array['A','a','C','D'] where id = (select id from foundation_fixture where label = 'question');
    raise exception 'FAIL: duplicate options write accepted';
  exception when check_violation then null;
  end;
  begin
    update public.questions set options = array['A',null,'C','D'] where id = (select id from foundation_fixture where label = 'question');
    raise exception 'FAIL: null option write accepted';
  exception when check_violation then null;
  end;
end;
$$;

insert into public.games(id, host_id, mode, status, phase, question_count, question_started_at, deadline)
select g.id, u.id, 'multi', 'playing', 'question', 2, now(), now() + interval '30 seconds'
from foundation_fixture g cross join foundation_fixture u where g.label = 'game' and u.label = 'student';

insert into public.game_players(game_id, player_id)
select g.id, u.id from foundation_fixture g cross join foundation_fixture u where g.label = 'game' and u.label in ('student','other');

insert into private.game_questions(game_id, position, question_id, chapter_id, public_snapshot, correct_answers, explanation)
select g.id, case q.label when 'question' then 0 else 1 end, q.id, 'cellulaire',
  jsonb_build_object('id',q.id,'prompt','Question publique','options',array['A','B','C','D']), array[0]::smallint[], 'Explication privée de test.'
from foundation_fixture g cross join foundation_fixture q where g.label = 'game' and q.label in ('question','future_question');

insert into public.submissions(game_id, player_id, question_index, selected, elapsed_ms, is_correct, points)
select g.id, u.id, seq.position, array[0]::smallint[], 0, true, 150
from foundation_fixture g cross join foundation_fixture u cross join generate_series(0,1) as seq(position) where g.label = 'game' and u.label = 'student';

insert into public.chapter_results(game_id, player_id, chapter_id, points, answered, correct)
select g.id, u.id, 'cellulaire', 300, 2, 2 from foundation_fixture g cross join foundation_fixture u where g.label = 'game' and u.label = 'student';

set local role authenticated;
select set_config('request.jwt.claim.sub', (select id::text from foundation_fixture where label = 'student'), true);
select set_config('request.jwt.claims', jsonb_build_object('sub',(select id from foundation_fixture where label = 'student'),'role','authenticated','user_metadata',jsonb_build_object('role','admin'))::text, true);

do $$
declare
  profile jsonb;
begin
  if (select count(*) from public.chapters) <> 5 then raise exception 'FAIL: five chapters expected'; end if;
  if (select count(*) from public.profiles) <> 1 then raise exception 'FAIL: other profiles visible'; end if;
  profile := public.current_profile();
  if profile ->> 'id' <> (select id::text from foundation_fixture where label = 'student') or profile ->> 'role' <> 'student' then
    raise exception 'FAIL: current profile identity or role';
  end if;
  if profile ->> 'email' <> 'student-' || (select id::text from foundation_fixture where label = 'student') || '@foundation.invalid'
    or (select count(*) from jsonb_object_keys(profile)) <> 6
    or not profile ?& array['id','name','username','email','role','createdAt'] then
    raise exception 'FAIL: current profile payload or email';
  end if;
  if (select count(*) from public.submissions) <> 0 then raise exception 'FAIL: current multi answer leaked before correction'; end if;
  if (select count(*) from public.chapter_results) <> 0 then raise exception 'FAIL: unfinished results visible'; end if;
  if (select points from public.chapter_leaderboard('cellulaire') where player_id = (select id from foundation_fixture where label = 'student')) <> 0 then
    raise exception 'FAIL: unfinished points leaked through leaderboard';
  end if;
  if (select count(*) from public.chapter_leaderboard('cellulaire') where player_id in (select id from foundation_fixture where label in ('student','other'))) <> 2 then
    raise exception 'FAIL: zero-point players missing';
  end if;
  begin
    update public.profiles set role = 'admin' where id = (select id from foundation_fixture where label = 'student');
    raise exception 'FAIL: role escalation allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.questions(chapter_id, author_id, difficulty, prompt, options) values('cellulaire', auth.uid(), 'easy', 'Question interdite de test', array['A','B','C','D']);
    raise exception 'FAIL: direct question write allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.submissions set points = 150;
    raise exception 'FAIL: direct score write allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.chapter_results set points = 999999;
    raise exception 'FAIL: direct results write allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from private.question_keys;
    raise exception 'FAIL: private answer keys readable';
  exception when insufficient_privilege then null;
  end;
  begin
    perform email from auth.users;
    raise exception 'FAIL: auth emails directly readable';
  exception when insufficient_privilege then null;
  end;
end;
$$;

reset role;
update public.games set phase = 'correction' where id = (select id from foundation_fixture where label = 'game');
set local role authenticated;

do $$
begin
  if (select count(*) from public.submissions) <> 1 then raise exception 'FAIL: correction visibility includes future answers or hides current'; end if;
end;
$$;

reset role;
update public.games set phase = 'question', question_index = 1, question_started_at = now(), deadline = now() + interval '30 seconds' where id = (select id from foundation_fixture where label = 'game');
set local role authenticated;

do $$
begin
  if (select count(*) from public.submissions) <> 1 or (select min(question_index) from public.submissions) <> 0 then
    raise exception 'FAIL: previous answer must remain visible while current answer is hidden';
  end if;
end;
$$;

reset role;
update public.games set status = 'finished', finished_at = now(), deadline = null where id = (select id from foundation_fixture where label = 'game');
set local role authenticated;

do $$
begin
  if (select count(*) from public.submissions) <> 2 then raise exception 'FAIL: finished answers not visible'; end if;
  if (select count(*) from public.chapter_results) <> 1 then raise exception 'FAIL: finished result not visible'; end if;
  if (select points from public.chapter_leaderboard('cellulaire') where player_id = (select id from foundation_fixture where label = 'student')) <> 300 then
    raise exception 'FAIL: finished leaderboard points incorrect';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', (select id::text from foundation_fixture where label = 'disabled'), true);
select set_config('request.jwt.claims', jsonb_build_object('sub',(select id from foundation_fixture where label = 'disabled'),'role','authenticated')::text, true);

do $$
begin
  begin
    perform public.current_profile();
    raise exception 'FAIL: disabled profile RPC allowed';
  exception when insufficient_privilege then null;
  end;
  if (select count(*) from public.chapters) <> 0 or (select count(*) from public.profiles) <> 0 then
    raise exception 'FAIL: disabled profile can read protected data';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{}', true);

do $$
begin
  begin
    perform public.current_profile();
    raise exception 'FAIL: missing identity allowed';
  exception when insufficient_privilege then null;
  end;
end;
$$;

reset role;
set local role anon;

do $$
begin
  begin
    perform public.current_profile();
    raise exception 'FAIL: anonymous profile RPC allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.chapters;
    raise exception 'FAIL: anonymous chapter read allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.profiles;
    raise exception 'FAIL: anonymous profile read allowed';
  exception when insufficient_privilege then null;
  end;
end;
$$;

reset role;
rollback;

select 'passed' as foundation_test_status, 'Fixtures, accounts and game data rolled back.' as detail;
