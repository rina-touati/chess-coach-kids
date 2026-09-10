import OpenAI from 'openai'
import {
  type ApiRequest,
  type ApiResponse,
  getRequiredEnv,
  getSupabaseClient,
  handleCorsPreflight,
  parseJsonBody,
  parseProfileCookie,
  serializeProfileCookie,
  setJsonHeaders,
  type ChessProfileCookie,
} from './_shared.js'

type SkillKey = 'opening' | 'tactics' | 'safety' | 'endgame' | 'focus'

type CoachRequest = {
  event: 'move' | 'hint' | 'reset' | 'chat' | 'practice' | 'onboarding'
  localMessage: string
  fen: string
  pgn: string
  moveCount: number
  gameId?: string
  childName?: string
  transcript?: string
  practice?: {
    id?: string
    title?: string
    skill?: SkillKey
    goal?: string
    stage?: number
    solved?: boolean
  }
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
    safetyPenalty?: number
    scoreLabel?: string
    stockfish?: {
      beforeMove?: unknown
      afterPlayerMove?: unknown
      afterBlackMove?: unknown
    }
  }
  gameStatus?: {
    isCheckmate?: boolean
    isDraw?: boolean
    isCheck?: boolean
    turn?: 'w' | 'b'
    winner?: 'white' | 'black' | null
    blackMove?: {
      from: string
      to: string
      san?: string
    } | null
  }
}

type CoachResponse = {
  text: string
  mood: 'good' | 'careful' | 'idea'
  profile?: unknown
  gameId?: string
  source: 'openai' | 'fallback' | 'rules'
}

function normalizeProfile(profile: unknown) {
  if (!profile || typeof profile !== 'object') return profile
  const source = profile as Record<string, unknown>

  return {
    childProfileId: source.child_profile_id ?? source.childProfileId ?? source.id,
    displayName: source.display_name ?? source.displayName,
    level: source.level,
    skillScores: source.skill_scores ?? source.skillScores,
    summary: source.summary,
    gamesPlayed: source.games_played ?? source.gamesPlayed,
    movesRecorded: source.moves_recorded ?? source.movesRecorded,
  }
}

const skillLabels: Record<SkillKey, string> = {
  opening: 'פיתוח כלים בפתיחה',
  tactics: 'טקטיקה ואיומים',
  safety: 'שמירה על כלים',
  endgame: 'סיום משחק ומט',
  focus: 'ריכוז לפני מסע',
} as const

function clampSkill(value: unknown) {
  const numberValue = typeof value === 'number' ? value : 50
  return Math.max(1, Math.min(100, Math.round(numberValue)))
}

function getWeakestSkill(scores: Record<string, number>) {
  return Object.entries(scores).sort((a, b) => a[1] - b[1])[0]?.[0] ?? 'focus'
}

function buildTrainingFocus(body: CoachRequest) {
  const loss = body.analysis?.loss ?? 0
  const safetyPenalty = typeof body.analysis?.safetyPenalty === 'number' ? body.analysis.safetyPenalty : 0
  const tags: string[] = []

  if (body.gameStatus?.isCheckmate) tags.push('checkmate')
  if (body.gameStatus?.isCheck) tags.push('check')
  if (loss > 500) tags.push('big_blunder')
  else if (loss > 150) tags.push('inaccuracy')
  if (safetyPenalty > 250) tags.push('piece_safety')
  if (body.move?.san?.includes('x')) tags.push('capture')
  if (body.move?.san?.includes('+')) tags.push('tactic')
  if ((body.moveCount ?? 0) <= 8) tags.push('opening')
  if ((body.moveCount ?? 0) >= 22) tags.push('endgame')
  if (body.event === 'practice') tags.push('practice')
  if (body.event === 'onboarding') tags.push('onboarding')
  if (body.event === 'hint') tags.push('hint')

  let topic: SkillKey = 'focus'
  let nextQuestion = 'מה היריב מאיים לעשות עכשיו?'
  const practiceSkill = body.practice?.skill
  const practiceQuestions: Record<SkillKey, string> = {
    opening: 'איזה כלי חדש יוצא למשחק ועוזר לשלוט במרכז?',
    tactics: 'איזה שח, לקיחה או איום יש כאן?',
    safety: 'איזה כלי לא מוגן אפשר להציל או לקחת?',
    endgame: 'לאן המלך יכול לברוח, ואיך סוגרים לו בריחות?',
    focus: 'מה חייבים לבדוק לפני שנוגעים בכלי?',
  }

  if (body.event === 'onboarding') {
    topic = 'opening'
    nextQuestion = 'רוצה להתחיל משחק או תרגול קצר?'
  } else if (body.event === 'practice') {
    topic = practiceSkill ?? 'focus'
    nextQuestion = practiceQuestions[topic]
    if (practiceSkill) tags.push(practiceSkill)
  } else if (body.event === 'hint') {
    topic = 'focus'
    nextQuestion = 'מה המסע שהמנוע רוצה שנבדוק?'
  } else if (body.gameStatus?.isCheckmate) {
    topic = 'endgame'
    nextQuestion = 'אילו משבצות בריחה נשארו למלך?'
  } else if (safetyPenalty > 250) {
    topic = 'safety'
    nextQuestion = 'האם הכלי שעבר יכול להיאכל בחינם?'
  } else if (loss > 500 || body.move?.san?.includes('+') || body.move?.san?.includes('x')) {
    topic = 'tactics'
    nextQuestion = 'האם יש שח, לקיחה או איום חזק יותר?'
  } else if ((body.moveCount ?? 0) <= 8) {
    topic = 'opening'
    nextQuestion = 'איזה כלי קל כדאי לפתח למרכז?'
  } else if ((body.moveCount ?? 0) >= 22) {
    topic = 'endgame'
    nextQuestion = 'איך מקרבים את המלך או יוצרים איום מט?'
  }

  return {
    topic,
    topicLabel: skillLabels[topic],
    tags,
    nextQuestion,
    practice: body.practice ?? null,
    bestMove: body.analysis?.bestMove ?? null,
    playedMove: body.analysis?.playedMove ?? null,
    loss,
  }
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
  const safetyPenalty = typeof body.analysis?.safetyPenalty === 'number' ? body.analysis.safetyPenalty : 0

  if (body.gameStatus?.isCheckmate && body.gameStatus.winner === 'black') {
    next.endgame -= 4
    next.safety -= 3
    next.focus -= 3
  }

  if (loss > 250) {
    next.focus -= 3
    next.safety -= 2
    next.tactics -= 2
  } else if (loss > 120) {
    next.focus -= 1
  } else if (body.event === 'move') {
    next.focus += 1
  }

  if (/^[b-g][18][a-h][1-8]$/.test(moveText)) {
    next.opening += 1
  }

  if (safetyPenalty > 250) {
    next.safety -= 3
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
  if (/[A-Za-z]/.test(text)) return false
  if (text.length > 180) return false
  if (/חמור|טיפש|גרוע|לא מבין/.test(text)) return false
  return true
}

function matchesActiveLesson(text: string, body: CoachRequest) {
  if (body.event !== 'practice') return true
  if (/להתחיל משחק|תרגול קצר|רוצה להתחיל/.test(text)) return false
  if (body.practice?.skill === 'opening' && /מט/.test(text)) return false
  return true
}

function getForcedGameStatusMessage(body: CoachRequest): CoachResponse | null {
  if (body.gameStatus?.isCheckmate) {
    const name = cleanCoachName(body.childName) || 'אלוף'

    if (body.gameStatus.winner === 'white') {
      return {
        text: `${name}, זה מט. הלבן ניצח. המלך השחור כבר לא יכול לברוח.`,
        mood: 'good',
        source: 'fallback',
      }
    }

    return {
      text: `${name}, זה מט. השחור ניצח הפעם. נבדוק איך המלך נשאר בלי בריחה.`,
      mood: 'careful',
      source: 'fallback',
    }
  }

  if (body.gameStatus?.isDraw) {
    return {
      text: 'זה תיקו. אף צד לא יכול לנצח מכאן, אז אפשר להתחיל משחק חדש.',
      mood: 'idea',
      source: 'fallback',
    }
  }

  return null
}

function cleanCoachName(name: unknown) {
  return typeof name === 'string' ? name.trim().slice(0, 40) : ''
}

function getPracticeRuleMessage(body: CoachRequest): CoachResponse | null {
  if (body.event !== 'practice' || !body.practice) return null

  const name = cleanCoachName(body.childName) || 'אלוף'
  const practice = body.practice

  if (practice.solved) {
    return {
      text: `${name}, יפה. פתרת את התרגול הזה. עכשיו ננסה להשתמש באותו רעיון גם במשחק אמיתי.`,
      mood: 'good',
      source: 'rules',
    }
  }

  if (practice.id === 'opening-first-pawn-center') {
    if ((practice.stage ?? 0) === 1) {
      return {
        text: `${name}, יפה. עכשיו תחשוב: איזה סוס יכול לצאת ולעזור לשלוט במרכז?`,
        mood: 'idea',
        source: 'rules',
      }
    }

    if ((practice.stage ?? 0) === 2) {
      return {
        text: `${name}, מצוין. עכשיו איזה רץ יכול לצאת למשבצת פעילה?`,
        mood: 'idea',
        source: 'rules',
      }
    }

    return {
      text: `${name}, שיעור פתיחה קצר. איזה רגלי יכול לשלוט במרכז ולפתוח דרך לכלים?`,
      mood: 'idea',
      source: 'rules',
    }
  }

  if (practice.id === 'opening-knight-center') {
    return {
      text: `${name}, עכשיו מוציאים סוס. חפש סוס שיכול לקפוץ קרוב למרכז.`,
      mood: 'idea',
      source: 'rules',
    }
  }

  if (practice.id === 'opening-bishop-out') {
    return {
      text: `${name}, עכשיו מוציאים רץ. חפש רץ שיש לו דרך פתוחה לצאת למשחק.`,
      mood: 'idea',
      source: 'rules',
    }
  }

  if (practice.skill === 'safety') {
    return {
      text: `${name}, עצור רגע וחפש כלי של היריב שלא מוגן. אפשר לקחת אותו בלי להפסיד כלי?`,
      mood: 'idea',
      source: 'rules',
    }
  }

  if (practice.skill === 'tactics') {
    return {
      text: `${name}, חפש קודם שח, אחר כך לקיחה, ואז איום חזק. זה הסדר של בלש שחמט.`,
      mood: 'idea',
      source: 'rules',
    }
  }

  if (practice.skill === 'endgame') {
    return {
      text: `${name}, תבדוק לאן המלך יכול לברוח. מסע טוב סוגר לו יותר משבצות.`,
      mood: 'idea',
      source: 'rules',
    }
  }

  return {
    text: `${name}, לפני שנוגעים בכלי בודקים מה היריב מאיים ומה המסע הכי בטוח.`,
    mood: 'idea',
    source: 'rules',
  }
}

function getRuleBasedCoachMessage(body: CoachRequest): CoachResponse | null {
  const name = cleanCoachName(body.childName) || 'אלוף'

  if (body.event === 'onboarding') {
    return {
      text: `${name}, שלום. אפשר להתחיל משחק או לבחור תרגול קצר.`,
      mood: 'idea',
      source: 'rules',
    }
  }

  if (body.event === 'reset') {
    return {
      text: `${name}, משחק חופשי התחיל. שחק מסע לבד, ואז המאמן ינתח מה קרה על הלוח.`,
      mood: 'idea',
      source: 'rules',
    }
  }

  return getPracticeRuleMessage(body)
}

async function generateCoachMessage(body: CoachRequest, profile: Record<string, unknown>): Promise<CoachResponse> {
  const forcedMessage = getForcedGameStatusMessage(body)
  if (forcedMessage) return forcedMessage

  const ruleMessage = getRuleBasedCoachMessage(body)
  if (ruleMessage) return ruleMessage

  const openai = new OpenAI({ apiKey: getRequiredEnv('OPENAI_API_KEY') })
  const model = process.env.OPENAI_COACH_MODEL ?? 'gpt-4o-mini'
  const trainingFocus = buildTrainingFocus(body)

  const response = await openai.responses.create({
    model,
    input: [
      {
        role: 'system',
        content:
          'Return exactly one JSON object and nothing else, with keys "text" and "mood". You are a warm Hebrew-speaking chess coach for a 6-year-old child. The child cannot read, so every answer is spoken. The text must be clean modern Hebrew using Hebrew letters only, 1-2 short spoken sentences, no English letters, no Arabic letters, no transliteration, no shame, no long lecture. The board facts in gameEvent are binding: if checkmate, draw, check, or winner is supplied, mention that exact fact first and never praise as if the game continues. Never give generic praise. Never invent threats: in the starting position say it is the opening and focus on developing knights/bishops and the center, not on immediate threats. If analysis.stockfish exists, treat it as the main chess engine evidence. Explain one concrete board fact: best move, lost piece, mate threat, unsafe piece, or opening principle. For every move, be practical in this order: what happened, what was better if bestMove exists, and one simple thinking question for next time. If the move is bad, do not say "great", "nice", or "well done"; be kind but direct. Prefer the child name when available. If event is onboarding, welcome the child by name and ask whether to start a game or a short practice; do not give a chess move tip yet. If event is chat, answer the child question directly using the current position. If event is practice, practice is already active: never ask whether to start a game or practice. The practice.skill and practice.goal are binding. Do not mix topics: opening practice is only about center and developing pieces; safety practice is only about loose pieces; tactics practice is checks, captures, threats; endgame practice is king escape squares and mate nets; focus practice is what must be checked before moving. For opening practice, ask which center pawn or minor piece should move; do not mention mate.',
      },
      {
        role: 'user',
        content: JSON.stringify({
          childProfile: {
            name: profile.display_name ?? body.childName,
            level: profile.level,
            skill_scores: profile.skill_scores,
            summary: profile.summary,
          },
          trainingFocus,
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
  const usedOpenAiText = Boolean(parsedText && isCleanHebrewCoachText(parsedText) && matchesActiveLesson(parsedText, body))
  const text = usedOpenAiText ? parsedText : body.localMessage
  const mood = parsed?.mood === 'good' || parsed?.mood === 'careful' || parsed?.mood === 'idea' ? parsed.mood : 'idea'

  return { text, mood, source: usedOpenAiText ? 'openai' : 'fallback' }
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  setJsonHeaders(res)
  if (handleCorsPreflight(req, res)) return

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
    const trainingFocus = buildTrainingFocus(body)
    const weakestSkill = getWeakestSkill(skillScores as Record<string, number>)
    const profilePatch = {
      skill_scores: skillScores,
      summary: {
        last_event: body.event,
        last_feedback: coach.text,
        last_score_label: body.analysis?.scoreLabel ?? null,
        last_training_focus: trainingFocus,
        weakest_skill: weakestSkill,
        weakest_skill_label: skillLabels[weakestSkill as keyof typeof skillLabels] ?? 'ריכוז לפני מסע',
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
        status: body.gameStatus?.isCheckmate || body.gameStatus?.isDraw ? 'completed' : 'active',
        result: body.gameStatus?.isCheckmate
          ? body.gameStatus.winner === 'white'
            ? 'white_win'
            : 'black_win'
          : body.gameStatus?.isDraw
            ? 'draw'
            : null,
        analysis: {
          ...(body.analysis ?? {}),
          trainingFocus,
          gameStatus: body.gameStatus ?? {},
        },
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
      profile: normalizeProfile(row?.profile ?? profilePatch),
      gameId: row?.game_id ?? body.gameId,
    })
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unexpected coach error',
    })
  }
}
