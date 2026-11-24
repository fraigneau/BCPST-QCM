begin;
create temporary table plain_people(label text primary key,id uuid default gen_random_uuid());
insert into plain_people(label) values('admin'),('student');
insert into auth.users(id,email,raw_user_meta_data) select id,id::text||'@plain-test.invalid',jsonb_build_object('display_name','Plain '||label) from plain_people;
update public.profiles set role=label::public.app_role from plain_people where public.profiles.id=plain_people.id;
create temporary table plain_data(label text primary key,body jsonb);
grant select on plain_people to authenticated;grant select,insert,update on plain_data to authenticated;
do $$ begin
 if exists(select 1 from information_schema.columns where table_schema='private' and table_name in ('question_keys','game_questions') and column_name='explanation') then raise exception 'FAIL removed column exists';end if;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub',(select id::text from plain_people where label='admin'),true);
insert into plain_data values('chapter',public.qcm_content('create_chapter','{"name":"Sans texte pédagogique"}'));
insert into plain_data values('input',jsonb_build_object('chapterId',(select body->>'id' from plain_data where label='chapter'),'difficulty','easy','prompt','Quelle proposition est correcte pour ce test ?', 'options',jsonb_build_array('A','B','C','D'),'correctAnswers',jsonb_build_array(0),'status','pending'));
insert into plain_data values('solo',public.qcm_content('create_question',(select body from plain_data where label='input')));
insert into plain_data values('challenge',public.qcm_content('create_question',(select body||'{"usage":"challenge"}' from plain_data where label='input')));
do $$ declare entry record;begin
 for entry in select * from plain_data where label in ('solo','challenge') loop
  if entry.body ? 'explanation' then raise exception 'FAIL content includes removed text';end if;
  perform public.qcm_content('review',jsonb_build_object('questionId',entry.body->>'id','status','published'));
 end loop;
end $$;
select set_config('request.jwt.claim.sub',(select id::text from plain_people where label='student'),true);
do $$ declare state jsonb;mode text;begin
 foreach mode in array array['solo','create_room'] loop
  state:=public.qcm_game(mode,jsonb_build_object('chapterIds',jsonb_build_array((select body->>'id' from plain_data where label='chapter')),'count',1));
  if mode='create_room' then if (state->>'totalQuestions')::int<>1 then raise exception 'FAIL standalone QCS';end if;continue;end if;
  state:=public.qcm_game('answer',jsonb_build_object('gameId',state->>'id','questionId',state#>>'{question,id}','selected',jsonb_build_array(0)));
  if state->'result' ? 'explanation' then raise exception 'FAIL answer includes removed text';end if;
  if state#>>'{result,correct}' <> 'true' or (state#>>'{result,points}')::int<100 then raise exception 'FAIL scoring';end if;
 end loop;
end $$;
reset role;
set constraints all immediate;
select 'without_pedagogical_text passed' as result;
rollback;
