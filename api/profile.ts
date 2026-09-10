import {
  type ApiRequest,
  type ApiResponse,
  getSupabaseClient,
  handleCorsPreflight,
  parseJsonBody,
  parseProfileCookie,
  serializeProfileCookie,
  setJsonHeaders,
  type ChessProfileCookie,
} from './_shared.js'

type ProfileRequest = {
  displayName?: string
}

function cleanDisplayName(displayName: unknown) {
  if (typeof displayName !== 'string') return ''
  return displayName.trim().replace(/\s+/g, ' ').slice(0, 40)
}

function normalizeProfile(profile: Record<string, unknown> | undefined) {
  if (!profile) return null

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

async function getExistingProfile(auth: ChessProfileCookie) {
  const supabase = getSupabaseClient()
  const { data, error } = await supabase.rpc('chess_get_child_profile', {
    p_child_profile_id: auth.childProfileId,
    p_access_token: auth.accessToken,
  })

  if (error || !Array.isArray(data) || !data[0]) return null
  return data[0] as Record<string, unknown>
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  setJsonHeaders(res)
  if (handleCorsPreflight(req, res)) return

  try {
    const supabase = getSupabaseClient()
    const cookieProfile = parseProfileCookie(req.headers.cookie)

    if (req.method === 'GET') {
      const profile = cookieProfile ? await getExistingProfile(cookieProfile) : null
      res.status(200).json({ profile: normalizeProfile(profile ?? undefined) })
      return
    }

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' })
      return
    }

    const body = parseJsonBody<ProfileRequest>(req)
    const displayName = cleanDisplayName(body.displayName) || 'אלוף'

    if (cookieProfile) {
      const { data, error } = await supabase.rpc('chess_update_child_profile', {
        p_child_profile_id: cookieProfile.childProfileId,
        p_access_token: cookieProfile.accessToken,
        p_display_name: displayName,
      })

      if (!error && Array.isArray(data) && data[0]) {
        res.status(200).json({ profile: normalizeProfile(data[0] as Record<string, unknown>) })
        return
      }
    }

    const { data, error } = await supabase.rpc('chess_create_child_profile', {
      p_display_name: displayName,
    })

    if (error || !Array.isArray(data) || !data[0]) {
      throw new Error(error?.message ?? 'Could not create chess profile')
    }

    res.setHeader(
      'Set-Cookie',
      serializeProfileCookie({
        childProfileId: data[0].child_profile_id,
        accessToken: data[0].access_token,
      }),
    )

    res.status(200).json({ profile: normalizeProfile(data[0] as Record<string, unknown>) })
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unexpected profile error',
    })
  }
}
