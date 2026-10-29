begin;
create temporary table curriculum_people(label text primary key,id uuid default gen_random_uuid());
insert into curriculum_people(label) values('admin'),('student'),('contributor');
create temporary table curriculum_data(label text primary key,body jsonb);
grant select on curriculum_people to authenticated;
grant select,insert,update on curriculum_data to authenticated;
insert into auth.users(id,email,raw_user_meta_data) select id,id::text||'@curriculum-test.invalid',jsonb_build_object('display_name','Curriculum '||label) from curriculum_people;
update public.profiles set role=label::public.app_role from curriculum_people where public.profiles.id=curriculum_people.id;
set local role authenticated;
select set_config('request.jwt.claim.sub',(select id::text from curriculum_people where label='student'),true);
do $$ begin
 begin perform public.qcm_content('create_chapter','{"name":"Interdit"}');raise exception 'FAIL student chapter';exception when insufficient_privilege then null;end;
end $$;
select set_config('request.jwt.claim.sub',(select id::text from curriculum_people where label='admin'),true);
insert into curriculum_data values('root',public.qcm_content('create_chapter','{"name":"Chapitre curriculum"}'));
insert into curriculum_data values('other',public.qcm_content('create_chapter','{"name":"Autre chapitre"}'));
insert into curriculum_data values('child',public.qcm_content('create_chapter',jsonb_build_object('name','Sous-chapitre','parentId',(select body->>'id' from curriculum_data where label='root'))));
do $$ declare root_id text;child_id text;result jsonb;begin
 select body->>'id' into root_id from curriculum_data where label='root';select body->>'id' into child_id from curriculum_data where label='child';
 if (select body->>'parentId' from curriculum_data where label='child')<>root_id then raise exception 'FAIL parent not saved';end if;
 begin perform public.qcm_content('create_chapter',jsonb_build_object('name','Grand enfant','parentId',child_id));raise exception 'FAIL third level';exception when invalid_parameter_value then null;end;
 begin perform public.qcm_content('update_chapter',jsonb_build_object('chapterId',root_id,'name','Cycle','parentId',child_id));raise exception 'FAIL cycle';exception when invalid_parameter_value then null;end;
 begin perform public.qcm_content('update_chapter',jsonb_build_object('chapterId',child_id,'name','Cycle','parentId',child_id));raise exception 'FAIL self cycle';exception when invalid_parameter_value then null;end;
 begin perform public.qcm_content('create_chapter','{"name":"Absent","parentId":"missing"}');raise exception 'FAIL missing parent';exception when invalid_parameter_value then null;end;
 result:=public.qcm_content('update_chapter',jsonb_build_object('chapterId',child_id,'name','Sous-chapitre renommé'));
 if result->>'parentId'<>root_id then raise exception 'FAIL legacy rename loses parent';end if;
end $$;
select set_config('request.jwt.claim.sub',(select id::text from curriculum_people where label='contributor'),true);
do $$ begin
 begin perform public.qcm_content('create_chapter',jsonb_build_object('name','Interdit','parentId',(select body->>'id' from curriculum_data where label='root')));raise exception 'FAIL contributor chapter';exception when insufficient_privilege then null;end;
end $$;
select set_config('request.jwt.claim.sub',(select id::text from curriculum_people where label='admin'),true);
insert into curriculum_data values('input',jsonb_build_object('chapterId',(select body->>'id' from curriculum_data where label='child'),'difficulty','medium','prompt','Quelles affirmations décrivent la membrane ?', 'options',jsonb_build_array('Lipides','Protéines','Chromosomes','Ribosomes'),'correctAnswers',jsonb_build_array(0,1),'explanation','Une correction suffisamment détaillée pour comprendre.','status','pending'));
insert into curriculum_data values('year1',public.qcm_content('create_question',(select body from curriculum_data where label='input')||'{"schoolYear":"BCPST1"}'));
insert into curriculum_data values('year2',public.qcm_content('create_question',(select body from curriculum_data where label='input')||'{"schoolYear":"BCPST2"}'));
insert into curriculum_data values('common',public.qcm_content('create_question',(select body from curriculum_data where label='input')));
insert into curriculum_data values('variant',public.qcm_content('create_question',(select body from curriculum_data where label='input')||jsonb_build_object('usage','challenge','correctAnswers',jsonb_build_array(0),'sourceQuestionId',(select body->>'id' from curriculum_data where label='year1'),'schoolYear','BCPST1')));
select public.qcm_content('review',jsonb_build_object('questionId',body->>'id','status','published')) from curriculum_data where label in ('year1','year2','common','variant');
do $$ declare input jsonb;result jsonb;begin
 select body into input from curriculum_data where label='input';
 if (select body->>'schoolYear' from curriculum_data where label='common')<>'both' then raise exception 'FAIL legacy common default';end if;
 begin perform public.qcm_content('create_question',input||'{"schoolYear":"BCPST3"}');raise exception 'FAIL invalid year';exception when invalid_parameter_value then null;end;
 begin perform public.qcm_content('create_question',input||'{"schoolYear":null}');raise exception 'FAIL null year';exception when invalid_parameter_value then null;end;
 result:=public.qcm_content('questions',jsonb_build_object('chapterId',(select body->>'id' from curriculum_data where label='root'),'schoolYear','BCPST2'));
 if jsonb_array_length(result)<>2 or exists(select 1 from jsonb_array_elements(result) q where q->>'schoolYear' not in ('both','BCPST2')) then raise exception 'FAIL library filter';end if;
end $$;
select set_config('request.jwt.claim.sub',(select id::text from curriculum_people where label='student'),true);
insert into curriculum_data values('game',public.qcm_game('solo',jsonb_build_object('chapterIds',jsonb_build_array((select body->>'id' from curriculum_data where label='root'),(select body->>'id' from curriculum_data where label='child')),'schoolYear','BCPST1','count',30)));
do $$ declare result jsonb;boot jsonb;child_id text;begin
 select body into result from curriculum_data where label='game';
 if result->>'totalQuestions'<>'2' or result->>'schoolYear'<>'BCPST1' or result#>>'{question,schoolYear}' not in ('both','BCPST1') then raise exception 'FAIL year-filtered solo';end if;
 if result->'question' ?| array['correctAnswers','explanation'] then raise exception 'FAIL keys leak';end if;
 boot:=public.qcm_content('bootstrap');select body->>'id' into child_id from curriculum_data where label='child';
 if boot#>>array['countsByYear','BCPST1',child_id]<>'2' or boot#>>array['countsByYear','BCPST2',child_id]<>'2' or boot#>>array['challengeCountsByYear','BCPST1',child_id]<>'1' or boot#>>array['challengeCountsByYear','BCPST2',child_id]<>'0' then raise exception 'FAIL year counts';end if;
 begin perform public.qcm_game('solo','{"schoolYear":"BCPST3"}');raise exception 'FAIL invalid game year';exception when invalid_parameter_value then null;end;
 begin perform public.qcm_game('create_room',jsonb_build_object('chapterIds',jsonb_build_array((select body->>'id' from curriculum_data where label='root')),'schoolYear','BCPST2'));raise exception 'FAIL wrong-year room';exception when invalid_parameter_value then null;end;
 result:=public.qcm_game('create_room',jsonb_build_object('chapterIds',jsonb_build_array((select body->>'id' from curriculum_data where label='root')),'schoolYear','BCPST1'));
 if result->>'totalQuestions'<>'1' or result->>'schoolYear'<>'BCPST1' then raise exception 'FAIL filtered room';end if;
end $$;
select set_config('request.jwt.claim.sub',(select id::text from curriculum_people where label='admin'),true);
select public.qcm_content('update_question',(select body from curriculum_data where label='input')||jsonb_build_object('questionId',(select body->>'id' from curriculum_data where label='year1'),'schoolYear','BCPST2','status','draft'));
do $$ declare result jsonb;begin
 result:=public.qcm_content('update_question',(select body from curriculum_data where label='input')||jsonb_build_object('questionId',(select body->>'id' from curriculum_data where label='year1'),'status','draft'));
 if result->>'schoolYear'<>'BCPST2' then raise exception 'FAIL legacy update loses year';end if;
 result:=public.qcm_content('import',jsonb_build_object('questions',jsonb_build_array((select body from curriculum_data where label='year2'))));
 if result->>'imported'<>'1' then raise exception 'FAIL import';end if;
 result:=public.qcm_content('questions',jsonb_build_object('chapterId',(select body->>'id' from curriculum_data where label='child'),'schoolYear','BCPST2'));
 if not exists(select 1 from jsonb_array_elements(result) q where q->>'schoolYear'='BCPST2' and q->>'status'='pending' and q->>'id'<>(select body->>'id' from curriculum_data where label='year2')) then raise exception 'FAIL import year lost';end if;
end $$;
reset role;
do $$ begin
 if exists(select 1 from private.game_questions g where g.game_id=(select (body->>'id')::uuid from curriculum_data where label='game') and g.public_snapshot->>'schoolYear' not in ('BCPST1','both')) then raise exception 'FAIL snapshot year changed';end if;
 begin
  update public.chapters set parent_id=(select body->>'id' from curriculum_data where label='child') where id=(select body->>'id' from curriculum_data where label='other');
  set constraints all immediate;raise exception 'FAIL privileged third level';
 exception when check_violation then null;end;
end $$;
set local role authenticated;
set constraints all immediate;
reset role;
rollback;
select 'school_years_subchapters passed' as result;
