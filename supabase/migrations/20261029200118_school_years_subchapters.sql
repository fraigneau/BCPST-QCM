begin;

-- Les questions existantes restent communes aux deux années ; aucun contenu ou score n’est réécrit.
alter table public.questions add column school_year text not null default 'both' check (school_year in ('BCPST1','BCPST2','both'));
alter table public.chapters add column parent_id text references public.chapters(id);
alter table public.chapters add constraint chapter_parent_not_self check (parent_id is distinct from id);
create index chapters_parent on public.chapters(parent_id);
create index questions_school_year on public.questions(school_year,chapter_id) where deleted_at is null and status = 'published';

create function private.check_chapter_parent() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists(select 1 from public.chapters child join public.chapters parent on parent.id = child.parent_id where parent.parent_id is not null) then
    raise exception 'La structure autorise un chapitre principal et ses sous-chapitres, sans niveau supplémentaire.' using errcode = '23514';
  end if;
  return null;
end;
$$;
revoke all on function private.check_chapter_parent() from public,anon,authenticated,service_role;
create constraint trigger chapter_parent_consistency after insert or update on public.chapters deferrable initially deferred for each row execute function private.check_chapter_parent();

create function private.curriculum_counts(target_usage text, target_year text) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_object_agg(c.id,(select count(*) from public.questions q where q.chapter_id = c.id and q.deleted_at is null and q.status = 'published' and q.usage = target_usage and q.school_year in ('both',target_year))),'{}'::jsonb) from public.chapters c
$$;
revoke all on function private.curriculum_counts(text,text) from public,anon,authenticated,service_role;

create or replace function private.content_question(target_question uuid) returns jsonb
language sql stable set search_path = ''
as $$
  select jsonb_build_object(
    'schoolYear', q.school_year, 'usage', q.usage, 'sourceQuestionId', q.source_question_id, 'id', q.id, 'chapterId', q.chapter_id, 'difficulty', q.difficulty,
    'prompt', q.prompt, 'options', q.options, 'correctAnswers', k.correct_answers,
    'explanation', k.explanation, 'image', q.image_path, 'status', q.status,
    'authorId', q.author_id, 'createdAt', q.created_at, 'updatedAt', q.updated_at
  ) || case when r.note is not null then jsonb_build_object('reviewNote', r.note) else '{}'::jsonb end
  from public.questions q join private.question_keys k on k.question_id = q.id
  left join private.question_reviews r on r.question_id = q.id and r.revision = q.revision and r.decision = q.status
  where q.id = target_question and q.deleted_at is null
$$;

create or replace function private.content_input(data jsonb, actor uuid, actor_role public.app_role, previous_image text default null) returns jsonb
language plpgsql set search_path = ''
as $$
declare
  choices text[];
  answers smallint[];
  image_value jsonb;
  image_name text;
  question_prompt text;
  correction text;
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
  if jsonb_typeof(data -> 'prompt') is distinct from 'string' or jsonb_typeof(data -> 'explanation') is distinct from 'string' then
    raise exception 'Énoncé et correction requis.' using errcode = '22023';
  end if;
  question_prompt := trim(data ->> 'prompt');
  correction := trim(data ->> 'explanation');
  if char_length(question_prompt) not between 10 and 5000 or char_length(correction) not between 10 and 10000 then
    raise exception 'Longueur de l’énoncé ou de la correction invalide.' using errcode = '22023';
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
    if source_id is null or not exists(select 1 from public.questions q where q.id = source_id and q.deleted_at is null
      and q.usage = 'solo' and q.chapter_id = data ->> 'chapterId' and (actor_role = 'admin' or q.author_id = actor)) then
      raise exception 'Choisissez une question solo accessible du même chapitre.' using errcode = '22023';
    end if;
  elsif data ->> 'sourceQuestionId' is not null then
    raise exception 'Une question solo ne peut pas être une variante.' using errcode = '22023';
  end if;
  next_status := coalesce(data ->> 'status', 'draft');
  if next_status not in ('draft','pending') then raise exception 'Soumettez la question avant sa publication.' using errcode = '22023'; end if;
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
    'options', choices, 'correctAnswers', answers, 'explanation', correction, 'image', image_name, 'status', next_status);
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
          and (coalesce(payload ->> 'search','') = '' or strpos(lower(q.prompt || ' ' || (select explanation from private.question_keys where question_id = q.id)), lower(payload ->> 'search')) > 0)
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
    insert into private.question_keys(question_id, correct_answers, explanation) values(target, answers, input ->> 'explanation');
    insert into private.audit_events(actor_id, action, target_id) values(actor, 'question.created', target::text);
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
  update private.question_keys set correct_answers = answers, explanation = input ->> 'explanation' where question_id = target;
  insert into private.audit_events(actor_id, action, target_id, payload) values(actor, 'question.updated', target::text, jsonb_build_object('revision', question_row.revision + 1));
  return private.content_question(target);
end;
$$;

create or replace function private.app_game(action text, payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
  at_time timestamptz := clock_timestamp();
  g public.games%rowtype;
  target_game uuid;
  requested_question uuid;
  chapter_ids text[];
  chosen_ids uuid[];
  requested_count integer;
  requested_difficulty text;
  requested_year text;
  mistakes_only boolean;
  invitation text;
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  selected_indices smallint[];
  question_record private.game_questions%rowtype;
  elapsed integer;
  correct boolean;
  awarded integer;
  next_host uuid;
begin
  if actor is null or private.current_role() is null then raise exception 'Authentification requise ou profil désactivé.' using errcode = '42501'; end if;
  if payload is null or jsonb_typeof(payload) <> 'object' or octet_length(payload::text) > 8192 then raise exception 'Données invalides.' using errcode = '22023'; end if;
  if action = 'progress' then return private.player_progress(actor); end if;
  if action = 'leaderboard' then return private.game_leaderboard(nullif(payload->>'chapterId','')); end if;
  if action in ('solo','create_room') then
    if payload ? 'chapterIds' and (jsonb_typeof(payload->'chapterIds') <> 'array' or jsonb_array_length(payload->'chapterIds') > 100) then raise exception 'Sélection de chapitres invalide.' using errcode = '22023'; end if;
    if exists(select 1 from jsonb_array_elements(coalesce(payload->'chapterIds','[]'::jsonb)) item where jsonb_typeof(item) <> 'string') then raise exception 'Sélection de chapitres invalide.' using errcode = '22023'; end if;
    select coalesce(array_agg(value),array[]::text[]) into chapter_ids from jsonb_array_elements_text(coalesce(payload->'chapterIds','[]'::jsonb));
    if cardinality(chapter_ids) = 0 then select array_agg(id order by sort_order,id) into chapter_ids from public.chapters; end if;
    if chapter_ids is null or cardinality(chapter_ids) <> (select count(distinct chosen.id) from unnest(chapter_ids) chosen(id)) or exists(select 1 from unnest(chapter_ids) chosen(id) where not exists(select 1 from public.chapters c where c.id = chosen.id)) then raise exception 'Chapitre inconnu ou répété.' using errcode = '22023'; end if;
    -- Les chapitres principaux incluent leurs sous-chapitres ; le DISTINCT évite les doublons.
    select array_agg(distinct c.id) into chapter_ids from public.chapters c where c.id = any(chapter_ids) or c.parent_id = any(chapter_ids);
    requested_year := coalesce(payload ->> 'schoolYear','all');
    if requested_year not in ('all','BCPST1','BCPST2') or (payload ? 'schoolYear' and jsonb_typeof(payload -> 'schoolYear') is distinct from 'string') then raise exception 'Année BCPST invalide.' using errcode = '22023'; end if;
    if payload ? 'count' and (jsonb_typeof(payload->'count') <> 'number' or (payload->>'count') !~ '^[0-9]{1,2}$') then raise exception 'Nombre de questions invalide.' using errcode = '22023'; end if;
    requested_count := coalesce((payload->>'count')::integer,10);
    if requested_count not between 1 and 30 then raise exception 'Choisissez entre 1 et 30 questions.' using errcode = '22023'; end if;
    requested_difficulty := coalesce(payload->>'difficulty','all');
    if requested_difficulty not in ('all','easy','medium','hard') then raise exception 'Difficulté invalide.' using errcode = '22023'; end if;
    if payload ? 'mistakesOnly' and jsonb_typeof(payload->'mistakesOnly') <> 'boolean' then raise exception 'Filtre de révision invalide.' using errcode = '22023'; end if;
    mistakes_only := coalesce((payload->>'mistakesOnly')::boolean,false);
    if mistakes_only then perform private.player_progress(actor); end if;
    select array_agg(picked.id) into chosen_ids from (
      select q.id from public.questions q join private.question_keys k on k.question_id = q.id
      where q.status = 'published' and q.deleted_at is null and q.chapter_id = any(chapter_ids)
        and (requested_year = 'all' or q.school_year in ('both',requested_year))
        and q.usage = case when action = 'solo' then 'solo' else 'challenge' end
        and (action = 'solo' or cardinality(k.correct_answers) = 1)
        and (requested_difficulty = 'all' or q.difficulty::text = requested_difficulty)
        and (not mistakes_only or exists(
          select 1 from (
            select distinct on(coalesce(gq.source_question_id,gq.question_id)) coalesce(gq.source_question_id,gq.question_id) as question_id,s.is_correct from private.game_visible_submissions(actor) s
            join private.game_questions gq on gq.game_id = s.game_id and gq.position = s.question_index
            order by coalesce(gq.source_question_id,gq.question_id),s.received_at desc,s.game_id desc,s.question_index desc
          ) latest where latest.question_id = q.id and not latest.is_correct
        ))
      order by random() limit requested_count
    ) picked;
    if chosen_ids is null or cardinality(chosen_ids) = 0 then raise exception '%', case when action = 'solo' then 'Aucun QCM solo publié pour cette sélection.' else 'Aucune variante QCS publiée pour ces chapitres.' end using errcode = '22023'; end if;
    if action = 'create_room' then
      loop
        select string_agg(substr(alphabet,1 + floor(random() * length(alphabet))::integer,1),'') into invitation from generate_series(1,6);
        begin
          insert into public.games(host_id,invitation_code,mode,status,question_count,config)
            values(actor,invitation,'multi','waiting',cardinality(chosen_ids),jsonb_build_object('schoolYear',requested_year,'chapterIds',chapter_ids,'difficulty',requested_difficulty)) returning * into g;
          exit;
        exception when unique_violation then null;
        end;
      end loop;
    else
      insert into public.games(host_id,mode,status,question_count,question_started_at,config)
        values(actor,'solo','playing',cardinality(chosen_ids),at_time,jsonb_build_object('schoolYear',requested_year,'chapterIds',chapter_ids,'difficulty',requested_difficulty)) returning * into g;
    end if;
    insert into public.game_players(game_id,player_id,joined_at,last_seen_at) values(g.id,actor,at_time,at_time);
    insert into private.game_questions(game_id,position,question_id,chapter_id,source_question_id,public_snapshot,correct_answers,explanation)
      select g.id,(chosen.ordinality - 1)::integer,q.id,q.chapter_id,q.source_question_id,
        jsonb_build_object('schoolYear',q.school_year,'usage',q.usage,'id',q.id,'chapterId',q.chapter_id,'difficulty',q.difficulty,'prompt',q.prompt,'options',q.options,'image',q.image_path,'status',q.status,'createdAt',q.created_at,'updatedAt',q.updated_at),
        k.correct_answers,k.explanation
      from unnest(chosen_ids) with ordinality chosen(id,ordinality) join public.questions q on q.id = chosen.id join private.question_keys k on k.question_id = q.id;
    return private.game_state_json(g.id,actor,at_time) || jsonb_build_object('schoolYear',coalesce(g.config ->> 'schoolYear','all'));
  end if;
  if action = 'join_room' then
    invitation := upper(trim(coalesce(payload->>'code','')));
    if invitation !~ '^[A-Z2-9]{6}$' then raise exception 'Le code contient 6 caractères.' using errcode = '22023'; end if;
    select * into g from public.games where invitation_code = invitation and mode = 'multi' for update;
    if not found then raise exception 'Code de salon introuvable.' using errcode = 'P0002'; end if;
    if not exists(select 1 from public.game_players where game_id = g.id and player_id = actor) then
      if g.status <> 'waiting' then raise exception 'Cette partie a déjà commencé.' using errcode = '55000'; end if;
      if (select count(*) from public.game_players where game_id = g.id) >= 12 then raise exception 'Ce salon est complet.' using errcode = '55000'; end if;
      insert into public.game_players(game_id,player_id,joined_at,last_seen_at) values(g.id,actor,at_time,at_time);
    end if;
  else
    if action not in ('state','start','answer','next','leave') then raise exception 'Action inconnue.' using errcode = '22023'; end if;
    begin target_game := (payload->>'gameId')::uuid;
    exception when invalid_text_representation then raise exception 'Identifiant de partie invalide.' using errcode = '22023'; end;
    select * into g from public.games where id = target_game for update;
    if not found then raise exception 'Partie introuvable.' using errcode = 'P0002'; end if;
    if not exists(select 1 from public.game_players where game_id = g.id and player_id = actor) then raise exception 'Vous ne participez pas à cette partie.' using errcode = '42501'; end if;
  end if;
  at_time := clock_timestamp();
  perform private.game_advance(g.id,at_time);
  select * into g from public.games where id = g.id;
  update public.game_players set last_seen_at = at_time where game_id = g.id and player_id = actor;
  if action = 'start' then
    if g.host_id <> actor then raise exception 'Seul l’hôte peut lancer la partie.' using errcode = '42501'; end if;
    if g.mode <> 'multi' or g.status <> 'waiting' then raise exception 'Cette partie a déjà commencé.' using errcode = '55000'; end if;
    if (select count(*) from public.game_players gp join public.profiles p on p.id = gp.player_id where gp.game_id = g.id and p.disabled_at is null) < 2 then raise exception 'Invitez au moins un autre joueur.' using errcode = '55000'; end if;
    update public.games set status = 'playing',phase = 'question',question_started_at = at_time,
      deadline = at_time + question_duration_ms * interval '1 millisecond',correction_until = null where id = g.id returning * into g;
  elsif action = 'answer' then
    begin requested_question := (payload->>'questionId')::uuid;
    exception when invalid_text_representation then raise exception 'Identifiant de question invalide.' using errcode = '22023'; end;
    select * into question_record from private.game_questions where game_id = g.id and position = g.question_index;
    if requested_question is distinct from question_record.question_id then raise exception 'Cette question est déjà terminée ou invalide.' using errcode = '55000'; end if;
    if exists(select 1 from public.submissions where game_id = g.id and player_id = actor and question_index = g.question_index) then raise exception 'Votre réponse a déjà été enregistrée.' using errcode = '23505'; end if;
    if g.status <> 'playing' or g.phase <> 'question' or (g.mode = 'multi' and at_time >= g.deadline) then raise exception 'Le délai de réponse est écoulé.' using errcode = '55000'; end if;
    if not(payload ? 'selected') or jsonb_typeof(payload->'selected') <> 'array' then raise exception 'Réponse invalide.' using errcode = '22023'; end if;
    if jsonb_array_length(payload->'selected') not between 1 and 4 or exists(select 1 from jsonb_array_elements(payload->'selected') item where jsonb_typeof(item) <> 'number' or item::text !~ '^[0-3]$') then raise exception 'Sélectionnez entre 1 et 4 réponses distinctes.' using errcode = '22023'; end if;
    select array_agg(value::smallint order by ordinality) into selected_indices from jsonb_array_elements_text(payload->'selected') with ordinality;
    if g.mode = 'multi' and question_record.public_snapshot ->> 'usage' = 'challenge' and cardinality(selected_indices) <> 1 then raise exception 'Choisissez une seule réponse pour ce défi.' using errcode = '22023'; end if;
    if not private.valid_answer_indices(selected_indices) then raise exception 'Les réponses doivent être distinctes.' using errcode = '22023'; end if;
    elapsed := least(2147483647,greatest(0,floor(extract(epoch from (at_time - g.question_started_at)) * 1000)))::integer;
    correct := selected_indices @> question_record.correct_answers and selected_indices <@ question_record.correct_answers;
    awarded := case when not correct then 0 when g.mode = 'solo' then 100 else 100 + floor(50 * greatest(0,1 - elapsed::numeric / g.question_duration_ms))::integer end;
    insert into public.submissions(game_id,player_id,question_index,selected,received_at,elapsed_ms,is_correct,points)
      values(g.id,actor,g.question_index,selected_indices,at_time,elapsed,correct,awarded);
    if not exists(select 1 from public.game_players gp where gp.game_id = g.id and not exists(select 1 from public.submissions s where s.game_id = g.id and s.player_id = gp.player_id and s.question_index = g.question_index)) then
      update public.games set phase = 'correction',correction_until = case when mode = 'multi' then at_time + interval '5 seconds' else null end where id = g.id returning * into g;
    end if;
  elsif action = 'next' then
    if g.mode <> 'solo' or g.host_id <> actor then raise exception 'Les questions du défi avancent automatiquement.' using errcode = '42501'; end if;
    if g.status <> 'playing' or g.phase <> 'correction' then raise exception 'La correction n’est pas encore disponible.' using errcode = '55000'; end if;
    if g.question_index + 1 >= g.question_count then
      update public.games set status = 'finished',finished_at = at_time,deadline = null,correction_until = null where id = g.id returning * into g;
      perform private.game_finish_results(g.id);
    else
      update public.games set question_index = question_index + 1,phase = 'question',question_started_at = at_time,deadline = null,correction_until = null where id = g.id returning * into g;
    end if;
  elsif action = 'leave' then
    if g.status = 'waiting' then
      delete from public.game_players where game_id = g.id and player_id = actor;
      select gp.player_id into next_host from public.game_players gp join public.profiles p on p.id = gp.player_id where gp.game_id = g.id order by (p.disabled_at is null) desc,gp.joined_at,gp.player_id limit 1;
      if next_host is null then update public.games set status = 'abandoned',finished_at = at_time where id = g.id;
      elsif g.host_id = actor then update public.games set host_id = next_host where id = g.id; end if;
    else update public.game_players set last_seen_at = at_time - interval '1 hour' where game_id = g.id and player_id = actor; end if;
    return '{}'::jsonb;
  end if;
  return private.game_state_json(g.id,actor,at_time) || jsonb_build_object('schoolYear',coalesce(g.config ->> 'schoolYear','all'));
end;
$$;

commit;
