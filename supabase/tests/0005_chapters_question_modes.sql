begin;
create temporary table modes_people(label text primary key, id uuid default gen_random_uuid());
insert into modes_people(label) values('admin'),('student'),('contributor');
create temporary table modes_data(label text primary key, body jsonb);
grant select on modes_people to authenticated;
grant select,insert,update on modes_data to authenticated;
insert into auth.users(id,email,raw_user_meta_data)
select id,id::text || '@modes-test.invalid',jsonb_build_object('display_name','Modes ' || label) from modes_people;
update public.profiles set role = 'admin' where id = (select id from modes_people where label = 'admin');
update public.profiles set role = 'contributor' where id = (select id from modes_people where label = 'contributor');

set local role authenticated;
select set_config('request.jwt.claim.sub',(select id::text from modes_people where label='student'),true);
do $$ begin
  begin perform public.qcm_content('create_chapter','{"name":"Interdit"}'); raise exception 'FAIL student creates chapter'; exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub',(select id::text from modes_people where label='contributor'),true);
do $$ begin
  begin perform public.qcm_content('create_chapter','{"name":"Interdit"}'); raise exception 'FAIL contributor creates chapter'; exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub',(select id::text from modes_people where label='admin'),true);
insert into modes_data values('chapter',public.qcm_content('create_chapter','{"name":"Chapitre 1 — Test","description":"Chapitre transactionnel"}'));
insert into modes_data values('other',public.qcm_content('create_chapter','{"name":"Chapitre 2 — Test"}'));
do $$ declare renamed jsonb; begin
  renamed := public.qcm_content('update_chapter',jsonb_build_object('chapterId',(select body->>'id' from modes_data where label='chapter'),'name','Chapitre renommé'));
  if renamed->>'name' <> 'Chapitre renommé' or renamed->>'shortName' <> 'Chapitre renommé' then raise exception 'FAIL rename'; end if;
  begin perform public.qcm_content('create_chapter','{"name":" "}'); raise exception 'FAIL empty chapter'; exception when invalid_parameter_value then null; end;
end $$;
insert into modes_data values('input',jsonb_build_object('chapterId',(select body->>'id' from modes_data where label='chapter'), 'difficulty','medium',
 'prompt','Quelles affirmations décrivent la cellule ?', 'options',jsonb_build_array('Réponse A','Réponse B','Réponse C','Réponse D'),
 'correctAnswers',jsonb_build_array(0,2),'explanation','Correction pédagogique détaillée pour comprendre la notion.','status','pending'));
insert into modes_data values('solo',public.qcm_content('create_question',(select body from modes_data where label='input')));
insert into modes_data values('challengeInput',(select body || jsonb_build_object('usage','challenge','sourceQuestionId',(select body->>'id' from modes_data where label='solo'),'correctAnswers',jsonb_build_array(1),'prompt','Quel élément décrit la cellule ?') from modes_data where label='input'));
do $$ declare input jsonb; begin
  select body into input from modes_data where label='challengeInput';
  begin perform public.qcm_content('create_question',input || '{"correctAnswers":[0,2]}'); raise exception 'FAIL multiple QCS answers'; exception when invalid_parameter_value then null; end;
  begin perform public.qcm_content('create_question',input - 'sourceQuestionId'); raise exception 'FAIL missing source'; exception when invalid_parameter_value then null; end;
  begin perform public.qcm_content('create_question',input || jsonb_build_object('chapterId',(select body->>'id' from modes_data where label='other'))); raise exception 'FAIL foreign chapter source'; exception when invalid_parameter_value then null; end;
end $$;
insert into modes_data values('challenge',public.qcm_content('create_question',(select body from modes_data where label='challengeInput')));
select public.qcm_content('review',jsonb_build_object('questionId',(select body->>'id' from modes_data where label='solo'),'status','published'));
select public.qcm_content('review',jsonb_build_object('questionId',(select body->>'id' from modes_data where label='challenge'),'status','published'));
do $$ declare input jsonb; begin
  select body into input from modes_data where label='challengeInput';
  begin perform public.qcm_content('create_question',input || jsonb_build_object('sourceQuestionId',(select body->>'id' from modes_data where label='challenge'))); raise exception 'FAIL chained variant'; exception when invalid_parameter_value then null; end;
  begin perform public.qcm_content('delete_question',jsonb_build_object('questionId',(select body->>'id' from modes_data where label='solo'))); raise exception 'FAIL delete source'; exception when invalid_parameter_value then null; end;
  begin perform public.qcm_content('update_question',(select body from modes_data where label='input') || jsonb_build_object('questionId',(select body->>'id' from modes_data where label='solo'),'chapterId',(select body->>'id' from modes_data where label='other'))); raise exception 'FAIL move source'; exception when invalid_parameter_value then null; end;
end $$;
select set_config('request.jwt.claim.sub',(select id::text from modes_people where label='contributor'),true);
do $$ begin
  begin perform public.qcm_content('create_question',(select body from modes_data where label='challengeInput')); raise exception 'FAIL private source accessible'; exception when invalid_parameter_value then null; end;
end $$;
select set_config('request.jwt.claim.sub',(select id::text from modes_people where label='student'),true);
insert into modes_data values('soloGame',public.qcm_game('solo',jsonb_build_object('chapterIds',jsonb_build_array((select body->>'id' from modes_data where label='chapter')),'count',30)));
insert into modes_data values('room',public.qcm_game('create_room',jsonb_build_object('chapterIds',jsonb_build_array((select body->>'id' from modes_data where label='chapter')),'count',30)));
do $$ declare state jsonb; boot jsonb; chapter text; begin
  select body into state from modes_data where label='soloGame';
  if (state->>'totalQuestions')::integer <> 1 or state#>>'{question,usage}' <> 'solo' or state#>>'{question,id}' <> (select body->>'id' from modes_data where label='solo') or state->'deadline' <> 'null'::jsonb then raise exception 'FAIL solo pool'; end if;
  if state->'question' ?| array['correctAnswers','explanation','sourceQuestionId'] then raise exception 'FAIL leaked keys'; end if;
  boot := public.qcm_content('bootstrap');
  select body->>'id' into chapter from modes_data where label='chapter';
  if boot#>>array['counts',chapter] <> '1' or boot#>>array['challengeCounts',chapter] <> '1' then raise exception 'FAIL mode counts'; end if;
  begin perform public.qcm_game('create_room',jsonb_build_object('chapterIds',jsonb_build_array((select body->>'id' from modes_data where label='other')))); raise exception 'FAIL empty challenge pool'; exception when invalid_parameter_value then null; end;
end $$;
select set_config('request.jwt.claim.sub',(select id::text from modes_people where label='admin'),true);
select public.qcm_game('join_room',jsonb_build_object('code',(select body->>'code' from modes_data where label='room')));
select set_config('request.jwt.claim.sub',(select id::text from modes_people where label='student'),true);
update modes_data set body=public.qcm_game('start',jsonb_build_object('gameId',body->>'id')) where label='room';
do $$ declare state jsonb; begin
  select body into state from modes_data where label='room';
  if state#>>'{question,usage}' <> 'challenge' or state#>>'{question,id}' <> (select body->>'id' from modes_data where label='challenge') then raise exception 'FAIL challenge pool'; end if;
  begin perform public.qcm_game('answer',jsonb_build_object('gameId',state->>'id','questionId',state#>>'{question,id}','selected',jsonb_build_array(0,1))); raise exception 'FAIL multi selections'; exception when invalid_parameter_value then null; end;
  perform public.qcm_game('answer',jsonb_build_object('gameId',state->>'id','questionId',state#>>'{question,id}','selected',jsonb_build_array(0),'points',999999));
end $$;
select set_config('request.jwt.claim.sub',(select id::text from modes_people where label='admin'),true);
select public.qcm_game('answer',jsonb_build_object('gameId',(select body->>'id' from modes_data where label='room'),'questionId',(select body->>'id' from modes_data where label='challenge'),'selected',jsonb_build_array(1)));
select set_config('request.jwt.claim.sub',(select id::text from modes_people where label='student'),true);
do $$ declare state jsonb; mistakes jsonb; begin
  mistakes := public.qcm_game('progress')->'mistakes';
  if mistakes#>>'{0,questionId}' <> (select body->>'id' from modes_data where label='solo') then raise exception 'FAIL challenge mistake not mapped to solo'; end if;
  state := public.qcm_game('solo',jsonb_build_object('chapterIds',jsonb_build_array((select body->>'id' from modes_data where label='chapter')),'mistakesOnly',true));
  if state#>>'{question,id}' <> (select body->>'id' from modes_data where label='solo') then raise exception 'FAIL revision source'; end if;
  state := public.qcm_game('answer',jsonb_build_object('gameId',state->>'id','questionId',state#>>'{question,id}','selected',jsonb_build_array(0,2)));
  if state#>>'{result,points}' <> '100' then raise exception 'FAIL solo score'; end if;
  if public.qcm_game('progress')->'mistakes' <> '[]'::jsonb then raise exception 'FAIL resolved mistake'; end if;
end $$;
select set_config('request.jwt.claim.sub',(select id::text from modes_people where label='admin'),true);
-- Remap des identifiants : une variante peut précéder sa source dans le fichier.
do $$ declare result jsonb; questions jsonb; before_count integer; begin
  select body into questions from modes_data where label='challenge';
  result := public.qcm_content('import',jsonb_build_object('questions',jsonb_build_array(questions,(select body from modes_data where label='solo'))));
  if result->>'imported' <> '2' then raise exception 'FAIL import'; end if;
  questions := public.qcm_content('questions',jsonb_build_object('chapterId',(select body->>'id' from modes_data where label='chapter')));
  if jsonb_array_length(questions) <> 4 then raise exception 'FAIL import count'; end if;
  if not exists(select 1 from jsonb_array_elements(questions) v where v->>'usage'='challenge' and v->>'status'='pending' and v->>'id' <> (select body->>'id' from modes_data where label='challenge') and v->>'sourceQuestionId' <> (select body->>'id' from modes_data where label='solo')) then raise exception 'FAIL source not remapped'; end if;
  begin perform public.qcm_content('import',jsonb_build_object('questions',jsonb_build_array((select body from modes_data where label='input'),'{"prompt":"invalid"}'::jsonb))); raise exception 'FAIL non atomic import'; exception when invalid_parameter_value then null; end;
  if jsonb_array_length(public.qcm_content('questions',jsonb_build_object('chapterId',(select body->>'id' from modes_data where label='chapter')))) <> 4 then raise exception 'FAIL partially imported'; end if;
end $$;
-- Le rattachement ultérieur d’une variante ne déplace pas les erreurs des parties passées.
insert into modes_data values('relinkedSource',public.qcm_content('create_question',(select body from modes_data where label='input')));
select public.qcm_content('update_question',(select body from modes_data where label='challengeInput') || jsonb_build_object('questionId',(select body->>'id' from modes_data where label='challenge'),'sourceQuestionId',(select body->>'id' from modes_data where label='relinkedSource')));
select set_config('request.jwt.claim.sub',(select id::text from modes_people where label='student'),true);
do $$ begin
  if public.qcm_game('progress')->'mistakes' <> '[]'::jsonb then raise exception 'FAIL relink changed past revision source'; end if;
end $$;
select set_config('request.jwt.claim.sub',(select id::text from modes_people where label='admin'),true);
-- L’administrateur peut reprendre l’image de la source accessible pour sa variante.
reset role;
insert into storage.objects(bucket_id,name,metadata) select 'question-images',id::text || '/variant-source.png','{"mimetype":"image/png"}'::jsonb from modes_people where label='contributor';
set local role authenticated;
select set_config('request.jwt.claim.sub',(select id::text from modes_people where label='contributor'),true);
insert into modes_data values('imageSource',public.qcm_content('create_question',(select body from modes_data where label='input') || jsonb_build_object('chapterId',(select body->>'id' from modes_data where label='other'),'image',(select id::text || '/variant-source.png' from modes_people where label='contributor'))));
select set_config('request.jwt.claim.sub',(select id::text from modes_people where label='admin'),true);
do $$ declare input jsonb; begin
  select body || jsonb_build_object('usage','challenge','sourceQuestionId',body->>'id','correctAnswers',jsonb_build_array(0),'status','draft') into input from modes_data where label='imageSource';
  perform public.qcm_content('create_question',input);
end $$;
-- Même les écritures privilégiées doivent respecter la règle QCS et la cohérence du chapitre.
reset role;
do $$ begin
  begin
    update private.question_keys set correct_answers=array[0,1]::smallint[] where question_id=(select (body->>'id')::uuid from modes_data where label='challenge');
    set constraints all immediate;
    raise exception 'FAIL invalid answer key bypassed constraint';
  exception when check_violation then null;
  end;
  begin
    update public.questions set chapter_id=(select body->>'id' from modes_data where label='other') where id=(select (body->>'id')::uuid from modes_data where label='relinkedSource');
    set constraints all immediate;
    raise exception 'FAIL invalid source chapter bypassed constraint';
  exception when check_violation then null;
  end;
end $$;
set local role authenticated;
-- Déclencheurs différés exécutés sous l’identité utilisateur, sans privilèges directs.
set constraints all immediate;
reset role;
rollback;
select 'chapters_question_modes passed' as result;
