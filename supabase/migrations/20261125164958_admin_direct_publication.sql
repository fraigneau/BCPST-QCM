begin;

create or replace function private.content_input(data jsonb, actor uuid, actor_role public.app_role, previous_image text default null) returns jsonb
language plpgsql set search_path = ''
as $$
declare
  choices text[];
  answers smallint[];
  image_value jsonb;
  image_name text;
  question_prompt text;
  next_status text;
  question_usage text := coalesce(data ->> 'usage', 'solo');
  source_id uuid;
  question_year text := coalesce(data ->> 'schoolYear','both');
begin
  if question_year not in ('BCPST1','BCPST2','both') or (data ? 'schoolYear' and jsonb_typeof(data -> 'schoolYear') is distinct from 'string') then raise exception 'Année BCPST invalide.' using errcode = '22023'; end if;
  if data is null or jsonb_typeof(data) <> 'object' then raise exception 'Question invalide.' using errcode = '22023'; end if;
  if jsonb_typeof(data -> 'chapterId') is distinct from 'string'
    or not exists(select 1 from public.chapters where id = data ->> 'chapterId') then
    raise exception 'Chapitre inconnu.' using errcode = '22023';
  end if;
  if coalesce(data ->> 'difficulty', '') not in ('easy','medium','hard') then raise exception 'Difficulté invalide.' using errcode = '22023'; end if;
  if jsonb_typeof(data -> 'prompt') is distinct from 'string' then
    raise exception 'Énoncé requis.' using errcode = '22023';
  end if;
  question_prompt := trim(data ->> 'prompt');
  if char_length(question_prompt) not between 10 and 5000 then
    raise exception 'Longueur de l’énoncé invalide.' using errcode = '22023';
  end if;
  if jsonb_typeof(data -> 'options') is distinct from 'array' or jsonb_typeof(data -> 'correctAnswers') is distinct from 'array' then
    raise exception 'Propositions et réponses requises.' using errcode = '22023';
  end if;
  if jsonb_array_length(data -> 'options') <> 4 or jsonb_array_length(data -> 'correctAnswers') not between 1 and 4 then
    raise exception 'Quatre propositions et une à quatre bonnes réponses sont requises.' using errcode = '22023';
  end if;
  if exists(select 1 from jsonb_array_elements(data -> 'options') item where jsonb_typeof(item) <> 'string')
    or exists(select 1 from jsonb_array_elements(data -> 'correctAnswers') item where jsonb_typeof(item) <> 'number' or item::text !~ '^[0-3]$') then
    raise exception 'Format des propositions ou indices invalide.' using errcode = '22023';
  end if;
  select array_agg(trim(value) order by ordinal) into choices from jsonb_array_elements_text(data -> 'options') with ordinality as x(value, ordinal);
  select array_agg(value::smallint order by ordinal) into answers from jsonb_array_elements_text(data -> 'correctAnswers') with ordinality as x(value, ordinal);
  if not private.valid_question_options(choices) or not private.valid_answer_indices(answers) then
    raise exception 'Propositions ou bonnes réponses dupliquées ou invalides.' using errcode = '22023';
  end if;
  if question_usage not in ('solo','challenge') then raise exception 'Usage de question invalide.' using errcode = '22023'; end if;
  if question_usage = 'challenge' then
    if cardinality(answers) <> 1 then raise exception 'Un QCS de défi doit avoir une seule bonne réponse.' using errcode = '22023'; end if;
    begin source_id := (data ->> 'sourceQuestionId')::uuid;
    exception when invalid_text_representation then raise exception 'Question solo source invalide.' using errcode = '22023'; end;
    if source_id is not null and not exists(select 1 from public.questions q where q.id = source_id and q.deleted_at is null
      and q.usage = 'solo' and q.chapter_id = data ->> 'chapterId' and (actor_role = 'admin' or q.author_id = actor)) then
      raise exception 'Choisissez une question solo accessible du même chapitre.' using errcode = '22023';
    end if;
  elsif data ->> 'sourceQuestionId' is not null then
    raise exception 'Une question solo ne peut pas être une variante.' using errcode = '22023';
  end if;
  next_status := coalesce(data ->> 'status', 'draft');
  if next_status not in ('draft','pending','published') then raise exception 'Statut de question invalide.' using errcode = '22023'; end if;
  if next_status = 'published' and actor_role <> 'admin' then raise exception 'La publication directe est réservée aux administrateurs.' using errcode = '42501'; end if;
  image_value := case when data ? 'imagePath' then data -> 'imagePath' else data -> 'image' end;
  if image_value is not null and image_value <> 'null'::jsonb then
    if jsonb_typeof(image_value) <> 'string' then raise exception 'Image invalide.' using errcode = '22023'; end if;
    image_name := image_value #>> '{}';
    if image_name not in ('/illustrations/cell.svg','/illustrations/leaf.svg','/illustrations/subduction.svg') then
      if image_name !~ '^[0-9a-fA-F-]{36}/[A-Za-z0-9_-]+\.(png|jpg|jpeg|webp)$'
        or not (split_part(image_name, '/', 1) = actor::text or (actor_role = 'admin' and (image_name = previous_image or exists(select 1 from public.questions source where source.id = source_id and source.deleted_at is null and source.image_path = image_name))))
        or not exists(select 1 from storage.objects where bucket_id = 'question-images' and name = image_name) then
        raise exception 'Importez une image dans votre espace avant de l’associer à la question.' using errcode = '22023';
      end if;
    end if;
  end if;
  return jsonb_build_object('schoolYear', question_year, 'usage', question_usage, 'sourceQuestionId', source_id, 'chapterId', data ->> 'chapterId', 'difficulty', data ->> 'difficulty', 'prompt', question_prompt,
    'options', choices, 'correctAnswers', answers, 'image', image_name, 'status', next_status);
end;
$$;

create or replace function private.app_content(action text, payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_role public.app_role;
  target uuid;
  question_row public.questions%rowtype;
  input jsonb;
  item jsonb;
  result jsonb;
  chapter_list jsonb;
  counts jsonb;
  challenge_counts jsonb;
  imported_ids jsonb := '{}'::jsonb;
  chapter_title text;
  chapter_description text;
  chapter_target text;
  chapter_parent text;
  choices text[];
  answers smallint[];
  review_status text;
  review_note text;
  target_role text;
  import_count integer := 0;
begin
  actor_role := private.current_role();
  if actor is null or actor_role is null then raise exception 'Authentification requise ou profil désactivé.' using errcode = '42501'; end if;
  if payload is null or jsonb_typeof(payload) <> 'object' then raise exception 'Paramètres invalides.' using errcode = '22023'; end if;

  if action in ('create_chapter','update_chapter') then
    if actor_role <> 'admin' then raise exception 'Action réservée à l’administrateur.' using errcode = '42501'; end if;
    if jsonb_typeof(payload -> 'name') is distinct from 'string' or (payload ? 'description' and jsonb_typeof(payload -> 'description') is distinct from 'string') then
      raise exception 'Nom ou description de chapitre invalide.' using errcode = '22023';
    end if;
    chapter_title := trim(payload ->> 'name');
    chapter_description := trim(coalesce(payload ->> 'description',''));
    if char_length(chapter_title) not between 2 and 60 or char_length(chapter_description) > 1000 then
      raise exception 'Nom de 2 à 60 caractères et description de 1000 caractères maximum.' using errcode = '22023';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('qcm-chapters',0));
    chapter_target := case when action = 'create_chapter' then gen_random_uuid()::text else payload ->> 'chapterId' end;
    if payload ? 'parentId' then
      if jsonb_typeof(payload -> 'parentId') not in ('string','null') or payload ->> 'parentId' = '' then raise exception 'Chapitre parent invalide.' using errcode = '22023'; end if;
      chapter_parent := payload ->> 'parentId';
    elsif action = 'update_chapter' then select parent_id into chapter_parent from public.chapters where id = chapter_target;
    end if;
    if chapter_parent is not null and (chapter_parent = chapter_target or not exists(select 1 from public.chapters where id = chapter_parent and parent_id is null)) then
      raise exception 'Choisissez un chapitre principal comme parent.' using errcode = '22023';
    end if;
    if chapter_parent is not null and exists(select 1 from public.chapters where parent_id = chapter_target) then raise exception 'Un chapitre contenant des sous-chapitres doit rester à la racine.' using errcode = '22023'; end if;
    if action = 'create_chapter' then
      insert into public.chapters(id,name,short_name,description,color,icon,sort_order,parent_id)
        values(chapter_target,chapter_title,chapter_title,chapter_description,'#648c5f','Leaf',(select coalesce(max(sort_order),0) + 1 from public.chapters),chapter_parent);
    else
      chapter_target := payload ->> 'chapterId';
      update public.chapters set parent_id = chapter_parent, name = chapter_title, short_name = chapter_title, description = chapter_description where id = chapter_target;
      if not found then raise exception 'Chapitre introuvable.' using errcode = 'P0002'; end if;
    end if;
    insert into private.audit_events(actor_id,action,target_id) values(actor,action,chapter_target);
    select jsonb_build_object('parentId',parent_id,'id',id,'name',name,'shortName',short_name,'description',description,'color',color,'icon',icon) into result from public.chapters where id = chapter_target;
    return result;
  end if;

  if action in ('bootstrap','chapters') then
    select coalesce(jsonb_agg(jsonb_build_object('parentId',c.parent_id,'id', c.id, 'name', c.name, 'shortName', c.short_name,
      'description', c.description, 'color', c.color, 'icon', c.icon) order by c.sort_order, c.id), '[]'::jsonb)
      into chapter_list from public.chapters c;
    if action = 'chapters' then return chapter_list; end if;
    select coalesce(jsonb_object_agg(c.id, (select count(*) from public.questions q where q.chapter_id = c.id and q.status = 'published' and q.deleted_at is null and q.usage = 'solo')), '{}'::jsonb)
      into counts from public.chapters c;
    select coalesce(jsonb_object_agg(c.id, (select count(*) from public.questions q where q.chapter_id = c.id and q.status = 'published' and q.deleted_at is null and q.usage = 'challenge')), '{}'::jsonb) into challenge_counts from public.chapters c;
    return jsonb_build_object('countsByYear',jsonb_build_object('BCPST1',private.curriculum_counts('solo','BCPST1'),'BCPST2',private.curriculum_counts('solo','BCPST2')),'challengeCountsByYear',jsonb_build_object('BCPST1',private.curriculum_counts('challenge','BCPST1'),'BCPST2',private.curriculum_counts('challenge','BCPST2')),'challengeCounts', challenge_counts, 'user', private.get_current_profile(), 'chapters', chapter_list, 'counts', counts, 'progress', private.player_progress(actor));
  end if;

  if action in ('users','update_user') then
    if actor_role <> 'admin' then raise exception 'Action réservée à l’administrateur.' using errcode = '42501'; end if;
    if action = 'users' then
      select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name, 'email', u.email, 'role', p.role, 'createdAt', p.created_at) order by p.created_at desc, p.id), '[]'::jsonb)
        into result from public.profiles p join auth.users u on u.id = p.id;
      return result;
    end if;
    if payload - array['userId','role'] <> '{}'::jsonb or coalesce(payload ->> 'role', '') not in ('student','contributor','admin') then
      raise exception 'Seul le rôle peut être modifié.' using errcode = '22023';
    end if;
    begin target := (payload ->> 'userId')::uuid; exception when invalid_text_representation then raise exception 'Identifiant utilisateur invalide.' using errcode = '22023'; end;
    if target is null then raise exception 'Identifiant utilisateur requis.' using errcode = '22023'; end if;
    perform pg_advisory_xact_lock(hashtextextended('qcm-content-admin-roles', 0));
    if private.current_role() is distinct from 'admin' then raise exception 'Action réservée à l’administrateur.' using errcode = '42501'; end if;
    perform 1 from public.profiles where id = target for update;
    if not found then raise exception 'Utilisateur introuvable.' using errcode = 'P0002'; end if;
    target_role := payload ->> 'role';
    if target = actor and target_role <> 'admin' then raise exception 'Vous ne pouvez pas retirer votre propre accès administrateur.' using errcode = '22023'; end if;
    if target_role <> 'admin' and exists(select 1 from public.profiles where id = target and role = 'admin' and disabled_at is null)
      and (select count(*) from public.profiles where role = 'admin' and disabled_at is null) <= 1 then
      raise exception 'Conservez au moins un administrateur actif.' using errcode = '22023';
    end if;
    update public.profiles set role = target_role::public.app_role where id = target;
    insert into private.audit_events(actor_id, action, target_id, payload) values(actor, 'user.role_changed', target::text, jsonb_build_object('role', target_role));
    select jsonb_build_object('id', p.id, 'name', p.display_name, 'email', u.email, 'role', p.role, 'createdAt', p.created_at)
      into result from public.profiles p join auth.users u on u.id = p.id where p.id = target;
    return result;
  end if;

  if actor_role not in ('admin','contributor') then raise exception 'Espace réservé aux contributeurs.' using errcode = '42501'; end if;

  if action not in ('questions','export') then perform pg_advisory_xact_lock(hashtextextended('qcm-question-links',0)); end if;

  if action in ('questions','export') then
    if payload ? 'schoolYear' and (jsonb_typeof(payload -> 'schoolYear') is distinct from 'string' or payload ->> 'schoolYear' not in ('all','BCPST1','BCPST2')) then raise exception 'Filtre d’année invalide.' using errcode = '22023'; end if;
    select coalesce(jsonb_agg(private.content_question(q.id) order by q.updated_at desc, q.id), '[]'::jsonb) into result
      from public.questions q where q.deleted_at is null and (actor_role = 'admin' or q.author_id = actor)
        and (action = 'export' or (
          (not payload ? 'chapterId' or q.chapter_id in (select id from public.chapters where id = payload ->> 'chapterId' or parent_id = payload ->> 'chapterId'))
          and (coalesce(payload ->> 'schoolYear','all') = 'all' or q.school_year in ('both',payload ->> 'schoolYear'))
          and (not payload ? 'status' or payload ->> 'status' = q.status::text)
          and (coalesce(payload ->> 'search','') = '' or strpos(lower(q.prompt), lower(payload ->> 'search')) > 0)
        ));
    return result;
  end if;

  if action = 'import' then
    if jsonb_typeof(payload -> 'questions') is distinct from 'array' then raise exception 'Liste de questions requise.' using errcode = '22023'; end if;
    if jsonb_array_length(payload -> 'questions') not between 1 and 500 then raise exception 'Importez de 1 à 500 questions.' using errcode = '22023'; end if;
    for item in select value from jsonb_array_elements(payload -> 'questions') order by case when value ->> 'usage' = 'challenge' then 1 else 0 end loop
      if jsonb_typeof(item) <> 'object' then raise exception 'Question importée invalide.' using errcode = '22023'; end if;
      input := item || jsonb_build_object('status', case item ->> 'status' when 'published' then 'pending' when 'pending' then 'pending' when 'draft' then 'draft' when 'rejected' then 'draft' else 'draft' end);
      if item ->> 'id' is not null and imported_ids ? (item ->> 'id') then raise exception 'Identifiant dupliqué dans le fichier.' using errcode = '22023'; end if;
      if imported_ids ? (item ->> 'sourceQuestionId') then input := input || jsonb_build_object('sourceQuestionId', imported_ids ->> (item ->> 'sourceQuestionId')); end if;
      result := private.app_content('create_question', input);
      if item ->> 'id' is not null then imported_ids := imported_ids || jsonb_build_object(item ->> 'id', result ->> 'id'); end if;
      import_count := import_count + 1;
    end loop;
    insert into private.audit_events(actor_id, action, payload) values(actor, 'questions.imported', jsonb_build_object('count', import_count));
    return jsonb_build_object('imported', import_count);
  end if;

  if action = 'create_question' then
    input := private.content_input(payload, actor, actor_role);
    select array_agg(value order by ordinal) into choices from jsonb_array_elements_text(input -> 'options') with ordinality as x(value, ordinal);
    select array_agg(value::smallint order by ordinal) into answers from jsonb_array_elements_text(input -> 'correctAnswers') with ordinality as x(value, ordinal);
    insert into public.questions(school_year, usage, source_question_id, chapter_id, author_id, difficulty, prompt, options, image_path, status)
      values(input ->> 'schoolYear', input ->> 'usage', (input ->> 'sourceQuestionId')::uuid, input ->> 'chapterId', actor, (input ->> 'difficulty')::public.question_difficulty, input ->> 'prompt', choices, input ->> 'image', (input ->> 'status')::public.question_status)
      returning id into target;
    insert into private.question_keys(question_id, correct_answers) values(target, answers);
    if input ->> 'status' = 'published' then
      insert into private.question_reviews(question_id,reviewer_id,revision,decision,note) values(target,actor,1,'published','');
    end if;
    insert into private.audit_events(actor_id, action, target_id, payload) values(actor, 'question.created', target::text, jsonb_build_object('status',input ->> 'status'));
    return private.content_question(target);
  end if;

  if action not in ('update_question','delete_question','review') then raise exception 'Action inconnue.' using errcode = '22023'; end if;
  if action = 'review' and actor_role <> 'admin' then raise exception 'Seul l’administrateur valide les questions.' using errcode = '42501'; end if;
  begin target := (payload ->> 'questionId')::uuid; exception when invalid_text_representation then raise exception 'Identifiant de question invalide.' using errcode = '22023'; end;
  if target is null then raise exception 'Identifiant de question requis.' using errcode = '22023'; end if;
  select * into question_row from public.questions where id = target and deleted_at is null for update;
  if not found then raise exception 'Question introuvable.' using errcode = 'P0002'; end if;
  if actor_role <> 'admin' and (question_row.author_id <> actor or question_row.status = 'published') then
    raise exception 'Vous pouvez modifier uniquement vos questions non publiées.' using errcode = '42501';
  end if;

  if action in ('delete_question','update_question') and exists(select 1 from public.questions where source_question_id = target and deleted_at is null
    and (action = 'delete_question' or coalesce(payload ->> 'usage','solo') <> 'solo' or chapter_id is distinct from payload ->> 'chapterId')) then
    raise exception 'Supprimez ou rattachez d’abord les variantes liées à cette question.' using errcode = '22023';
  end if;

  if action = 'delete_question' then
    update public.questions set deleted_at = clock_timestamp(), updated_at = clock_timestamp(), status = 'draft', revision = revision + 1 where id = target;
    insert into private.audit_events(actor_id, action, target_id) values(actor, 'question.deleted', target::text);
    return '{}'::jsonb;
  end if;

  if action = 'review' then
    review_status := payload ->> 'status';
    if payload ? 'reviewNote' and jsonb_typeof(payload -> 'reviewNote') is distinct from 'string' then
      raise exception 'Le retour doit être un texte.' using errcode = '22023';
    end if;
    review_note := trim(coalesce(payload ->> 'reviewNote', ''));
    if coalesce(review_status, '') not in ('published','rejected') or char_length(review_note) > 2000 then raise exception 'Décision ou retour invalide.' using errcode = '22023'; end if;
    if question_row.status <> 'pending' then raise exception 'Cette question doit être soumise avant validation.' using errcode = '22023'; end if;
    if review_status = 'rejected' and review_note = '' then raise exception 'Indiquez le motif du refus.' using errcode = '22023'; end if;
    update public.questions set status = review_status::public.question_status, updated_at = clock_timestamp() where id = target;
    insert into private.question_reviews(question_id, reviewer_id, revision, decision, note) values(target, actor, question_row.revision, review_status::public.question_status, review_note);
    insert into private.audit_events(actor_id, action, target_id, payload) values(actor, 'question.reviewed', target::text, jsonb_build_object('status', review_status, 'revision', question_row.revision));
    return private.content_question(target);
  end if;

  input := private.content_input(case when payload ? 'schoolYear' then payload else payload || jsonb_build_object('schoolYear',question_row.school_year) end, actor, actor_role, question_row.image_path);
  select array_agg(value order by ordinal) into choices from jsonb_array_elements_text(input -> 'options') with ordinality as x(value, ordinal);
  select array_agg(value::smallint order by ordinal) into answers from jsonb_array_elements_text(input -> 'correctAnswers') with ordinality as x(value, ordinal);
  update public.questions set school_year = input ->> 'schoolYear', usage = input ->> 'usage', source_question_id = (input ->> 'sourceQuestionId')::uuid, chapter_id = input ->> 'chapterId', difficulty = (input ->> 'difficulty')::public.question_difficulty,
    prompt = input ->> 'prompt', options = choices, image_path = input ->> 'image', status = (input ->> 'status')::public.question_status,
    revision = revision + 1, updated_at = clock_timestamp() where id = target;
  update private.question_keys set correct_answers = answers where question_id = target;
  if input ->> 'status' = 'published' then
    insert into private.question_reviews(question_id,reviewer_id,revision,decision,note) values(target,actor,question_row.revision + 1,'published','');
  end if;
  insert into private.audit_events(actor_id, action, target_id, payload) values(actor, 'question.updated', target::text, jsonb_build_object('revision', question_row.revision + 1,'status',input ->> 'status'));
  return private.content_question(target);
end;
$$;


commit;
