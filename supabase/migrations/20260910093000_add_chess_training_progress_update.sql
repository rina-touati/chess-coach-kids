create or replace function public.chess_update_child_training(
  p_child_profile_id uuid,
  p_access_token text,
  p_profile_patch jsonb default '{}'::jsonb
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
  v_skill_scores jsonb;
  v_summary jsonb;
begin
  select * into v_profile
  from public.chess_child_profiles p
  where p.id = p_child_profile_id
    and p.access_token_hash = encode(digest(p_access_token, 'sha256'), 'hex');

  if not found then
    raise exception 'Invalid chess profile token' using errcode = '28000';
  end if;

  v_skill_scores := case
    when jsonb_typeof(p_profile_patch->'skill_scores') = 'object'
      then v_profile.skill_scores || (p_profile_patch->'skill_scores')
    else v_profile.skill_scores
  end;

  v_summary := case
    when jsonb_typeof(p_profile_patch->'summary') = 'object'
      then v_profile.summary || (p_profile_patch->'summary')
    else v_profile.summary
  end;

  update public.chess_child_profiles p
  set
    skill_scores = v_skill_scores,
    summary = v_summary,
    updated_at = now()
  where p.id = p_child_profile_id
  returning p.* into v_profile;

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

revoke all on function public.chess_update_child_training(uuid, text, jsonb) from public;
grant execute on function public.chess_update_child_training(uuid, text, jsonb) to anon, authenticated;
