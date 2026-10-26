begin;

create temporary table content_fixture(label text primary key, id uuid not null default gen_random_uuid(), data jsonb);
insert into content_fixture(label) values('admin'),('contributor'),('student'),('question'),('admin_question'),('history_game');
grant select, update on content_fixture to authenticated;

insert into auth.users(id, email, aud, role, raw_user_meta_data, raw_app_meta_data)
select id, label || '-' || id::text || '@content-test.invalid', 'authenticated', 'authenticated',
  jsonb_build_object('display_name', 'Content ' || label, 'role', 'admin'), '{}'::jsonb
from content_fixture where label in ('admin','contributor','student');
update public.profiles set role = 'admin' where id = (select id from content_fixture where label = 'admin');
update public.profiles set role = 'contributor' where id = (select id from content_fixture where label = 'contributor');

update content_fixture set data = jsonb_build_object('chapterId','cellulaire','difficulty','medium',
  'prompt','Une question de contenu suffisamment précise ?', 'options',jsonb_build_array('Réponse A','Réponse B','Réponse C','Réponse D'),
  'correctAnswers',jsonb_build_array(0,2),'explanation','Une correction pédagogique suffisamment détaillée.',
  'image',null,'status','pending') where label = 'question';

insert into storage.objects(bucket_id, name, metadata)
select 'question-images', id::text || '/content-test.png', jsonb_build_object('mimetype','image/png')
from content_fixture where label in ('admin','contributor');

set local role authenticated;
select set_config('request.jwt.claim.sub', (select id::text from content_fixture where label = 'student'), true);
select set_config('request.jwt.claims', jsonb_build_object('sub',(select id from content_fixture where label = 'student'),'role','authenticated')::text, true);

do $$
declare result jsonb;
begin
  result := public.qcm_content('bootstrap');
  if result #>> '{user,id}' <> (select id::text from content_fixture where label = 'student')
    or result #>> '{user,role}' <> 'student'
    or jsonb_array_length(result -> 'chapters') <> 5
    or not (result -> 'progress') ?& array['totalPoints','answered','correct','accuracy','gamesPlayed','streak','chapters','recentGames','mistakes','daily']
    or (select count(*) from jsonb_object_keys(result -> 'counts')) <> 5 then
    raise exception 'FAIL: student bootstrap contract';
  end if;
  if jsonb_array_length(public.qcm_content('chapters')) <> 5 then raise exception 'FAIL: chapter list'; end if;
  begin
    perform public.qcm_content('questions');
    raise exception 'FAIL: student question keys exposed';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.qcm_content('users');
    raise exception 'FAIL: student Auth emails exposed';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.qcm_content('create_question', (select data from content_fixture where label = 'question'));
    raise exception 'FAIL: student editor access';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from private.question_keys;
    raise exception 'FAIL: private keys directly readable';
  exception when insufficient_privilege then null;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', (select id::text from content_fixture where label = 'contributor'), true);
select set_config('request.jwt.claims', jsonb_build_object('sub',(select id from content_fixture where label = 'contributor'),'role','authenticated')::text, true);

do $$
declare
  original jsonb := (select data from content_fixture where label = 'question');
  result jsonb;
  before_count integer;
  invalid jsonb;
begin
  result := public.qcm_content('create_question', original || jsonb_build_object('authorId',(select id from content_fixture where label = 'admin'),
    'image',(select id::text || '/content-test.png' from content_fixture where label = 'contributor')));
  update content_fixture set id = (result ->> 'id')::uuid where label = 'question';
  if result ->> 'authorId' <> (select id::text from content_fixture where label = 'contributor')
    or result ->> 'status' <> 'pending' or result -> 'correctAnswers' <> '[0,2]'::jsonb
    or result ->> 'image' <> (select id::text || '/content-test.png' from content_fixture where label = 'contributor') then
    raise exception 'FAIL: contributor create contract or author spoofing';
  end if;
  foreach invalid in array array[
    original || '{"status":"published"}'::jsonb,
    original || '{"correctAnswers":[0,0]}'::jsonb,
    original || '{"correctAnswers":[0,null]}'::jsonb,
    original || '{"options":["A","a","C","D"]}'::jsonb,
    original || '{"chapterId":"unknown"}'::jsonb,
    original || '{"image":"https://example.invalid/test.png"}'::jsonb,
    original || jsonb_build_object('image',(select id::text || '/content-test.png' from content_fixture where label = 'admin'))
  ] loop
    begin
      perform public.qcm_content('create_question', invalid);
      raise exception 'FAIL: invalid question accepted';
    exception when invalid_parameter_value then null;
    end;
  end loop;
  begin
    perform public.qcm_content('review', jsonb_build_object('questionId',(select id from content_fixture where label = 'question'),'status','published'));
    raise exception 'FAIL: contributor publication allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.qcm_content('update_user', jsonb_build_object('userId',auth.uid(),'role','admin'));
    raise exception 'FAIL: contributor self promotion allowed';
  exception when insufficient_privilege then null;
  end;
  select count(*) into before_count from public.questions where author_id = auth.uid() and deleted_at is null;
  begin
    perform public.qcm_content('import',jsonb_build_object('questions',jsonb_build_array(original,original || '{"correctAnswers":[3,3]}'::jsonb)));
    raise exception 'FAIL: invalid import accepted';
  exception when invalid_parameter_value then null;
  end;
  if (select count(*) from public.questions where author_id = auth.uid() and deleted_at is null) <> before_count then
    raise exception 'FAIL: import was not atomic';
  end if;
  result := public.qcm_content('import',jsonb_build_object('questions',jsonb_build_array(original || '{"status":"published"}'::jsonb)));
  if (result ->> 'imported')::integer <> 1
    or exists(select 1 from public.questions where author_id = auth.uid() and status = 'published') then
    raise exception 'FAIL: imported published question bypassed moderation';
  end if;
  result := public.qcm_content('export');
  if not exists(select 1 from jsonb_array_elements(result) q where q ->> 'id' = (select id::text from content_fixture where label = 'question')) then
    raise exception 'FAIL: contributor export missing own question';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', (select id::text from content_fixture where label = 'admin'), true);
select set_config('request.jwt.claims', jsonb_build_object('sub',(select id from content_fixture where label = 'admin'),'role','authenticated')::text, true);

do $$
declare result jsonb;
begin
  result := public.qcm_content('users');
  if not exists(select 1 from jsonb_array_elements(result) u where u ->> 'id' = (select id::text from content_fixture where label = 'student')
    and u ->> 'email' = 'student-' || (select id::text from content_fixture where label = 'student') || '@content-test.invalid') then
    raise exception 'FAIL: admin user email contract';
  end if;
  begin
    perform public.qcm_content('update_user',jsonb_build_object('userId',auth.uid(),'role','student'));
    raise exception 'FAIL: admin self demotion allowed';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.qcm_content('update_user',jsonb_build_object('userId',(select id from content_fixture where label = 'student'),'role','student','disabledAt',now()));
    raise exception 'FAIL: unexpected profile mutation accepted';
  exception when invalid_parameter_value then null;
  end;
  result := public.qcm_content('update_user',jsonb_build_object('userId',(select id from content_fixture where label = 'student'),'role','contributor'));
  if result ->> 'role' <> 'contributor' then raise exception 'FAIL: admin role update'; end if;
  perform public.qcm_content('update_user',jsonb_build_object('userId',(select id from content_fixture where label = 'student'),'role','student'));
  begin
    perform public.qcm_content('review',jsonb_build_object('questionId',(select id from content_fixture where label = 'question'),'status','rejected'));
    raise exception 'FAIL: rejection without note';
  exception when invalid_parameter_value then null;
  end;
  result := public.qcm_content('review',jsonb_build_object('questionId',(select id from content_fixture where label = 'question'),'status','published'));
  if result ->> 'status' <> 'published' then raise exception 'FAIL: admin publication'; end if;
  result := public.qcm_content('create_question',(select data from content_fixture where label = 'question'));
  update content_fixture set id = (result ->> 'id')::uuid where label = 'admin_question';
end;
$$;

select set_config('request.jwt.claim.sub', (select id::text from content_fixture where label = 'contributor'), true);
select set_config('request.jwt.claims', jsonb_build_object('sub',(select id from content_fixture where label = 'contributor'),'role','authenticated')::text, true);

do $$
begin
  begin
    perform public.qcm_content('update_question',(select data from content_fixture where label = 'question') || jsonb_build_object('questionId',(select id from content_fixture where label = 'question')));
    raise exception 'FAIL: contributor changed published question';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.qcm_content('delete_question',jsonb_build_object('questionId',(select id from content_fixture where label = 'admin_question')));
    raise exception 'FAIL: contributor deleted another author question';
  exception when insufficient_privilege then null;
  end;
  if exists(select 1 from jsonb_array_elements(public.qcm_content('questions')) q where q ->> 'id' = (select id::text from content_fixture where label = 'admin_question')) then
    raise exception 'FAIL: contributor obtained another author correction';
  end if;
end;
$$;

reset role;
insert into public.games(id, host_id, mode, status, question_count, question_started_at)
select g.id, u.id, 'solo', 'playing', 1, now() from content_fixture g cross join content_fixture u where g.label = 'history_game' and u.label = 'student';
insert into public.game_players(game_id, player_id)
select g.id, u.id from content_fixture g cross join content_fixture u where g.label = 'history_game' and u.label = 'student';
insert into private.game_questions(game_id, position, question_id, chapter_id, public_snapshot, correct_answers, explanation)
select g.id, 0, q.id, q.chapter_id, private.content_question(q.id) - array['correctAnswers','explanation','authorId','reviewNote'], array[0,2]::smallint[], 'Correction historique conservée.'
from content_fixture g join public.questions q on q.id = (select id from content_fixture where label = 'question') where g.label = 'history_game';

set local role authenticated;
select set_config('request.jwt.claim.sub', (select id::text from content_fixture where label = 'admin'), true);
select set_config('request.jwt.claims', jsonb_build_object('sub',(select id from content_fixture where label = 'admin'),'role','authenticated')::text, true);

do $$
declare result jsonb;
begin
  result := public.qcm_content('update_question',(select data from content_fixture where label = 'question') || jsonb_build_object('questionId',(select id from content_fixture where label = 'question'),
    'image',(select id::text || '/content-test.png' from content_fixture where label = 'contributor'),'status','draft'));
  if result ->> 'status' <> 'draft' or result ? 'reviewNote' then raise exception 'FAIL: published edit did not reset moderation'; end if;
  begin
    perform public.qcm_content('review',jsonb_build_object('questionId',(select id from content_fixture where label = 'question'),'status','published'));
    raise exception 'FAIL: direct draft review allowed';
  exception when invalid_parameter_value then null;
  end;
  perform public.qcm_content('delete_question',jsonb_build_object('questionId',(select id from content_fixture where label = 'question')));
  if exists(select 1 from jsonb_array_elements(public.qcm_content('export')) q where q ->> 'id' = (select id::text from content_fixture where label = 'question')) then
    raise exception 'FAIL: soft-deleted question exported';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', (select id::text from content_fixture where label = 'student'), true);
select set_config('request.jwt.claims', jsonb_build_object('sub',(select id from content_fixture where label = 'student'),'role','authenticated')::text, true);

do $$
begin
  if not private.can_read_game_image((select id::text || '/content-test.png' from content_fixture where label = 'contributor')) then
    raise exception 'FAIL: historical game image permission lost';
  end if;
  if not exists(select 1 from storage.objects where bucket_id = 'question-images' and name = (select id::text || '/content-test.png' from content_fixture where label = 'contributor')) then
    raise exception 'FAIL: historical image Storage policy';
  end if;
end;
$$;

reset role;

do $$
begin
  if not exists(select 1 from public.questions where id = (select id from content_fixture where label = 'question') and deleted_at is not null and revision >= 3)
    or not exists(select 1 from private.game_questions where game_id = (select id from content_fixture where label = 'history_game'))
    or not exists(select 1 from private.audit_events where actor_id = (select id from content_fixture where label = 'admin') and action = 'question.reviewed') then
    raise exception 'FAIL: soft deletion, history, revision or audit missing';
  end if;
  if has_function_privilege('authenticated','private.content_question(uuid)','execute')
    or has_function_privilege('anon','public.qcm_content(text,jsonb)','execute') then
    raise exception 'FAIL: content helper or anonymous grants';
  end if;
end;
$$;

set local role anon;
do $$
begin
  begin
    perform public.qcm_content('bootstrap');
    raise exception 'FAIL: anonymous bootstrap allowed';
  exception when insufficient_privilege then null;
  end;
end;
$$;

reset role;
rollback;

select 'passed' as cloud_content_test_status, 'Content fixtures, Auth accounts, Storage metadata and games rolled back.' as detail;
