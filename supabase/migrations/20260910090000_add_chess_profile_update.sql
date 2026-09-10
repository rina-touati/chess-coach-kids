create or replace function public.chess_update_child_profile(
  p_child_profile_id uuid,
  p_access_token text,
  p_display_name text default null
)
returns table(
  child_profile_id uuid,
  display_name text,
  level integer,
  skill_scores jsonb,
  summary jsonb,
  games_played bigint,
  moves_recorded bigint
)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_profile public.chess_child_profiles%rowtype;
  v_clean_name text := left(coalesce(nullif(trim(p_display_name), ''), 'אלוף'), 40);
begin
  update public.chess_child_profiles p
  set
    display_name = v_clean_name,
    updated_at = now()
  where p.id = p_child_profile_id
    and p.access_token_hash = encode(digest(p_access_token, 'sha256'), 'hex')
  returning * into v_profile;

  if not found then
    raise exception 'Invalid chess profile token' using errcode = '28000';
  end if;

  child_profile_id := v_profile.id;
  display_name := v_profile.display_name;
  level := v_profile.level;
  skill_scores := v_profile.skill_scores;
  summary := v_profile.summary;
  games_played := (select count(*) from public.chess_games g where g.child_profile_id = v_profile.id);
  moves_recorded := (
    select count(*)
    from public.chess_moves m
    join public.chess_games g on g.id = m.game_id
    where g.child_profile_id = v_profile.id
  );
  return next;
end;
$$;

revoke all on function public.chess_update_child_profile(uuid, text, text) from public;
grant execute on function public.chess_update_child_profile(uuid, text, text) to anon, authenticated;
