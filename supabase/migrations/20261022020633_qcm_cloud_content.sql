begin;

create function private.content_question(target_question uuid) returns jsonb
language sql stable set search_path = ''
as $$
  select jsonb_build_object(
    'id', q.id, 'chapterId', q.chapter_id, 'difficulty', q.difficulty,
    'prompt', q.prompt, 'options', q.options, 'correctAnswers', k.correct_answers,
    'explanation', k.explanation, 'image', q.image_path, 'status', q.status,
    'authorId', q.author_id, 'createdAt', q.created_at, 'updatedAt', q.updated_at
  ) || case when r.note is not null then jsonb_build_object('reviewNote', r.note) else '{}'::jsonb end
  from public.questions q join private.question_keys k on k.question_id = q.id
  left join private.question_reviews r on r.question_id = q.id and r.revision = q.revision and r.decision = q.status
  where q.id = target_question and q.deleted_at is null
$$;

revoke all on function private.content_question(uuid) from public, anon, authenticated, service_role;

create function private.content_input(data jsonb, actor uuid, actor_role public.app_role, previous_image text default null) returns jsonb
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
begin
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
  next_status := coalesce(data ->> 'status', 'draft');
  if next_status not in ('draft','pending') then raise exception 'Soumettez la question avant sa publication.' using errcode = '22023'; end if;
  image_value := case when data ? 'imagePath' then data -> 'imagePath' else data -> 'image' end;
  if image_value is not null and image_value <> 'null'::jsonb then
    if jsonb_typeof(image_value) <> 'string' then raise exception 'Image invalide.' using errcode = '22023'; end if;
    image_name := image_value #>> '{}';
    if image_name not in ('/illustrations/cell.svg','/illustrations/leaf.svg','/illustrations/subduction.svg') then
      if image_name !~ '^[0-9a-fA-F-]{36}/[A-Za-z0-9_-]+\.(png|jpg|jpeg|webp)$'
        or not (split_part(image_name, '/', 1) = actor::text or (actor_role = 'admin' and image_name = previous_image))
        or not exists(select 1 from storage.objects where bucket_id = 'question-images' and name = image_name) then
        raise exception 'Importez une image dans votre espace avant de l’associer à la question.' using errcode = '22023';
      end if;
    end if;
  end if;
  return jsonb_build_object('chapterId', data ->> 'chapterId', 'difficulty', data ->> 'difficulty', 'prompt', question_prompt,
    'options', choices, 'correctAnswers', answers, 'explanation', correction, 'image', image_name, 'status', next_status);
end;
$$;

revoke all on function private.content_input(jsonb, uuid, public.app_role, text) from public, anon, authenticated, service_role;

create function private.can_read_game_image(image_name text) returns boolean
language sql stable security definer set search_path = ''
as $$
  select (select private.current_role()) is not null and exists(
    select 1 from private.game_questions q join public.game_players p on p.game_id = q.game_id
    where p.player_id = (select auth.uid()) and q.public_snapshot ->> 'image' = image_name
  )
$$;

revoke all on function private.can_read_game_image(text) from public, anon, authenticated, service_role;
grant execute on function private.can_read_game_image(text) to authenticated;

create policy image_game_member_read on storage.objects for select to authenticated
using (bucket_id = 'question-images' and private.can_read_game_image(name));

create function private.app_content(action text, payload jsonb default '{}'::jsonb) returns jsonb
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

  if action in ('bootstrap','chapters') then
    select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'shortName', c.short_name,
      'description', c.description, 'color', c.color, 'icon', c.icon) order by c.sort_order, c.id), '[]'::jsonb)
      into chapter_list from public.chapters c;
    if action = 'chapters' then return chapter_list; end if;
    select coalesce(jsonb_object_agg(c.id, (select count(*) from public.questions q where q.chapter_id = c.id and q.status = 'published' and q.deleted_at is null)), '{}'::jsonb)
      into counts from public.chapters c;
    return jsonb_build_object('user', private.get_current_profile(), 'chapters', chapter_list, 'counts', counts, 'progress', private.player_progress(actor));
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

  if action in ('questions','export') then
    select coalesce(jsonb_agg(private.content_question(q.id) order by q.updated_at desc, q.id), '[]'::jsonb) into result
      from public.questions q where q.deleted_at is null and (actor_role = 'admin' or q.author_id = actor)
        and (action = 'export' or (
          (not payload ? 'chapterId' or payload ->> 'chapterId' = q.chapter_id)
          and (not payload ? 'status' or payload ->> 'status' = q.status::text)
          and (coalesce(payload ->> 'search','') = '' or strpos(lower(q.prompt || ' ' || (select explanation from private.question_keys where question_id = q.id)), lower(payload ->> 'search')) > 0)
        ));
    return result;
  end if;

  if action = 'import' then
    if jsonb_typeof(payload -> 'questions') is distinct from 'array' then raise exception 'Liste de questions requise.' using errcode = '22023'; end if;
    if jsonb_array_length(payload -> 'questions') not between 1 and 500 then raise exception 'Importez de 1 à 500 questions.' using errcode = '22023'; end if;
    for item in select value from jsonb_array_elements(payload -> 'questions') loop
      if jsonb_typeof(item) <> 'object' then raise exception 'Question importée invalide.' using errcode = '22023'; end if;
      input := item || jsonb_build_object('status', case item ->> 'status' when 'published' then 'pending' when 'pending' then 'pending' when 'draft' then 'draft' when 'rejected' then 'draft' else 'draft' end);
      perform private.app_content('create_question', input);
      import_count := import_count + 1;
    end loop;
    insert into private.audit_events(actor_id, action, payload) values(actor, 'questions.imported', jsonb_build_object('count', import_count));
    return jsonb_build_object('imported', import_count);
  end if;

  if action = 'create_question' then
    input := private.content_input(payload, actor, actor_role);
    select array_agg(value order by ordinal) into choices from jsonb_array_elements_text(input -> 'options') with ordinality as x(value, ordinal);
    select array_agg(value::smallint order by ordinal) into answers from jsonb_array_elements_text(input -> 'correctAnswers') with ordinality as x(value, ordinal);
    insert into public.questions(chapter_id, author_id, difficulty, prompt, options, image_path, status)
      values(input ->> 'chapterId', actor, (input ->> 'difficulty')::public.question_difficulty, input ->> 'prompt', choices, input ->> 'image', (input ->> 'status')::public.question_status)
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

  input := private.content_input(payload, actor, actor_role, question_row.image_path);
  select array_agg(value order by ordinal) into choices from jsonb_array_elements_text(input -> 'options') with ordinality as x(value, ordinal);
  select array_agg(value::smallint order by ordinal) into answers from jsonb_array_elements_text(input -> 'correctAnswers') with ordinality as x(value, ordinal);
  update public.questions set chapter_id = input ->> 'chapterId', difficulty = (input ->> 'difficulty')::public.question_difficulty,
    prompt = input ->> 'prompt', options = choices, image_path = input ->> 'image', status = (input ->> 'status')::public.question_status,
    revision = revision + 1, updated_at = clock_timestamp() where id = target;
  update private.question_keys set correct_answers = answers, explanation = input ->> 'explanation' where question_id = target;
  insert into private.audit_events(actor_id, action, target_id, payload) values(actor, 'question.updated', target::text, jsonb_build_object('revision', question_row.revision + 1));
  return private.content_question(target);
end;
$$;

revoke all on function private.app_content(text, jsonb) from public, anon, authenticated, service_role;
grant execute on function private.app_content(text, jsonb) to authenticated;

create function public.qcm_content(action text, payload jsonb default '{}'::jsonb) returns jsonb
language sql security invoker set search_path = ''
as $$
  select private.app_content(action, payload)
$$;

revoke all on function public.qcm_content(text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.qcm_content(text, jsonb) to authenticated;

commit;
