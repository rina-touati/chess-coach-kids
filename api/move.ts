import OpenAI from 'openai'
import { Chess, type Move, type Square } from 'chess.js'
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
import { analyzePosition } from './stockfish.js'

type MoveRequest = {
  fen?: string
  childName?: string
  moveCount?: number
  skillLevel?: number
  gameId?: string
  mode?: 'guided' | 'regular'
  lessonSkill?: 'opening' | 'tactics' | 'safety' | 'endgame' | 'focus' | null
  move?: {
    from?: string
    to?: string
    promotion?: 'q' | 'r' | 'b' | 'n'
  }
}

const pieceValues = {
  p: 100,
  n: 320,
  b: 330,
  r: 500,
  q: 900,
  k: 0,
} as const

const pieceNames = {
  p: 'רגלי',
  n: 'סוס',
  b: 'רץ',
  r: 'צריח',
  q: 'מלכה',
  k: 'מלך',
} as const

const skillLabels = {
  opening: 'פיתוח כלים בפתיחה',
  tactics: 'טקטיקה ואיומים',
  safety: 'שמירה על כלים',
  endgame: 'סיום משחק ומט',
  focus: 'ריכוז לפני מסע',
} as const

type SkillKey = keyof typeof skillLabels
type CoachMood = 'good' | 'careful' | 'idea'

type MoveCoach = {
  mood: CoachMood
  text: string
  source: 'openai' | 'rules' | 'fallback'
}

function cleanName(name: unknown) {
  return typeof name === 'string' && name.trim() ? name.trim().slice(0, 40) : 'אלוף'
}

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.max(min, Math.min(max, Math.round(numeric)))
}

function clampSkill(value: unknown) {
  const numberValue = typeof value === 'number' ? value : 50
  return Math.max(1, Math.min(100, Math.round(numberValue)))
}

function cleanCoachText(text: string) {
  return text
    .replace(/[A-Za-z]/g, '')
    .replace(/[\u0600-\u06ff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 260)
}

function isCleanHebrewCoachText(text: string) {
  if (/חמור|טיפש|גרוע|לא מבין/.test(text)) return false
  return text.trim().length > 0
}

function safeParseJson(text: string) {
  const jsonStart = text.indexOf('{')
  const jsonEnd = text.lastIndexOf('}')
  if (jsonStart === -1 || jsonEnd === -1) return null

  try {
    return JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as Partial<MoveCoach>
  } catch {
    return null
  }
}

function compactAnalysis(analysis: unknown) {
  if (!analysis || typeof analysis !== 'object') return null
  const source = analysis as Record<string, unknown>

  return {
    bestMove: source.bestMove ?? null,
    scoreCp: source.scoreCp ?? null,
    mateIn: source.mateIn ?? null,
    depth: source.depth ?? null,
  }
}

function compactProfile(profile: unknown) {
  if (!profile || typeof profile !== 'object') return null
  const source = profile as Record<string, unknown>

  return {
    level: source.level ?? null,
    skillScores: source.skill_scores ?? source.skillScores ?? null,
    summary: source.summary ?? null,
  }
}

function compactTrainingFocus(trainingFocus: unknown) {
  if (!trainingFocus || typeof trainingFocus !== 'object') return null
  const source = trainingFocus as Record<string, unknown>

  return {
    topic: source.topic ?? null,
    topicLabel: source.topicLabel ?? null,
    tags: source.tags ?? null,
    safetyPenalty: source.safetyPenalty ?? null,
  }
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

async function ensureProfile(req: ApiRequest, res: ApiResponse, displayName: string) {
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
      }
    }
  }

  const { data, error } = await supabase.rpc('chess_create_child_profile', {
    p_display_name: displayName,
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
  }
}

function moveFromUci(chess: Chess, uci: string | null) {
  if (!uci || uci.length < 4) return null
  try {
    return new Chess(chess.fen()).move({
      from: uci.slice(0, 2) as Square,
      to: uci.slice(2, 4) as Square,
      promotion: (uci[4] as 'q' | 'r' | 'b' | 'n' | undefined) ?? 'q',
    })
  } catch {
    return null
  }
}

function formatMove(move: Move | null | undefined) {
  if (!move) return null
  return pieceNames[move.piece]
}

function movedFromHome(move: Move) {
  if (move.color !== 'w') return false
  if (move.piece === 'n') return move.from === 'b1' || move.from === 'g1'
  if (move.piece === 'b') return move.from === 'c1' || move.from === 'f1'
  if (move.piece === 'q') return move.from === 'd1'
  if (move.piece === 'r') return move.from === 'a1' || move.from === 'h1'
  return false
}

function isCenterMove(move: Move) {
  return ['d4', 'e4', 'd5', 'e5', 'c4', 'f4', 'c5', 'f5'].includes(move.to)
}

function openingExplanation(move: Move) {
  if (move.piece === 'n' && movedFromHome(move)) {
    return 'יופי, הוצאת סוס מהבית. עכשיו הוא קרוב לאמצע הלוח ועוזר לחברים שלו.'
  }

  if (move.piece === 'b' && movedFromHome(move)) {
    return 'יופי, הוצאת רץ מהבית. רץ אוהב קו פתוח כדי לראות רחוק על הלוח.'
  }

  if (move.piece === 'p' && isCenterMove(move)) {
    return 'יופי, הזזת רגלי לאמצע. מי ששולט באמצע מקבל יותר מקום לכלים.'
  }

  if (move.piece === 'q' && movedFromHome(move)) {
    return 'המלכה חזקה, אבל בתחילת המשחק לא כדאי להוציא אותה מהר מדי. קודם עדיף להוציא סוסים ורצים.'
  }

  return 'זה מסע חוקי. בתחילת המשחק אנחנו רוצים להוציא סוסים ורצים, לתפוס את האמצע, ולשמור על המלך.'
}

function getPieceValueOnSquare(chess: Chess, square: string) {
  const piece = chess.get(square as Square)
  return piece ? pieceValues[piece.type] : 0
}

function getLeastAttackerValue(chess: Chess, square: string, color: 'w' | 'b') {
  const attackers = chess.attackers(square as Square, color)
  if (attackers.length === 0) return null
  return Math.min(...attackers.map((attackerSquare) => getPieceValueOnSquare(chess, attackerSquare)))
}

function getMoveSafetyPenalty(chessAfterMove: Chess, move: Move) {
  if (move.san.includes('#')) return 0

  const movedPiece = chessAfterMove.get(move.to as Square)
  if (!movedPiece) return 0

  const enemyColor = movedPiece.color === 'w' ? 'b' : 'w'
  const ownColor = movedPiece.color
  const enemyAttackerValue = getLeastAttackerValue(chessAfterMove, move.to, enemyColor)
  if (enemyAttackerValue === null) return 0

  const ownDefenderValue = getLeastAttackerValue(chessAfterMove, move.to, ownColor)
  const movedPieceValue = move.promotion ? pieceValues[move.promotion] : pieceValues[movedPiece.type]

  if (ownDefenderValue === null) return movedPieceValue + 120
  if (enemyAttackerValue <= movedPieceValue && ownDefenderValue > enemyAttackerValue) return Math.round(movedPieceValue * 0.65)
  if (enemyAttackerValue > movedPieceValue && ownDefenderValue > movedPieceValue) return Math.round(movedPieceValue * 0.45)
  return 0
}

function getWeakestSkill(scores: Record<string, number>) {
  return Object.entries(scores).sort((a, b) => a[1] - b[1])[0]?.[0] ?? 'focus'
}

function updateSkillScores(current: Record<string, unknown>, args: { move: Move; moveCount: number; safetyPenalty: number; isCheckmate: boolean; winner: 'white' | 'black' | null }) {
  const next = {
    opening: clampSkill(current.opening),
    tactics: clampSkill(current.tactics),
    safety: clampSkill(current.safety),
    endgame: clampSkill(current.endgame),
    focus: clampSkill(current.focus),
  }

  if (args.isCheckmate && args.winner === 'black') {
    next.endgame -= 4
    next.safety -= 3
    next.focus -= 3
  } else {
    next.focus += 1
  }

  if (args.moveCount <= 8 && (movedFromHome(args.move) || isCenterMove(args.move))) next.opening += 1
  if (args.safetyPenalty > 250) {
    next.safety -= 3
    next.focus -= 2
  }
  if (args.move.san.includes('x') || args.move.san.includes('+') || args.move.san.includes('#')) next.tactics += 1
  if (args.moveCount >= 22 || args.isCheckmate) next.endgame += args.winner === 'white' ? 2 : 0

  return Object.fromEntries(Object.entries(next).map(([key, value]) => [key, clampSkill(value)]))
}

function buildTrainingFocus(args: {
  mode: MoveRequest['mode']
  move: Move
  moveCount: number
  safetyPenalty: number
  bestMove: string | null
  finalGame: Chess
  beforeAnalysis: unknown
  afterPlayerAnalysis: unknown
  afterBlackAnalysis: unknown
}) {
  let topic: SkillKey = 'focus'
  const tags: string[] = ['move']

  if (args.mode === 'guided') tags.push('guided')
  if (args.finalGame.isCheckmate()) {
    topic = 'endgame'
    tags.push('checkmate')
  } else if (args.finalGame.isCheck()) {
    topic = 'focus'
    tags.push('check')
  } else if (args.safetyPenalty > 250) {
    topic = 'safety'
    tags.push('piece_safety')
  } else if (args.move.san.includes('x') || args.move.san.includes('+') || args.move.san.includes('#')) {
    topic = 'tactics'
    tags.push('tactic')
  } else if (args.moveCount <= 8) {
    topic = 'opening'
    tags.push('opening')
  } else if (args.moveCount >= 22) {
    topic = 'endgame'
    tags.push('endgame')
  }

  return {
    topic,
    topicLabel: skillLabels[topic],
    tags,
    bestMove: args.bestMove,
    moveSan: args.move.san,
    safetyPenalty: args.safetyPenalty,
    engine: {
      beforeMove: args.beforeAnalysis,
      afterPlayerMove: args.afterPlayerAnalysis,
      afterBlackMove: args.afterBlackAnalysis,
    },
  }
}

function buildMoveCoachText(args: {
  childName: string
  playerMove: Move
  blackMove: Move | null
  bestMove: Move | null
  finalGame: Chess
  safetyPenalty: number
  moveCount: number
  lessonSkill: MoveRequest['lessonSkill']
}): MoveCoach {
  const played = formatMove(args.playerMove) ?? 'המסע שלך'
  const black = formatMove(args.blackMove)
  const best = formatMove(args.bestMove)

  if (args.finalGame.isCheckmate()) {
    return args.finalGame.turn() === 'w'
      ? {
          mood: 'careful' as const,
          text: `${args.childName}, זה מט לשחור. המלך הלבן בלי בריחה, אז נבדוק במסע הבא איפה ההגנה נשברה.`,
          source: 'rules' as const,
        }
      : {
          mood: 'good' as const,
          text: `${args.childName}, זה מט ללבן. מצאת דרך לסגור למלך את כל הבריחות.`,
          source: 'rules' as const,
        }
  }

  if (args.finalGame.isDraw()) {
    return {
      mood: 'idea' as const,
      text: `${args.childName}, זה תיקו. מכאן אף צד לא יכול לנצח, אז כדאי להתחיל משחק חדש ולחפש תכנית מוקדם יותר.`,
      source: 'rules' as const,
    }
  }

  if (args.finalGame.isCheck()) {
    return {
      mood: 'careful' as const,
      text: `${args.childName}, השחור נתן שח${black ? ` עם ${black}` : ''}. כשהמלך בסכנה, קודם מצילים אותו. התקפה באה אחר כך.`,
      source: 'rules' as const,
    }
  }

  if (args.safetyPenalty > 250) {
    return {
      mood: 'careful' as const,
      text: `${args.childName}, ה${played} נשאר במקום מסוכן. לפני שמזיזים כלי, שואלים: מי יכול לאכול אותו, ומי שומר עליו?`,
      source: 'rules' as const,
    }
  }

  if (args.playerMove.san.includes('x')) {
    return {
      mood: 'good' as const,
      text: `${args.childName}, יפה, ה${played} לקח כלי. עכשיו בודקים אם הוא נשאר מוגן או שהשחור יכול לאכול אותו בחזרה.`,
      source: 'rules' as const,
    }
  }

  if (args.playerMove.san.includes('+')) {
    return {
      mood: 'good' as const,
      text: `${args.childName}, נתת שח. זה אומר שהמלך השחור חייב לענות מיד. עכשיו נבדוק מה השחור יכול לעשות בחזרה.`,
      source: 'rules' as const,
    }
  }

  if (args.lessonSkill === 'opening' || args.moveCount <= 8) {
    return {
      mood: 'idea' as const,
      text: `${args.childName}, ${openingExplanation(args.playerMove)} במסע הבא ננסה להוציא עוד כלי או להכין מקום בטוח למלך.`,
      source: 'rules' as const,
    }
  }

  if (best) {
    return {
      mood: 'idea' as const,
      text: `${args.childName}, המסע חוקי. עכשיו כדאי לחפש רעיון פעיל: שח, לקיחה, או איום על כלי של השחור.`,
      source: 'rules' as const,
    }
  }

  return {
    mood: 'idea' as const,
    text: `${args.childName}, המסע חוקי. לפני המסע הבא נעצור רגע ונשאל: מה השחור מאיים, ואיזה כלי שלי צריך שמירה?`,
    source: 'rules' as const,
  }
}

async function phraseMoveWithOpenAi(args: {
  fallback: MoveCoach
  childName: string
  profile: unknown
  mode: MoveRequest['mode']
  playerMove: Move
  blackMove: Move | null
  bestMove: string | null
  finalGame: Chess
  safetyPenalty: number
  trainingFocus: unknown
  facts: unknown
}) {
  try {
    const openai = new OpenAI({ apiKey: getRequiredEnv('OPENAI_API_KEY') })
    const model = process.env.OPENAI_COACH_MODEL ?? 'gpt-4o-mini'
    const facts = args.facts && typeof args.facts === 'object' ? (args.facts as Record<string, unknown>) : {}
    const response = await openai.responses.create({
      model,
      text: {
        format: {
          type: 'json_schema',
          name: 'move_coach_message',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              text: { type: 'string' },
              mood: { type: 'string', enum: ['good', 'careful', 'idea'] },
            },
            required: ['text', 'mood'],
          },
        },
      },
      input: [
        {
          role: 'system',
          content:
            'Return exactly one JSON object and nothing else, with keys "text" and "mood". You are a warm Hebrew-speaking chess coach for a 6-year-old child. The child cannot read, so every answer is spoken. Use clean modern Hebrew only, one or two short sentences. Do not use English letters or chess notation like e4. Never invent board facts. Stockfish facts and legal move facts are binding. If mode is guided and the game continues, speak about what to check before the next move, not generic praise. If the child blundered or left a piece unsafe, be kind but direct. Do not shame.',
        },
        {
          role: 'user',
          content: JSON.stringify({
            childName: args.childName,
            childProfile: compactProfile(args.profile),
            mode: args.mode ?? 'regular',
            playerMove: {
              from: args.playerMove.from,
              to: args.playerMove.to,
              san: args.playerMove.san,
              piece: args.playerMove.piece,
              captured: args.playerMove.captured ?? null,
            },
            blackMove: args.blackMove
              ? {
                  from: args.blackMove.from,
                  to: args.blackMove.to,
                  san: args.blackMove.san,
                  piece: args.blackMove.piece,
                  captured: args.blackMove.captured ?? null,
                }
              : null,
            bestMove: args.bestMove,
            finalStatus: {
              isCheck: args.finalGame.isCheck(),
              isCheckmate: args.finalGame.isCheckmate(),
              isDraw: args.finalGame.isDraw(),
              turn: args.finalGame.turn(),
            },
            safetyPenalty: args.safetyPenalty,
            trainingFocus: compactTrainingFocus(args.trainingFocus),
            engineFacts: {
              beforeMove: compactAnalysis(facts.beforeAnalysis),
              afterPlayerMove: compactAnalysis(facts.afterPlayerAnalysis),
              afterBlackMove: compactAnalysis(facts.afterBlackAnalysis),
            },
            fallbackText: args.fallback.text,
          }),
        },
      ],
    })

    const parsed = safeParseJson(response.output_text)
    const text = cleanCoachText(typeof parsed?.text === 'string' ? parsed.text : '')
    const mood = parsed?.mood === 'good' || parsed?.mood === 'careful' || parsed?.mood === 'idea' ? parsed.mood : args.fallback.mood
    if (!isCleanHebrewCoachText(text)) return args.fallback
    return { text, mood, source: 'openai' as const }
  } catch {
    return args.fallback
  }
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  setJsonHeaders(res)
  if (handleCorsPreflight(req, res)) return

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  try {
    const body = parseJsonBody<MoveRequest>(req)
    const gameBefore = new Chess(typeof body.fen === 'string' ? body.fen : undefined)
    const childName = cleanName(body.childName)
    const moveCount = clampNumber(body.moveCount, 1, 1, 500)
    const skillLevel = clampNumber(body.skillLevel, 8, 0, 20)
    const { supabase, auth, profile } = await ensureProfile(req, res, childName)

    if (gameBefore.turn() !== 'w' || gameBefore.isGameOver()) {
      res.status(400).json({ error: 'It is not white to move' })
      return
    }

    const requestedMove = body.move
    const playerMove = gameBefore.move({
      from: requestedMove?.from as Square,
      to: requestedMove?.to as Square,
      promotion: requestedMove?.promotion ?? 'q',
    })
    const afterPlayer = new Chess(gameBefore.fen())
    const safetyPenalty = getMoveSafetyPenalty(afterPlayer, playerMove)

    const [beforeAnalysis, blackAnalysis] = await Promise.all([
      analyzePosition(typeof body.fen === 'string' ? body.fen : gameBefore.fen(), 520, 20).catch(() => null),
      afterPlayer.isGameOver() ? Promise.resolve(null) : analyzePosition(afterPlayer.fen(), 420, skillLevel).catch(() => null),
    ])

    const bestMove = moveFromUci(new Chess(typeof body.fen === 'string' ? body.fen : undefined), beforeAnalysis?.bestMove ?? null)
    const stockfishBlackMove = moveFromUci(afterPlayer, blackAnalysis?.bestMove ?? null)
    const fallbackBlackMove = !afterPlayer.isGameOver() ? afterPlayer.moves({ verbose: true })[0] ?? null : null
    const blackMove = stockfishBlackMove ?? fallbackBlackMove

    if (blackMove && !afterPlayer.isGameOver()) {
      afterPlayer.move({ from: blackMove.from, to: blackMove.to, promotion: blackMove.promotion ?? 'q' })
    }

    const afterBlackAnalysis = afterPlayer.isGameOver() ? null : await analyzePosition(afterPlayer.fen(), 220, 20).catch(() => null)
    const fallbackCoach = buildMoveCoachText({
      childName,
      playerMove,
      blackMove,
      bestMove,
      finalGame: afterPlayer,
      safetyPenalty,
      moveCount,
      lessonSkill: body.lessonSkill ?? null,
    })
    const winner = afterPlayer.isCheckmate() ? (afterPlayer.turn() === 'w' ? 'black' : 'white') : null
    const trainingFocus = buildTrainingFocus({
      mode: body.mode,
      move: playerMove,
      moveCount,
      safetyPenalty,
      bestMove: beforeAnalysis?.bestMove ?? null,
      finalGame: afterPlayer,
      beforeAnalysis,
      afterPlayerAnalysis: blackAnalysis,
      afterBlackAnalysis,
    })
    const facts = {
      bestMove: beforeAnalysis?.bestMove ?? null,
      safetyPenalty,
      beforeAnalysis,
      afterPlayerAnalysis: blackAnalysis,
      afterBlackAnalysis,
    }
    const coach = await phraseMoveWithOpenAi({
      fallback: fallbackCoach,
      childName,
      profile,
      mode: body.mode,
      playerMove,
      blackMove,
      bestMove: beforeAnalysis?.bestMove ?? null,
      finalGame: afterPlayer,
      safetyPenalty,
      trainingFocus,
      facts,
    })

    const currentScores =
      profile && typeof profile === 'object' && 'skill_scores' in profile && profile.skill_scores
        ? (profile.skill_scores as Record<string, unknown>)
        : {}
    const skillScores = updateSkillScores(currentScores, {
      move: playerMove,
      moveCount,
      safetyPenalty,
      isCheckmate: afterPlayer.isCheckmate(),
      winner,
    })
    const weakestSkill = getWeakestSkill(skillScores as Record<string, number>)
    const profilePatch = {
      skill_scores: skillScores,
      summary: {
        last_event: 'move',
        last_feedback: coach.text,
        last_training_focus: trainingFocus,
        weakest_skill: weakestSkill,
        weakest_skill_label: skillLabels[weakestSkill as SkillKey] ?? 'ריכוז לפני מסע',
        updated_at: new Date().toISOString(),
      },
    }

    const movePayload = {
      ply: moveCount,
      color: 'w',
      from: playerMove.from,
      to: playerMove.to,
      san: playerMove.san,
      fen_after: afterPlayer.fen(),
      pgn: afterPlayer.pgn(),
      status: afterPlayer.isCheckmate() || afterPlayer.isDraw() ? 'completed' : 'active',
      result: afterPlayer.isCheckmate() ? (winner === 'white' ? 'white_win' : 'black_win') : afterPlayer.isDraw() ? 'draw' : null,
      analysis: {
        ...facts,
        trainingFocus,
        mode: body.mode ?? 'regular',
        gameStatus: {
          isCheck: afterPlayer.isCheck(),
          isCheckmate: afterPlayer.isCheckmate(),
          isDraw: afterPlayer.isDraw(),
          turn: afterPlayer.turn(),
          winner,
        },
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
    const row = Array.isArray(recorded) ? recorded[0] : null

    res.status(200).json({
      fen: afterPlayer.fen(),
      pgn: afterPlayer.pgn(),
      text: coach.text,
      mood: coach.mood,
      source: coach.source,
      gameId: row?.game_id ?? body.gameId,
      profile: normalizeProfile(row?.profile ?? profilePatch),
      playerMove: {
        from: playerMove.from,
        to: playerMove.to,
        san: playerMove.san,
        piece: playerMove.piece,
        captured: playerMove.captured ?? null,
      },
      blackMove: blackMove
        ? {
            from: blackMove.from,
            to: blackMove.to,
            san: blackMove.san,
            piece: blackMove.piece,
            captured: blackMove.captured ?? null,
          }
        : null,
      status: {
        isCheck: afterPlayer.isCheck(),
        isCheckmate: afterPlayer.isCheckmate(),
        isDraw: afterPlayer.isDraw(),
        turn: afterPlayer.turn(),
      },
      facts: {
        ...facts,
        trainingFocus,
      },
    })
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : 'Move analysis failed',
    })
  }
}
