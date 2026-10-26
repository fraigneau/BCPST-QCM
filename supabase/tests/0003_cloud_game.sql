begin;

create temporary table cloud_game_fixture(label text primary key,id uuid not null default gen_random_uuid());
insert into cloud_game_fixture(label) values('host'),('guest'),('question_a'),('question_b');
create temporary table cloud_game_state(label text primary key,body jsonb not null);
grant select on cloud_game_fixture to authenticated,anon;
grant select,insert,update on cloud_game_state to authenticated;

insert into auth.users(id,email,aud,role,raw_user_meta_data,raw_app_meta_data)
select id,label || '-' || id::text || '@cloud-game.invalid','authenticated','authenticated',jsonb_build_object('display_name','Cloud ' || label,'role','admin'),'{}'::jsonb
from cloud_game_fixture where label in ('host','guest');

insert into public.chapters(id,name,short_name,description,color,icon,sort_order)
select 'test-' || label || '-' || id::text,'Chapitre de test ' || label,label,'Fixture transactionnelle.','#21664b','Cell',100
from cloud_game_fixture where label in ('question_a','question_b');

insert into public.questions(id,chapter_id,author_id,difficulty,prompt,options,status)
select q.id,'test-' || q.label || '-' || q.id::text,h.id,'medium','Question pédagogique ' || q.label || ' initiale ?',array['Première proposition','Deuxième proposition','Troisième proposition','Quatrième proposition'],'published'
from cloud_game_fixture q cross join cloud_game_fixture h where q.label in ('question_a','question_b') and h.label = 'host';
insert into private.question_keys(question_id,correct_answers,explanation)
select id,case when label = 'question_a' then array[0,2]::smallint[] else array[1]::smallint[] end,'Explication pédagogique initiale pour la correction.'
from cloud_game_fixture where label in ('question_a','question_b');

do $$
begin
  if has_function_privilege('anon','public.qcm_game(text,jsonb)','execute') or has_function_privilege('anon','private.app_game(text,jsonb)','execute') then raise exception 'FAIL: anonymous RPC privilege'; end if;
  if has_function_privilege('authenticated','private.game_advance(uuid,timestamp with time zone)','execute') or has_function_privilege('authenticated','private.game_answer_json(uuid,uuid,integer)','execute') or has_function_privilege('authenticated','private.player_progress(uuid)','execute') then raise exception 'FAIL: private helper privilege'; end if;
  if (select prosecdef from pg_proc where oid = 'public.qcm_game(text,jsonb)'::regprocedure) then raise exception 'FAIL: public wrapper is definer'; end if;
  if not (select prosecdef from pg_proc where oid = 'private.app_game(text,jsonb)'::regprocedure) then raise exception 'FAIL: private boundary is not definer'; end if;
end;
$$;

set local role anon;
do $$
begin
  begin perform public.qcm_game('progress'); raise exception 'FAIL: anonymous gameplay'; exception when insufficient_privilege then null; end;
end;
$$;
reset role;

select set_config('request.jwt.claim.sub',(select id::text from cloud_game_fixture where label = 'host'),true);
select set_config('request.jwt.claims',jsonb_build_object('sub',(select id from cloud_game_fixture where label = 'host'),'role','authenticated')::text,true);
set local role authenticated;

do $$
declare
  selection jsonb;
  state jsonb;
begin
  select jsonb_agg('test-' || label || '-' || id::text order by label) into selection from cloud_game_fixture where label in ('question_a','question_b');
  begin perform public.qcm_game('solo',jsonb_build_object('chapterIds',jsonb_build_array('unknown-chapter'))); raise exception 'FAIL: unknown chapter accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.qcm_game('solo',jsonb_build_object('chapterIds',selection,'count',0)); raise exception 'FAIL: invalid count accepted'; exception when invalid_parameter_value then null; end;
  state := public.qcm_game('solo',jsonb_build_object('chapterIds',selection,'count',2));
  if state->>'mode' <> 'solo' or state->>'phase' <> 'question' or state->'deadline' <> 'null'::jsonb or state->'result' <> 'null'::jsonb or state->'results' <> '[]'::jsonb then raise exception 'FAIL: initial untimed solo'; end if;
  if state->'question' ? 'correctAnswers' or state->'question' ? 'explanation' or state->'question' ? 'authorId' then raise exception 'FAIL: initial answer leakage'; end if;
  insert into cloud_game_state values('solo',state);
end;
$$;
reset role;

update public.games set question_started_at = clock_timestamp() - interval '7 days' where id = (select (body->>'id')::uuid from cloud_game_state where label = 'solo');
update public.questions set prompt = 'Question modifiée après la création du quiz.' where id in (select id from cloud_game_fixture where label in ('question_a','question_b'));
update private.question_keys set explanation = 'Explication modifiée après la création du quiz.' where question_id in (select id from cloud_game_fixture where label in ('question_a','question_b'));
set local role authenticated;

do $$
declare
  state jsonb := (select body from cloud_game_state where label = 'solo');
  selection jsonb;
  initial_prompt text := state->'question'->>'prompt';
  index integer;
begin
  state := public.qcm_game('state',jsonb_build_object('gameId',state->>'id'));
  if state->'question'->>'prompt' <> initial_prompt or state->'deadline' <> 'null'::jsonb then raise exception 'FAIL: solo snapshot changed or expired'; end if;
  for index in 0..1 loop
    selection := case when (state->'question'->>'id')::uuid = (select id from cloud_game_fixture where label = 'question_a') then '[2,0]'::jsonb else '[1]'::jsonb end;
    state := public.qcm_game('answer',jsonb_build_object('gameId',state->>'id','questionId',state->'question'->>'id','selected',selection,'points',999999));
    if (state->'result'->>'points')::integer <> 100 or not (state->'result'->>'correct')::boolean or state->'deadline' <> 'null'::jsonb then raise exception 'FAIL: solo scoring'; end if;
    if index = 0 and (state->'result'->>'elapsedMs')::integer < 600000000 then raise exception 'FAIL: long solo response lost elapsed time'; end if;
    if state->'result'->>'explanation' <> 'Explication pédagogique initiale pour la correction.' then raise exception 'FAIL: correction snapshot changed'; end if;
    begin perform public.qcm_game('answer',jsonb_build_object('gameId',state->>'id','questionId',state->'question'->>'id','selected',selection)); raise exception 'FAIL: duplicate answer'; exception when unique_violation then null; end;
    state := public.qcm_game('next',jsonb_build_object('gameId',state->>'id'));
  end loop;
  if state->>'status' <> 'finished' or jsonb_array_length(state->'results') <> 2 then raise exception 'FAIL: solo completion'; end if;
  perform public.qcm_game('state',jsonb_build_object('gameId',state->>'id'));
  if (select count(*) from public.chapter_results where game_id = (state->>'id')::uuid) <> 2 or (select sum(points) from public.chapter_results where game_id = (state->>'id')::uuid) <> 200 then raise exception 'FAIL: results are not exactly once per chapter'; end if;
  state := public.qcm_game('progress');
  if (state->>'totalPoints')::integer <> 200 or (state->>'answered')::integer <> 2 or (state->>'gamesPlayed')::integer <> 1 or jsonb_array_length(state->'daily') <> 14 then raise exception 'FAIL: progress contract'; end if;
  if not exists(select 1 from jsonb_array_elements(public.qcm_game('leaderboard')) entry where entry->>'userId' = (select id::text from cloud_game_fixture where label = 'guest') and (entry->>'points')::integer = 0 and (entry->>'answered')::integer = 0) then raise exception 'FAIL: zero-score player omitted'; end if;
end;
$$;

do $$
declare
  chapters jsonb;
  state jsonb;
begin
  select jsonb_agg('test-' || label || '-' || id::text order by label) into chapters from cloud_game_fixture where label in ('question_a','question_b');
  state := public.qcm_game('create_room',jsonb_build_object('chapterIds',chapters,'count',2));
  insert into cloud_game_state values('room',state);
  if state->>'status' <> 'waiting' or state->'question' <> 'null'::jsonb or char_length(state->>'code') <> 6 then raise exception 'FAIL: waiting room contract'; end if;
  begin perform public.qcm_game('start',jsonb_build_object('gameId',state->>'id')); raise exception 'FAIL: single-player multiplayer start'; exception when object_not_in_prerequisite_state then null; end;
end;
$$;
reset role;

select set_config('request.jwt.claim.sub',(select id::text from cloud_game_fixture where label = 'guest'),true);
select set_config('request.jwt.claims',jsonb_build_object('sub',(select id from cloud_game_fixture where label = 'guest'),'role','authenticated')::text,true);
set local role authenticated;
do $$
declare
  state jsonb := (select body from cloud_game_state where label = 'room');
begin
  begin perform public.qcm_game('state',jsonb_build_object('gameId',state->>'id')); raise exception 'FAIL: outsider can read room'; exception when insufficient_privilege then null; end;
  state := public.qcm_game('join_room',jsonb_build_object('code',lower(state->>'code')));
  if jsonb_array_length(state->'players') <> 2 then raise exception 'FAIL: join room'; end if;
  begin perform public.qcm_game('start',jsonb_build_object('gameId',state->>'id')); raise exception 'FAIL: non-host start'; exception when insufficient_privilege then null; end;
end;
$$;
reset role;

select set_config('request.jwt.claim.sub',(select id::text from cloud_game_fixture where label = 'host'),true);
select set_config('request.jwt.claims',jsonb_build_object('sub',(select id from cloud_game_fixture where label = 'host'),'role','authenticated')::text,true);
set local role authenticated;
do $$
declare
  state jsonb := (select body from cloud_game_state where label = 'room');
  selection jsonb;
begin
  state := public.qcm_game('start',jsonb_build_object('gameId',state->>'id'));
  if state->'deadline' = 'null'::jsonb or state->>'status' <> 'playing' then raise exception 'FAIL: timed multiplayer start'; end if;
  begin perform public.qcm_game('answer',jsonb_build_object('gameId',state->>'id','questionId',state->'question'->>'id','selected','[0,0]'::jsonb)); raise exception 'FAIL: duplicate selection accepted'; exception when invalid_parameter_value then null; end;
  selection := case when (state->'question'->>'id')::uuid = (select id from cloud_game_fixture where label = 'question_a') then '[0,2]'::jsonb else '[1]'::jsonb end;
  state := public.qcm_game('answer',jsonb_build_object('gameId',state->>'id','questionId',state->'question'->>'id','selected',selection));
  update cloud_game_state set body = state where label = 'room';
  if state->'result' <> 'null'::jsonb or state->'results' <> '[]'::jsonb then raise exception 'FAIL: multiplayer correction leak'; end if;
  if exists(select 1 from public.submissions where game_id = (state->>'id')::uuid) then raise exception 'FAIL: raw submissions leak before correction'; end if;
  if exists(select 1 from jsonb_array_elements(state->'players') player where (player->>'score')::integer <> 0) then raise exception 'FAIL: score leaks current correctness'; end if;
  if (public.qcm_game('progress')->>'totalPoints')::integer <> 200 then raise exception 'FAIL: progress leaks current correctness'; end if;
end;
$$;
reset role;

select set_config('request.jwt.claim.sub',(select id::text from cloud_game_fixture where label = 'guest'),true);
select set_config('request.jwt.claims',jsonb_build_object('sub',(select id from cloud_game_fixture where label = 'guest'),'role','authenticated')::text,true);
set local role authenticated;
do $$
declare
  state jsonb := (select body from cloud_game_state where label = 'room');
  selection jsonb;
begin
  state := public.qcm_game('join_room',jsonb_build_object('code',state->>'code'));
  if state->'result' <> 'null'::jsonb then raise exception 'FAIL: peer result leakage'; end if;
  selection := case when (state->'question'->>'id')::uuid = (select id from cloud_game_fixture where label = 'question_a') then '[0,2]'::jsonb else '[1]'::jsonb end;
  state := public.qcm_game('answer',jsonb_build_object('gameId',state->>'id','questionId',state->'question'->>'id','selected',selection));
  if state->>'phase' <> 'correction' or (state->'result'->>'points')::integer not between 100 and 150 or not(state->'result'->>'correct')::boolean then raise exception 'FAIL: shared correction or rapid scoring'; end if;
end;
$$;
reset role;

update public.games set correction_until = clock_timestamp() - interval '1 second' where id = (select (body->>'id')::uuid from cloud_game_state where label = 'room');
set local role authenticated;
do $$
declare
  previous jsonb := (select body from cloud_game_state where label = 'room');
  state jsonb;
begin
  state := public.qcm_game('state',jsonb_build_object('gameId',previous->>'id'));
  if (state->>'questionIndex')::integer <> 1 or state->>'phase' <> 'question' or state->'question'->>'id' = previous->'question'->>'id' then raise exception 'FAIL: synchronized next question'; end if;
  begin perform public.qcm_game('answer',jsonb_build_object('gameId',state->>'id','questionId',previous->'question'->>'id','selected','[0]'::jsonb)); raise exception 'FAIL: stale response accepted'; exception when object_not_in_prerequisite_state then null; end;
  begin perform public.qcm_game('next',jsonb_build_object('gameId',state->>'id')); raise exception 'FAIL: manual multiplayer advancement'; exception when insufficient_privilege then null; end;
end;
$$;
reset role;

update public.games set question_started_at = clock_timestamp() - interval '40 seconds',deadline = clock_timestamp() - interval '10 seconds' where id = (select (body->>'id')::uuid from cloud_game_state where label = 'room');
set local role authenticated;
do $$
declare
  state jsonb := public.qcm_game('state',jsonb_build_object('gameId',(select body->>'id' from cloud_game_state where label = 'room')));
  repeated jsonb;
begin
  if state->>'status' <> 'finished' or (state->'result'->>'points')::integer <> 0 or state->'result'->'selected' <> '[]'::jsonb then raise exception 'FAIL: offline timeout and finish'; end if;
  if (select count(*) from public.submissions where game_id = (state->>'id')::uuid and player_id = (select auth.uid())) <> 2 then raise exception 'FAIL: missing timeout'; end if;
  repeated := public.qcm_game('state',jsonb_build_object('gameId',state->>'id'));
  if repeated->'players' <> state->'players' or repeated->'results' <> state->'results' then raise exception 'FAIL: repeated state changes score'; end if;
  if (select count(*) from public.chapter_results where game_id = (state->>'id')::uuid and player_id = (select auth.uid())) <> 2 then raise exception 'FAIL: chapter results duplicated'; end if;
end;
$$;
reset role;

select set_config('request.jwt.claim.sub',(select id::text from cloud_game_fixture where label = 'host'),true);
select set_config('request.jwt.claims',jsonb_build_object('sub',(select id from cloud_game_fixture where label = 'host'),'role','authenticated')::text,true);
set local role authenticated;
do $$
declare
  chapters jsonb;
  state jsonb;
begin
  select jsonb_agg('test-' || label || '-' || id::text order by label) into chapters from cloud_game_fixture where label in ('question_a','question_b');
  state := public.qcm_game('create_room',jsonb_build_object('chapterIds',chapters,'count',2));
  insert into cloud_game_state values('offline',state);
end;
$$;
reset role;

select set_config('request.jwt.claim.sub',(select id::text from cloud_game_fixture where label = 'guest'),true);
select set_config('request.jwt.claims',jsonb_build_object('sub',(select id from cloud_game_fixture where label = 'guest'),'role','authenticated')::text,true);
set local role authenticated;
select public.qcm_game('join_room',jsonb_build_object('code',(select body->>'code' from cloud_game_state where label = 'offline')));
reset role;
select set_config('request.jwt.claim.sub',(select id::text from cloud_game_fixture where label = 'host'),true);
select set_config('request.jwt.claims',jsonb_build_object('sub',(select id from cloud_game_fixture where label = 'host'),'role','authenticated')::text,true);
set local role authenticated;
select public.qcm_game('start',jsonb_build_object('gameId',(select body->>'id' from cloud_game_state where label = 'offline')));
reset role;
update public.games set question_started_at = clock_timestamp() - interval '75 seconds',deadline = clock_timestamp() - interval '45 seconds' where id = (select (body->>'id')::uuid from cloud_game_state where label = 'offline');
set local role authenticated;
do $$
declare
  state jsonb := public.qcm_game('state',jsonb_build_object('gameId',(select body->>'id' from cloud_game_state where label = 'offline')));
  board jsonb;
begin
  if state->>'status' <> 'finished' or jsonb_array_length(state->'results') <> 2 then raise exception 'FAIL: multiple missed deadlines not caught up'; end if;
  if exists(select 1 from jsonb_array_elements(state->'players') player where (player->>'score')::integer <> 0) then raise exception 'FAIL: timeout points'; end if;
  if (select count(*) from public.submissions where game_id = (state->>'id')::uuid and player_id = (select auth.uid())) <> 2 then raise exception 'FAIL: timeout idempotency'; end if;
  board := public.qcm_game('leaderboard',jsonb_build_object('chapterId','test-question_a-' || (select id::text from cloud_game_fixture where label = 'question_a')));
  if not exists(select 1 from jsonb_array_elements(board) entry where entry->>'userId' = (select id::text from cloud_game_fixture where label = 'host') and (entry->>'points')::integer >= 100) then raise exception 'FAIL: leaderboard totals'; end if;
  if not exists(select 1 from jsonb_array_elements(board) entry where entry->>'userId' = (select id::text from cloud_game_fixture where label = 'guest')) then raise exception 'FAIL: leaderboard omits players'; end if;
end;
$$;
reset role;

select set_config('request.jwt.claim.sub',(select id::text from cloud_game_fixture where label = 'host'),true);
select set_config('request.jwt.claims',jsonb_build_object('sub',(select id from cloud_game_fixture where label = 'host'),'role','authenticated')::text,true);
set local role authenticated;
insert into cloud_game_state select 'transfer',public.qcm_game('create_room',jsonb_build_object('chapterIds',jsonb_build_array('test-question_a-' || (select id::text from cloud_game_fixture where label = 'question_a')),'count',1));
reset role;
select set_config('request.jwt.claim.sub',(select id::text from cloud_game_fixture where label = 'guest'),true);
select set_config('request.jwt.claims',jsonb_build_object('sub',(select id from cloud_game_fixture where label = 'guest'),'role','authenticated')::text,true);
set local role authenticated;
select public.qcm_game('join_room',jsonb_build_object('code',(select body->>'code' from cloud_game_state where label = 'transfer')));
reset role;
select set_config('request.jwt.claim.sub',(select id::text from cloud_game_fixture where label = 'host'),true);
select set_config('request.jwt.claims',jsonb_build_object('sub',(select id from cloud_game_fixture where label = 'host'),'role','authenticated')::text,true);
set local role authenticated;
select public.qcm_game('leave',jsonb_build_object('gameId',(select body->>'id' from cloud_game_state where label = 'transfer')));
reset role;
select set_config('request.jwt.claim.sub',(select id::text from cloud_game_fixture where label = 'guest'),true);
select set_config('request.jwt.claims',jsonb_build_object('sub',(select id from cloud_game_fixture where label = 'guest'),'role','authenticated')::text,true);
set local role authenticated;
do $$
declare
  state jsonb := public.qcm_game('state',jsonb_build_object('gameId',(select body->>'id' from cloud_game_state where label = 'transfer')));
begin
  if state->>'hostId' <> (select id::text from cloud_game_fixture where label = 'guest') or jsonb_array_length(state->'players') <> 1 then raise exception 'FAIL: waiting host transfer'; end if;
  perform public.qcm_game('leave',jsonb_build_object('gameId',state->>'id'));
  begin perform public.qcm_game('state',jsonb_build_object('gameId',state->>'id')); raise exception 'FAIL: departed player retains membership'; exception when insufficient_privilege then null; end;
end;
$$;
reset role;

update public.profiles set disabled_at = clock_timestamp() where id = (select id from cloud_game_fixture where label = 'guest');
select set_config('request.jwt.claim.sub',(select id::text from cloud_game_fixture where label = 'guest'),true);
select set_config('request.jwt.claims',jsonb_build_object('sub',(select id from cloud_game_fixture where label = 'guest'),'role','authenticated')::text,true);
set local role authenticated;
do $$
begin
  begin perform public.qcm_game('progress'); raise exception 'FAIL: disabled profile gameplay'; exception when insufficient_privilege then null; end;
end;
$$;
reset role;

rollback;
