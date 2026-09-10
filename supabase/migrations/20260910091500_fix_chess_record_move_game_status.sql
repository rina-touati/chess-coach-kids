create or replace function public.chess_record_move(
  p_child_profile_id uuid,
  p_access_token text,
  p_game_id uuid,
  p_move jsonb,
  p_profile_patch jsonb default '{}'::jsonb
)
returns table(game_id uuid, profile jsonb)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_profile public.chess_child_profiles%rowtype;
  v_game_id uuid := p_game_id;
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

  if v_game_id is null then
    insert into public.chess_games (
      child_profile_id,
      fen,
      pgn,
      move_count,
      status,
      result
    )
    values (
      p_child_profile_id,
      coalesce(p_move->>'fen_after', 'start'),
      coalesce(p_move->>'pgn', ''),
      coalesce((p_move->>'ply')::integer, 0),
      coalesce(p_move->>'status', 'active'),
      nullif(p_move->>'result', '')
    )
    returning id into v_game_id;
  else
    update public.chess_games g
    set
      fen = coalesce(p_move->>'fen_after', g.fen),
      pgn = coalesce(p_move->>'pgn', g.pgn),
      move_count = greatest(g.move_count, coalesce((p_move->>'ply')::integer, g.move_count)),
      status = coalesce(p_move->>'status', g.status),
      result = coalesce(nullif(p_move->>'result', ''), g.result),
      updated_at = now()
    where g.id = v_game_id and g.child_profile_id = p_child_profile_id;

    if not found then
      raise exception 'Invalid chess game' using errcode = '28000';
    end if;
  end if;

  insert into public.chess_moves (
    game_id,
    ply,
    color,
    from_square,
    to_square,
    san,
    fen_after,
    analysis,
    coach_feedback
  )
  values (
    v_game_id,
    coalesce((p_move->>'ply')::integer, 1),
    coalesce(p_move->>'color', 'w'),
    p_move->>'from',
    p_move->>'to',
    p_move->>'san',
    coalesce(p_move->>'fen_after', 'unknown'),
    coalesce(p_move->'analysis', '{}'::jsonb),
    coalesce(p_move->'coach_feedback', '{}'::jsonb)
  )
  on conflict on constraint chess_moves_game_id_ply_key do update set
    fen_after = excluded.fen_after,
    analysis = excluded.analysis,
    coach_feedback = excluded.coach_feedback;

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
    level = coalesce((p_profile_patch->>'level')::integer, p.level),
    skill_scores = v_skill_scores,
    summary = v_summary,
    updated_at = now()
  where p.id = p_child_profile_id
  returning p.* into v_profile;

  game_id := v_game_id;
  profile := jsonb_build_object(
    'id', v_profile.id,
    'display_name', v_profile.display_name,
    'level', v_profile.level,
    'skill_scores', v_profile.skill_scores,
    'summary', v_profile.summary
  );
  return next;
end;
$$;
