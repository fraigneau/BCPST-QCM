begin;

alter table public.games add column config jsonb not null default '{}'::jsonb;
alter table public.games add column correction_until timestamptz;
create index games_pending_multi_idx on public.games(id) where mode = 'multi' and status = 'playing';

create function private.game_finish_results(target_game uuid) returns void
language sql security definer set search_path = ''
as $$
  insert into public.chapter_results(game_id, player_id, chapter_id, points, answered, correct, created_at)
  select gp.game_id, gp.player_id, gq.chapter_id,
    coalesce(sum(s.points),0)::integer, count(s.question_index)::integer,
    count(s.question_index) filter(where s.is_correct)::integer, coalesce(g.finished_at,clock_timestamp())
  from public.game_players gp join public.games g on g.id = gp.game_id
  join private.game_questions gq on gq.game_id = gp.game_id
  left join public.submissions s on s.game_id = gp.game_id and s.player_id = gp.player_id and s.question_index = gq.position
  where gp.game_id = target_game and g.status = 'finished'
  group by gp.game_id,gp.player_id,gq.chapter_id,g.finished_at
  on conflict(game_id,player_id,chapter_id) do update
    set points = excluded.points, answered = excluded.answered, correct = excluded.correct;
$$;

create function private.game_advance(target_game uuid, at_time timestamptz) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  g public.games%rowtype;
  boundary timestamptz;
begin
  select * into g from public.games where id = target_game for update;
  if not found or g.mode <> 'multi' or g.status <> 'playing' then return; end if;
  at_time := greatest(at_time,clock_timestamp());
  loop
    if g.phase = 'question' and at_time >= g.deadline then
      insert into public.submissions(game_id,player_id,question_index,selected,received_at,elapsed_ms,is_correct,points,timed_out)
      select g.id,gp.player_id,g.question_index,array[]::smallint[],g.deadline,g.question_duration_ms,false,0,true
      from public.game_players gp where gp.game_id = g.id
      on conflict(game_id,player_id,question_index) do nothing;
      update public.games set phase = 'correction',correction_until = g.deadline + interval '5 seconds' where id = g.id returning * into g;
    end if;
    if g.phase <> 'correction' or at_time < g.correction_until then exit; end if;
    boundary := g.correction_until;
    if g.question_index + 1 >= g.question_count then
      update public.games set status = 'finished',finished_at = boundary,deadline = null,correction_until = null where id = g.id returning * into g;
      perform private.game_finish_results(g.id);
      exit;
    end if;
    update public.games set question_index = g.question_index + 1,phase = 'question',
      question_started_at = boundary,deadline = boundary + g.question_duration_ms * interval '1 millisecond',correction_until = null
      where id = g.id returning * into g;
  end loop;
end;
$$;

create function private.game_visible_submissions(target_user uuid default null) returns setof public.submissions
language sql security definer set search_path = ''
as $$
  select s.* from public.submissions s join public.games g on g.id = s.game_id
  where (target_user is null or s.player_id = target_user)
    and not(g.mode = 'multi' and g.status = 'playing' and g.phase = 'question' and s.question_index = g.question_index);
$$;

create function private.game_answer_json(target_game uuid, target_user uuid, target_index integer) returns jsonb
language sql security definer set search_path = ''
as $$
  select jsonb_build_object('questionId',gq.question_id,'selected',s.selected,'correctAnswers',gq.correct_answers,
    'explanation',gq.explanation,'correct',s.is_correct,'points',s.points,'elapsedMs',s.elapsed_ms)
  from public.submissions s join private.game_questions gq on gq.game_id = s.game_id and gq.position = s.question_index
  where s.game_id = target_game and s.player_id = target_user and s.question_index = target_index;
$$;

create function private.game_state_json(target_game uuid, target_user uuid, at_time timestamptz) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  g public.games%rowtype;
  reveal boolean;
  current_question jsonb;
  current_result jsonb;
  own_results jsonb;
  players jsonb;
  chapter_ids jsonb;
begin
  select * into g from public.games where id = target_game;
  if not exists(select 1 from public.game_players where game_id = target_game and player_id = target_user) then
    raise exception 'Vous ne participez pas à cette partie.' using errcode = '42501';
  end if;
  reveal := g.mode = 'solo' or g.phase = 'correction' or g.status = 'finished';
  if g.status = 'playing' then select public_snapshot into current_question from private.game_questions where game_id = g.id and position = g.question_index; end if;
  if reveal then current_result := private.game_answer_json(g.id,target_user,g.question_index); end if;
  select coalesce(jsonb_agg(private.game_answer_json(g.id,target_user,s.question_index) order by s.question_index),'[]'::jsonb)
    into own_results from public.submissions s where s.game_id = g.id and s.player_id = target_user and (reveal or s.question_index < g.question_index);
  select coalesce(jsonb_agg(jsonb_build_object('id',gp.player_id,'name',p.display_name,
    'score',coalesce((select sum(s.points) from public.submissions s where s.game_id = g.id and s.player_id = gp.player_id
      and not(g.mode = 'multi' and g.status = 'playing' and g.phase = 'question' and s.question_index = g.question_index)),0),
    'answered',exists(select 1 from public.submissions s where s.game_id = g.id and s.player_id = gp.player_id and s.question_index = g.question_index),
    'connected',p.disabled_at is null and gp.last_seen_at > at_time - interval '15 seconds') order by gp.joined_at,gp.player_id),'[]'::jsonb)
    into players from public.game_players gp join public.profiles p on p.id = gp.player_id where gp.game_id = g.id;
  chapter_ids := g.config->'chapterIds';
  if chapter_ids is null then select coalesce(jsonb_agg(distinct chapter_id),'[]'::jsonb) into chapter_ids from private.game_questions where game_id = g.id; end if;
  return jsonb_build_object('id',g.id,'mode',g.mode,'code',g.invitation_code,
    'status',case when g.status = 'abandoned' then 'finished' else g.status::text end,'phase',g.phase,'chapterIds',chapter_ids,
    'hostId',g.host_id,'questionIndex',g.question_index,'totalQuestions',g.question_count,'question',current_question,
    'deadline',case when g.mode = 'solo' then null else extract(epoch from case when g.phase = 'correction' then g.correction_until else g.deadline end) * 1000 end,
    'serverNow',floor(extract(epoch from at_time) * 1000),'players',players,'result',current_result,'results',own_results);
end;
$$;

create function private.player_progress(target_user uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  game_id uuid;
  at_time timestamptz := clock_timestamp();
  today date := (clock_timestamp() at time zone 'Europe/Paris')::date;
  cursor_day date;
  streak integer := 0;
  answer_count bigint;
  correct_count bigint;
  total_points bigint;
  chapter_data jsonb;
  recent_data jsonb;
  mistakes_data jsonb;
  daily_data jsonb;
begin
  if target_user is distinct from (select auth.uid()) or private.current_role() is null then raise exception 'Profil indisponible.' using errcode = '42501'; end if;
  for game_id in select g.id from public.games g join public.game_players gp on gp.game_id = g.id where gp.player_id = target_user and g.mode = 'multi' and g.status = 'playing' order by g.id loop
    perform private.game_advance(game_id,at_time);
  end loop;
  select count(*),count(*) filter(where is_correct),coalesce(sum(points),0) into answer_count,correct_count,total_points from private.game_visible_submissions(target_user);
  select coalesce(jsonb_agg(jsonb_build_object('chapterId',c.id,'answered',coalesce(stats.answered,0),'correct',coalesce(stats.correct,0),'points',coalesce(stats.points,0)) order by c.sort_order,c.id),'[]'::jsonb)
    into chapter_data from public.chapters c left join lateral (
      select count(*) answered,count(*) filter(where s.is_correct) correct,coalesce(sum(s.points),0) points
      from private.game_visible_submissions(target_user) s join private.game_questions gq on gq.game_id = s.game_id and gq.position = s.question_index where gq.chapter_id = c.id
    ) stats on true;
  select coalesce(jsonb_agg(jsonb_build_object('id',entry.id,'mode',entry.mode,'score',entry.score,'total',entry.question_count,'correct',entry.correct,'createdAt',entry.created_at) order by entry.finished_at desc,entry.id),'[]'::jsonb)
    into recent_data from (
      select g.id,g.mode,g.question_count,g.created_at,g.finished_at,coalesce(sum(s.points),0) score,count(s.question_index) filter(where s.is_correct) correct
      from public.games g join public.game_players gp on gp.game_id = g.id and gp.player_id = target_user
      left join public.submissions s on s.game_id = g.id and s.player_id = target_user where g.status = 'finished'
      group by g.id order by g.finished_at desc,g.id limit 8
    ) entry;
  with visible as materialized (select * from private.game_visible_submissions(target_user)), latest as (
    select distinct on(gq.question_id) gq.question_id,gq.chapter_id,gq.public_snapshot->>'prompt' prompt,s.is_correct
    from visible s join private.game_questions gq on gq.game_id = s.game_id and gq.position = s.question_index
    order by gq.question_id,s.received_at desc,s.game_id desc,s.question_index desc
  ), errors as (
    select gq.question_id,count(*) error_count from visible s join private.game_questions gq on gq.game_id = s.game_id and gq.position = s.question_index where not s.is_correct group by gq.question_id
  ) select coalesce(jsonb_agg(jsonb_build_object('questionId',l.question_id,'prompt',l.prompt,'chapterId',l.chapter_id,'count',e.error_count) order by e.error_count desc,l.question_id),'[]'::jsonb)
    into mistakes_data from latest l join errors e on e.question_id = l.question_id where not l.is_correct;
  with activity as (
    select (received_at at time zone 'Europe/Paris')::date as activity_day,count(*) as answered from private.game_visible_submissions(target_user) group by 1
  ) select jsonb_agg(jsonb_build_object('date',to_char(d.activity_day,'YYYY-MM-DD'),'answered',coalesce(a.answered,0)) order by d.activity_day)
    into daily_data from (select today - series.day_offset as activity_day from generate_series(0,13) as series(day_offset)) d left join activity a on a.activity_day = d.activity_day;
  cursor_day := today;
  if not exists(select 1 from private.game_visible_submissions(target_user) s where (s.received_at at time zone 'Europe/Paris')::date = cursor_day) then cursor_day := cursor_day - 1; end if;
  while exists(select 1 from private.game_visible_submissions(target_user) s where (s.received_at at time zone 'Europe/Paris')::date = cursor_day) loop streak := streak + 1; cursor_day := cursor_day - 1; end loop;
  return jsonb_build_object('totalPoints',total_points,'answered',answer_count,'correct',correct_count,'accuracy',case when answer_count > 0 then round(correct_count::numeric / answer_count * 100) else 0 end,
    'gamesPlayed',(select count(*) from public.games g join public.game_players gp on gp.game_id = g.id where gp.player_id = target_user and g.status = 'finished'),
    'streak',streak,'chapters',chapter_data,'recentGames',recent_data,'mistakes',mistakes_data,'daily',daily_data);
end;
$$;

create function private.game_leaderboard(target_chapter text default null) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  game_id uuid;
  result jsonb;
  at_time timestamptz := clock_timestamp();
begin
  if private.current_role() is null then raise exception 'Authentification requise.' using errcode = '42501'; end if;
  if target_chapter is not null and not exists(select 1 from public.chapters where id = target_chapter) then raise exception 'Chapitre inconnu.' using errcode = '22023'; end if;
  for game_id in select id from public.games where mode = 'multi' and status = 'playing' order by id loop perform private.game_advance(game_id,at_time); end loop;
  with totals as (
    select p.id,p.display_name,coalesce(sum(r.points),0) points,coalesce(sum(r.answered),0) answered,coalesce(sum(r.correct),0) correct
    from public.profiles p left join public.chapter_results r on r.player_id = p.id and (target_chapter is null or r.chapter_id = target_chapter)
      and exists(select 1 from public.games g where g.id = r.game_id and g.status = 'finished')
    where p.disabled_at is null group by p.id,p.display_name
  ), accuracy as (
    select *,case when answered > 0 then round(correct::numeric / answered * 100) else 0 end accuracy from totals
  ), ranked as (
    select *,rank() over(order by points desc,accuracy desc) rank from accuracy
  ) select coalesce(jsonb_agg(jsonb_build_object('userId',id,'name',display_name,'points',points,'accuracy',accuracy,'answered',answered,'rank',rank) order by rank,display_name,id),'[]'::jsonb) into result from ranked;
  return result;
end;
$$;

create function private.app_game(action text, payload jsonb default '{}'::jsonb) returns jsonb
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
    if payload ? 'chapterIds' and (jsonb_typeof(payload->'chapterIds') <> 'array' or jsonb_array_length(payload->'chapterIds') > 5) then raise exception 'Sélection de chapitres invalide.' using errcode = '22023'; end if;
    if exists(select 1 from jsonb_array_elements(coalesce(payload->'chapterIds','[]'::jsonb)) item where jsonb_typeof(item) <> 'string') then raise exception 'Sélection de chapitres invalide.' using errcode = '22023'; end if;
    select coalesce(array_agg(value),array[]::text[]) into chapter_ids from jsonb_array_elements_text(coalesce(payload->'chapterIds','[]'::jsonb));
    if cardinality(chapter_ids) = 0 then select array_agg(id order by sort_order,id) into chapter_ids from public.chapters; end if;
    if chapter_ids is null or cardinality(chapter_ids) <> (select count(distinct chosen.id) from unnest(chapter_ids) chosen(id)) or exists(select 1 from unnest(chapter_ids) chosen(id) where not exists(select 1 from public.chapters c where c.id = chosen.id)) then raise exception 'Chapitre inconnu ou répété.' using errcode = '22023'; end if;
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
        and (requested_difficulty = 'all' or q.difficulty::text = requested_difficulty)
        and (not mistakes_only or exists(
          select 1 from (
            select distinct on(gq.question_id) gq.question_id,s.is_correct from private.game_visible_submissions(actor) s
            join private.game_questions gq on gq.game_id = s.game_id and gq.position = s.question_index
            order by gq.question_id,s.received_at desc,s.game_id desc,s.question_index desc
          ) latest where latest.question_id = q.id and not latest.is_correct
        ))
      order by random() limit requested_count
    ) picked;
    if chosen_ids is null or cardinality(chosen_ids) = 0 then raise exception 'Aucune question disponible pour cette sélection.' using errcode = '22023'; end if;
    if action = 'create_room' then
      loop
        select string_agg(substr(alphabet,1 + floor(random() * length(alphabet))::integer,1),'') into invitation from generate_series(1,6);
        begin
          insert into public.games(host_id,invitation_code,mode,status,question_count,config)
            values(actor,invitation,'multi','waiting',cardinality(chosen_ids),jsonb_build_object('chapterIds',chapter_ids,'difficulty',requested_difficulty)) returning * into g;
          exit;
        exception when unique_violation then null;
        end;
      end loop;
    else
      insert into public.games(host_id,mode,status,question_count,question_started_at,config)
        values(actor,'solo','playing',cardinality(chosen_ids),at_time,jsonb_build_object('chapterIds',chapter_ids,'difficulty',requested_difficulty)) returning * into g;
    end if;
    insert into public.game_players(game_id,player_id,joined_at,last_seen_at) values(g.id,actor,at_time,at_time);
    insert into private.game_questions(game_id,position,question_id,chapter_id,public_snapshot,correct_answers,explanation)
      select g.id,(chosen.ordinality - 1)::integer,q.id,q.chapter_id,
        jsonb_build_object('id',q.id,'chapterId',q.chapter_id,'difficulty',q.difficulty,'prompt',q.prompt,'options',q.options,'image',q.image_path,'status',q.status,'createdAt',q.created_at,'updatedAt',q.updated_at),
        k.correct_answers,k.explanation
      from unnest(chosen_ids) with ordinality chosen(id,ordinality) join public.questions q on q.id = chosen.id join private.question_keys k on k.question_id = q.id;
    return private.game_state_json(g.id,actor,at_time);
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
  return private.game_state_json(g.id,actor,at_time);
end;
$$;

revoke all on function private.game_finish_results(uuid),private.game_advance(uuid,timestamptz),private.game_visible_submissions(uuid),private.game_answer_json(uuid,uuid,integer),private.game_state_json(uuid,uuid,timestamptz),private.player_progress(uuid),private.game_leaderboard(text),private.app_game(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function private.app_game(text,jsonb) to authenticated;

create function public.qcm_game(action text,payload jsonb default '{}'::jsonb) returns jsonb
language sql security invoker set search_path = ''
as $$ select private.app_game(action,payload) $$;

revoke all on function public.qcm_game(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.qcm_game(text,jsonb) to authenticated;

commit;
