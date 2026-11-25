begin;
create temporary table direct_people(label text primary key,id uuid default gen_random_uuid());
insert into direct_people(label) values('admin'),('student'),('contributor');
insert into auth.users(id,email,raw_user_meta_data) select id,id::text||'@direct-test.invalid',jsonb_build_object('display_name','Direct '||label) from direct_people;
update public.profiles set role=label::public.app_role from direct_people where public.profiles.id=direct_people.id;
create temporary table direct_data(label text primary key,body jsonb);
grant select on direct_people to authenticated;grant select,insert,update on direct_data to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub',(select id::text from direct_people where label='admin'),true);
insert into direct_data values('chapter',public.qcm_content('create_chapter','{"name":"Publication directe"}'));
insert into direct_data values('input',jsonb_build_object('chapterId',(select body->>'id' from direct_data where label='chapter'),'difficulty','easy','prompt','Quelle proposition est correcte pour ce test ?', 'options',jsonb_build_array('A','B','C','D'),'correctAnswers',jsonb_build_array(0),'status','published'));
insert into direct_data values('solo',public.qcm_content('create_question',(select body from direct_data where label='input')));
insert into direct_data values('challenge',public.qcm_content('create_question',(select body||'{"usage":"challenge"}' from direct_data where label='input')));
insert into direct_data values('draft',public.qcm_content('create_question',(select body||'{"status":"draft"}' from direct_data where label='input')));
do $$ declare result jsonb;begin
 if (select body->>'status' from direct_data where label='solo')<>'published' or (select body->>'status' from direct_data where label='challenge')<>'published' or (select body->>'status' from direct_data where label='draft')<>'draft' then raise exception 'FAIL statuses';end if;
 result:=public.qcm_content('update_question',(select body from direct_data where label='input')||jsonb_build_object('questionId',(select body->>'id' from direct_data where label='solo'),'prompt','Quelle proposition convient après modification ?'));
 if result->>'status'<>'published' then raise exception 'FAIL published edit';end if;
 perform public.qcm_content('import',jsonb_build_object('questions',jsonb_build_array((select body from direct_data where label='input'))));
end $$;
select set_config('request.jwt.claim.sub',(select id::text from direct_people where label='contributor'),true);
do $$ begin
 begin perform public.qcm_content('create_question',(select body from direct_data where label='input'));raise exception 'FAIL contributor published';exception when insufficient_privilege then null;end;
end $$;
insert into direct_data values('pending',public.qcm_content('create_question',(select body||'{"status":"pending"}' from direct_data where label='input')));
do $$ begin
 begin perform public.qcm_content('update_question',(select body from direct_data where label='input')||jsonb_build_object('questionId',(select body->>'id' from direct_data where label='pending')));raise exception 'FAIL contributor update published';exception when insufficient_privilege then null;end;
end $$;
select set_config('request.jwt.claim.sub',(select id::text from direct_people where label='student'),true);
do $$ declare result jsonb;begin
 result:=public.qcm_game('solo',jsonb_build_object('chapterIds',jsonb_build_array((select body->>'id' from direct_data where label='chapter')),'count',30));
 if (result->>'totalQuestions')::int<>1 then raise exception 'FAIL not playable immediately';end if;
 begin perform public.qcm_content('create_question',(select body from direct_data where label='input'));raise exception 'FAIL student publication';exception when insufficient_privilege then null;end;
end $$;
reset role;
do $$ begin
 if (select count(*) from private.question_reviews where question_id in (select (body->>'id')::uuid from direct_data where label in ('solo','challenge')) and reviewer_id=(select id from direct_people where label='admin') and decision='published')<>3 then raise exception 'FAIL publication audit';end if;
 if (select count(*) from public.questions where author_id=(select id from direct_people where label='admin') and status='published')<>2 then raise exception 'FAIL import publication';end if;
end $$;
set constraints all immediate;
select 'admin_direct_publication passed' as result;
rollback;
