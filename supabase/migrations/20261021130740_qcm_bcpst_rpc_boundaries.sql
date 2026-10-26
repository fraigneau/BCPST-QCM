begin;

create function private.get_current_profile() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  result jsonb;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentification requise.' using errcode = '42501';
  end if;
  select jsonb_build_object('id', p.id, 'name', p.display_name, 'email', u.email, 'role', p.role, 'createdAt', p.created_at)
    into result
    from public.profiles p join auth.users u on u.id = p.id
    where p.id = (select auth.uid()) and p.disabled_at is null;
  if result is null then
    raise exception 'Profil indisponible.' using errcode = '42501';
  end if;
  return result;
end;
$$;

revoke all on function private.get_current_profile() from public, anon, authenticated, service_role;
grant execute on function private.get_current_profile() to authenticated;

create function private.get_chapter_leaderboard(target_chapter text)
returns table(player_id uuid, display_name text, points bigint, answered bigint, correct bigint, "position" bigint)
language sql stable security definer set search_path = ''
as $$
  with totals as (
    select p.id, p.display_name,
      coalesce(sum(r.points), 0)::bigint as points,
      coalesce(sum(r.answered), 0)::bigint as answered,
      coalesce(sum(r.correct), 0)::bigint as correct
    from public.profiles p
    left join public.chapter_results r on r.player_id = p.id and r.chapter_id = target_chapter
      and exists(select 1 from public.games g where g.id = r.game_id and g.status = 'finished')
    where p.disabled_at is null and private.current_role() is not null
      and exists(select 1 from public.chapters where id = target_chapter)
    group by p.id, p.display_name
  )
  select id, totals.display_name, totals.points, totals.answered, totals.correct,
    rank() over(order by totals.points desc, case when totals.answered > 0 then round(totals.correct::numeric / totals.answered * 100) else 0 end desc)
  from totals order by totals.points desc, case when totals.answered > 0 then round(totals.correct::numeric / totals.answered * 100) else 0 end desc, totals.display_name, id
$$;

revoke all on function private.get_chapter_leaderboard(text) from public, anon, authenticated, service_role;
grant execute on function private.get_chapter_leaderboard(text) to authenticated;

create or replace function public.current_profile() returns jsonb
language sql stable security invoker set search_path = ''
as $$
  select private.get_current_profile()
$$;

revoke all on function public.current_profile() from public, anon, authenticated, service_role;
grant execute on function public.current_profile() to authenticated;

create or replace function public.chapter_leaderboard(target_chapter text)
returns table(player_id uuid, display_name text, points bigint, answered bigint, correct bigint, "position" bigint)
language sql stable security invoker set search_path = ''
as $$
  select board.* from private.get_chapter_leaderboard(target_chapter) board
  order by board.points desc, case when board.answered > 0 then round(board.correct::numeric / board.answered * 100) else 0 end desc, board.display_name, board.player_id
$$;

revoke all on function public.chapter_leaderboard(text) from public, anon, authenticated, service_role;
grant execute on function public.chapter_leaderboard(text) to authenticated;

create policy question_keys_deny_clients on private.question_keys
as restrictive for all to anon, authenticated using (false) with check (false);

create policy question_reviews_deny_clients on private.question_reviews
as restrictive for all to anon, authenticated using (false) with check (false);

create policy game_questions_deny_clients on private.game_questions
as restrictive for all to anon, authenticated using (false) with check (false);

create policy audit_events_deny_clients on private.audit_events
as restrictive for all to anon, authenticated using (false) with check (false);

commit;
