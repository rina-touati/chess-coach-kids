import {
  type ApiRequest,
  type ApiResponse,
  getSupabaseClient,
  parseJsonBody,
  parseProfileCookie,
  setJsonHeaders,
} from './_shared.js'

type PracticeRequest = {
  puzzleId?: string
  puzzleTitle?: string
  solved?: boolean
}

function cleanId(value: unknown) {
  return typeof value === 'string' ? value.replace(/[^a-z0-9_-]/gi, '').slice(0, 80) : ''
}

function normalizeProfile(profile: Record<string, unknown>) {
  return {
    childProfileId: profile.child_profile_id,
    displayName: profile.display_name,
    level: profile.level,
    skillScores: profile.skill_scores,
    summary: profile.summary,
    gamesPlayed: profile.games_played,
    movesRecorded: profile.moves_recorded,
  }
}

function asObject(value: unknown) {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function bumpScore(value: unknown, amount: number) {
  const current = typeof value === 'number' ? value : 50
  return Math.max(1, Math.min(100, Math.round(current + amount)))
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  setJsonHeaders(res)

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  try {
    const auth = parseProfileCookie(req.headers.cookie)
    if (!auth) {
      res.status(401).json({ error: 'Missing chess profile' })
      return
    }

    const body = parseJsonBody<PracticeRequest>(req)
    const puzzleId = cleanId(body.puzzleId)
    if (!puzzleId || !body.solved) {
      res.status(400).json({ error: 'Missing solved puzzle' })
      return
    }

    const supabase = getSupabaseClient()
    const { data: profileRows } = await supabase.rpc('chess_get_child_profile', {
      p_child_profile_id: auth.childProfileId,
      p_access_token: auth.accessToken,
    })
    const currentProfile = Array.isArray(profileRows) && profileRows[0] ? (profileRows[0] as Record<string, unknown>) : {}
    const currentScores = asObject(currentProfile.skill_scores)
    const currentSummary = asObject(currentProfile.summary)
    const currentPracticeProgress = asObject(currentSummary.practice_progress)

    const { data, error } = await supabase.rpc('chess_update_child_training', {
      p_child_profile_id: auth.childProfileId,
      p_access_token: auth.accessToken,
      p_profile_patch: {
        skill_scores: {
          ...currentScores,
          tactics: bumpScore(currentScores.tactics, 3),
          focus: bumpScore(currentScores.focus, 2),
          endgame: bumpScore(currentScores.endgame, 2),
        },
        summary: {
          last_event: 'practice',
          last_feedback: body.puzzleTitle ? `Solved practice: ${body.puzzleTitle}` : 'Solved practice',
          weakest_skill_label: 'טקטיקה ואיומים',
          practice_progress: {
            ...currentPracticeProgress,
            [puzzleId]: {
              solved: true,
              solvedAt: new Date().toISOString(),
            },
          },
          updated_at: new Date().toISOString(),
        },
      },
    })

    if (error || !Array.isArray(data) || !data[0]) {
      throw new Error(error?.message ?? 'Could not record practice')
    }

    res.status(200).json({ profile: normalizeProfile(data[0] as Record<string, unknown>) })
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unexpected practice error',
    })
  }
}
