import OpenAI from 'openai'
import {
  type ApiRequest,
  type ApiResponse,
  getRequiredEnv,
  getSupabaseClient,
  parseJsonBody,
  parseProfileCookie,
  serializeProfileCookie,
  setJsonHeaders,
  type ChessProfileCookie,
} from './_shared.js'

type CoachRequest = {
  event: 'move' | 'hint' | 'reset' | 'chat'
  localMessage: string
  fen: string
  pgn: string
  moveCount: number
  gameId?: string
  transcript?: string
  move?: {
    from: string
    to: string
    san?: string
    color: 'w' | 'b'
  }
  analysis?: {
    bestMove?: string
    playedMove?: string
    bestScore?: number
    playedScore?: number
    loss?: number
    scoreLabel?: string
  }
}

type CoachResponse = {
  text: string
  mood: 'good' | 'careful' | 'idea'
  profile?: unknown
  gameId?: string
  source: 'openai' | 'fallback'
}

function clampSkill(value: unknown) {
  const numberValue = typeof value === 'number' ? value : 50
  return Math.max(1, Math.min(100, Math.round(numberValue)))
}

function updateSkillScores(current: Record<string, unknown>, body: CoachRequest) {
  const next = {
    opening: clampSkill(current.opening),
    tactics: clampSkill(current.tactics),
    safety: clampSkill(current.safety),
    endgame: clampSkill(current.endgame),
    focus: clampSkill(current.focus),
  }

  const loss = body.analysis?.loss ?? 0
  const moveText = `${body.move?.from ?? ''}${body.move?.to ?? ''}`

  if (loss > 250) {
    next.focus -= 3
    next.safety -= 2
  } else if (loss > 120) {
    next.focus -= 1
  } else if (body.event === 'move') {
    next.focus += 1
  }

  if (/^[b-g][18][a-h][1-8]$/.test(moveText)) {
    next.opening += 1
  }

  if (body.move?.san?.includes('x') || body.move?.san?.includes('+')) {
    next.tactics += 1
  }

  return Object.fromEntries(Object.entries(next).map(([key, value]) => [key, clampSkill(value)]))
}

async function ensureProfile(req: ApiRequest, res: ApiResponse) {
  const supabase = getSupabaseClient()
  const cookieProfile = parseProfileCookie(req.headers.cookie)

  if (cookieProfile) {
    const { data } = await supabase.rpc('chess_get_child_profile', {
      p_child_profile_id: cookieProfile.childProfileId,
      p_access_token: cookieProfile.accessToken,
    })

    if (Array.isArray(data) && data[0]) {
      return {
        supabase,
        auth: cookieProfile,
        profile: data[0],
        isNew: false,
      }
    }
  }

  const { data, error } = await supabase.rpc('chess_create_child_profile', {
    p_display_name: 'אלוף',
  })

  if (error || !Array.isArray(data) || !data[0]) {
    throw new Error(error?.message ?? 'Could not create chess profile')
  }

  const auth: ChessProfileCookie = {
    childProfileId: data[0].child_profile_id,
    accessToken: data[0].access_token,
  }

  res.setHeader('Set-Cookie', serializeProfileCookie(auth))

  return {
    supabase,
    auth,
    profile: data[0],
    isNew: true,
  }
}

function safeParseJson(text: string) {
  const jsonStart = text.indexOf('{')
  const jsonEnd = text.lastIndexOf('}')
  if (jsonStart === -1 || jsonEnd === -1) return null

  try {
    return JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as Partial<CoachResponse>
  } catch {
    return null
  }
}

function isCleanHebrewCoachText(text: string) {
  if (/[\u0600-\u06ff]/.test(text)) return false
  if (text.length > 180) return false
  return true
}

async function generateCoachMessage(body: CoachRequest, profile: Record<string, unknown>): Promise<CoachResponse> {
  const openai = new OpenAI({ apiKey: getRequiredEnv('OPENAI_API_KEY') })
  const model = process.env.OPENAI_COACH_MODEL ?? 'gpt-4o-mini'

  const response = await openai.responses.create({
    model,
    input: [
      {
        role: 'system',
        content:
          'You are a warm Hebrew-speaking chess coach for a 6-year-old child. The child cannot read. Return only short JSON with text and mood. The text must be clean modern Hebrew using Hebrew letters only, 1-2 short spoken sentences, no Arabic letters, no transliteration, no notation-heavy explanation, no shame, no long lecture.',
      },
      {
        role: 'user',
        content: JSON.stringify({
          childProfile: {
            level: profile.level,
            skill_scores: profile.skill_scores,
            summary: profile.summary,
          },
          gameEvent: body,
          requiredJsonShape: {
            text: 'Hebrew spoken feedback',
            mood: 'good | careful | idea',
          },
        }),
      },
    ],
  })

  const parsed = safeParseJson(response.output_text)
  const parsedText = typeof parsed?.text === 'string' ? parsed.text.trim() : ''
  const text = parsedText && isCleanHebrewCoachText(parsedText) ? parsedText : body.localMessage
  const mood = parsed?.mood === 'good' || parsed?.mood === 'careful' || parsed?.mood === 'idea' ? parsed.mood : 'idea'

  return { text, mood, source: 'openai' }
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  setJsonHeaders(res)

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  try {
    const body = parseJsonBody<CoachRequest>(req)
    const { supabase, auth, profile } = await ensureProfile(req, res)

    let coach: CoachResponse
    try {
      coach = await generateCoachMessage(body, profile)
    } catch {
      coach = {
        text: body.localMessage,
        mood: body.analysis?.loss && body.analysis.loss > 150 ? 'careful' : 'idea',
        source: 'fallback',
      }
    }

    const currentScores =
      profile && typeof profile === 'object' && 'skill_scores' in profile && profile.skill_scores
        ? (profile.skill_scores as Record<string, unknown>)
        : {}
    const skillScores = updateSkillScores(currentScores, body)
    const profilePatch = {
      skill_scores: skillScores,
      summary: {
        last_event: body.event,
        last_feedback: coach.text,
        last_score_label: body.analysis?.scoreLabel ?? null,
        updated_at: new Date().toISOString(),
      },
    }

    let row: { game_id?: string; profile?: unknown } | null = null

    if (body.event === 'move' && body.move) {
      const movePayload = {
        ply: Math.max(1, body.moveCount),
        color: body.move.color,
        from: body.move.from,
        to: body.move.to,
        san: body.move.san,
        fen_after: body.fen,
        pgn: body.pgn,
        analysis: body.analysis ?? {},
        coach_feedback: {
          text: coach.text,
          mood: coach.mood,
          source: coach.source,
        },
      }

      const { data: recorded } = await supabase.rpc('chess_record_move', {
        p_child_profile_id: auth.childProfileId,
        p_access_token: auth.accessToken,
        p_game_id: body.gameId ?? null,
        p_move: movePayload,
        p_profile_patch: profilePatch,
      })

      row = Array.isArray(recorded) ? recorded[0] : null
    }

    res.status(200).json({
      ...coach,
      profile: row?.profile ?? profilePatch,
      gameId: row?.game_id ?? body.gameId,
    })
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unexpected coach error',
    })
  }
}
