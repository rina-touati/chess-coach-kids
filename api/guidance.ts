import OpenAI from 'openai'
import { Chess, type PieceSymbol, type Square } from 'chess.js'
import { type ApiRequest, type ApiResponse, getRequiredEnv, handleCorsPreflight, parseJsonBody, setJsonHeaders } from './_shared.js'
import { describePosition } from './ideas.js'
import { nativeFetch } from './nativeFetch.js'
import { analyzePosition } from './stockfish.js'

type GuidanceRequest = {
  fen?: string
  childName?: string
  weakestSkill?: string
  skillLevel?: number
}

type GuidanceResponse = {
  text: string
  mood: 'idea' | 'careful' | 'good'
  source: 'openai' | 'fallback'
  facts?: unknown
  coachDebug?: GuidanceDebug
}

type GuidanceDebug = {
  reachedOpenAi: boolean
  fallbackReason: string | null
  rejectedBy: string | null
  theme?: string
  scoreCp?: number | null
}

const fallbackGuidance = 'עצור רגע — בדקי מה השתנה בלוח, ואז בחרי מהלך שמחזק כלי או את המלך.'
const openingFallbackGuidance = 'אין איום דחוף. חפשי כלי קטן שעדיין לא יצא, או מהלך שמחזק את המרכז בלי לחשוף את המלך.'
const middlegameFallbackGuidance = 'אין איום דחוף. חפשי מהלך שמשפר כלי שלך או יוצר איום פשוט על היריב.'
const endgameFallbackGuidance = 'זה סוף משחק. קודם בודקים אם יש שח, אם רגלי יכול להתקדם, ואם המלך שלך בטוח.'
const bannedCoachTerms = /פיצ'?ר|פיצ׳ר|שולחן|אסטרטגי|דינמיקה|קונספט|אופציה|סיטואציה|מפוקפק|על לוח|לידך בלוח/
const vagueCoachTerms = /הרבה אפשרויות|סיום טוב|הדרך שהכי תעזור|תעזור לך לנצח|להביא את המשחק|הסתכל על הלוח|תחשבי על הדרך/

const pieceNames: Record<PieceSymbol, string> = {
  p: 'רגלי',
  n: 'סוס',
  b: 'רץ',
  r: 'צריח',
  q: 'מלכה',
  k: 'מלך',
}

function cleanName(name: unknown) {
  return typeof name === 'string' && name.trim() ? name.trim().slice(0, 40) : 'אלוף'
}

function cleanCoachText(text: string) {
  return text
    .replace(/[A-Za-z]/g, '')
    .replace(/[\u0600-\u06ff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180)
}

function safeParseJson(text: string) {
  const jsonStart = text.indexOf('{')
  const jsonEnd = text.lastIndexOf('}')
  if (jsonStart === -1 || jsonEnd === -1) return null

  try {
    return JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as Partial<GuidanceResponse>
  } catch {
    return null
  }
}

function shouldExposeCoachDebug() {
  return process.env.COACH_DEBUG === '1'
}

function getGuidanceRejectionReason(rawText: string, text: string, primaryFreeCapturePiece: string | null, facts: ReturnType<typeof describePosition>) {
  const hasThreat = facts.myHangingPieces.length > 0 || facts.opponentThreats.length > 0 || facts.theme === 'king_safety'

  if (!text.trim()) return 'empty_text'
  if (/[A-Za-z]/.test(rawText)) return 'latin_text'
  if (/חמור|טיפש|גרוע|לא מבין/.test(text)) return 'blocked_word'
  if (bannedCoachTerms.test(text)) return 'jargon'
  if (vagueCoachTerms.test(text)) return 'vague_text'
  if (/[a-h][1-8]/i.test(rawText)) return 'square_name'
  if (/רעיון טוב עכשיו/.test(text)) return 'reveals_answer'
  if (facts.phase !== 'endgame' && /סוף המשחק|סיום המשחק|סוף משחק/.test(text)) return 'wrong_phase_endgame'
  if (facts.phase !== 'opening' && /לפתח|פיתוח|מרכז|שליטה במרכז/.test(text)) return 'wrong_phase_development'
  if (!hasThreat && /(בסכנה|לא מוגן|לא מוגנת|מאיים|מאיימים|להגן עליו|להגן עליה|להגן על הכלי)/.test(text)) return 'false_threat_language'
  if (facts.theme === 'develop_piece' && /(לפתח.{0,12}(רגלי|חייל)|(רגלי|חייל).{0,12}לפתח)/.test(text)) return 'develops_pawn'
  if (facts.theme !== 'capture_free' && facts.freeCaptures.length === 0 && /(לקחת|לתפוס|לאכול).{0,24}(של היריב|יריב|מתחרה|שחור|מלכה|צריח|רץ|סוס|רגלי|חייל)/.test(text)) return 'unsupported_capture'
  if ((facts.theme === 'defend_hanging' || facts.theme === 'escape_threat') && /(לקחת|לתפוס|לאכול).{0,18}(של היריב|יריב|שחור)/.test(text)) return 'capture_during_threat'
  if (facts.theme === 'capture_free' && primaryFreeCapturePiece && !text.includes(primaryFreeCapturePiece)) return 'missing_capture_piece'
  return null
}

function getFallbackText(facts?: ReturnType<typeof describePosition>, threatenedPieces: string[] = []) {
  if (facts?.theme === 'king_safety') return 'המלך שלך בשח. קודם מצילים את המלך: לזוז, לחסום, או לאכול את הכלי שנותן שח.'
  if (facts?.theme === 'capture_free') {
    return facts.targetPieceName
      ? `עצור רגע — יש ${facts.targetPieceName} של היריב שאפשר לקחת בבטחה.`
      : 'עצור רגע — יש כלי של היריב שאפשר לקחת בבטחה.'
  }
  if ((facts?.theme === 'defend_hanging' || facts?.theme === 'escape_threat') && threatenedPieces[0]) {
    return `${threatenedPieces[0]} שלך בסכנה. קודם מצילים אותו, ורק אחר כך חושבים על לקיחות.`
  }
  if (facts?.phase === 'endgame') return endgameFallbackGuidance
  if (facts?.phase === 'opening') return openingFallbackGuidance
  if (facts) return middlegameFallbackGuidance
  return fallbackGuidance
}

function getPiecesOnSquares(chess: Chess, squares: Square[]) {
  return [...new Set(squares.map((square) => chess.get(square)?.type).filter(Boolean).map((piece) => pieceNames[piece as PieceSymbol]))]
}

async function phraseGuidance(args: {
  childName: string
  chess: Chess
  facts: ReturnType<typeof describePosition>
  engineLines: Awaited<ReturnType<typeof analyzePosition>>['lines']
  weakestSkill?: string
}): Promise<GuidanceResponse> {
  const threatenedSquares = args.facts.myHangingPieces.length > 0 ? args.facts.myHangingPieces : args.facts.opponentThreats
  const threatenedPieces = args.facts.targetPieceName ? [args.facts.targetPieceName] : getPiecesOnSquares(args.chess, threatenedSquares)
  const shouldMentionCapture = args.facts.theme === 'capture_free'
  const factsForPrompt = shouldMentionCapture ? args.facts : { ...args.facts, freeCaptures: [] }
  const freeCapturePieces = shouldMentionCapture ? args.facts.targetPieceName ? [args.facts.targetPieceName] : getPiecesOnSquares(args.chess, args.facts.freeCaptures) : []
  const primaryFreeCapturePiece = freeCapturePieces[0] ?? null
  const debug: GuidanceDebug = {
    reachedOpenAi: false,
    fallbackReason: null,
    rejectedBy: null,
    theme: args.facts.theme,
    scoreCp: args.facts.scoreCp,
  }

  if (args.facts.theme === 'king_safety') {
    return { text: getFallbackText(args.facts, threatenedPieces), mood: 'careful', source: 'fallback', facts: args.facts, ...(shouldExposeCoachDebug() ? { coachDebug: debug } : {}) }
  }

  try {
    const openai = new OpenAI({ apiKey: getRequiredEnv('OPENAI_API_KEY'), fetch: nativeFetch })
    const model = process.env.OPENAI_COACH_MODEL ?? 'gpt-4o-mini'
    debug.reachedOpenAi = true

    const response = await openai.responses.create({
      model,
      text: {
        format: {
          type: 'json_schema',
          name: 'pre_move_guidance',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              text: { type: 'string' },
              mood: { type: 'string', enum: ['idea', 'careful', 'good'] },
            },
            required: ['text', 'mood'],
          },
        },
      },
      input: [
        {
          role: 'system',
          content:
            'Return exactly one JSON object and nothing else, with keys "text" and "mood". You are a warm Hebrew-speaking chess coach for a 6-year-old child before the child makes a move. Use spoken modern Hebrew only, one or two short sentences. The chess judgment comes only from Stockfish facts: theme, scoreCp, sharedIntent, targetPieceName, phase. Never invent board facts. Never describe past exchanges, never say why an opponent captured something earlier, and never ask the child to protect a piece that is no longer on the board. Never say vague coaching like "look at the board", "many options", "good finish", or "think how to win"; every sentence must point to a concrete chess check the child can do now. If theme is king_safety, say clearly that the king is in check and the child must first save the king; mention the three ideas: move the king, block, or capture the checking piece. If phase is not endgame, never mention endgame or the end of the game. If theme is capture_free, guide the child to notice that the targetPieceName can be taken, without naming a square or exact move; never recommend defending in that case. If theme is escape_threat or defend_hanging, guide the child to notice the targetPieceName is in danger, without giving the rescue move. If theme is develop_piece in the opening, development means bringing out a knight or bishop, not a pawn; say כלי קטן, סוס, or רץ. If theme is control_center, talk about fighting for the center without naming a square. If theme is convert_material in an endgame, talk about king safety, checks, pawn promotion, or stopping the opponent pawn. If freeCaptures is empty, never say the child can take or capture an opponent piece. If myHangingPieces and opponentThreats are empty, never imply that a piece is in danger, unprotected, or threatened. Never use English letters, chess notation, or square names like e4. Never use product or abstract jargon such as פיצ׳ר, אסטרטגי, קונספט, אופציה, סיטואציה, דינמיקה, and never call the chess board שולחן; say לוח. You may use the child word חייל for a pawn when natural. Give direction, not the exact best move.',
        },
        {
          role: 'user',
          content: JSON.stringify({
            childName: args.childName,
            turn: args.chess.turn(),
            currentFen: args.chess.fen(),
            facts: factsForPrompt,
            threatenedPieces,
            freeCapturePieces,
            primaryFreeCapturePiece,
            weakestSkill: args.weakestSkill ?? null,
            engineFacts: {
              theme: args.facts.theme,
              sharedIntent: args.facts.sharedIntent,
              targetPieceName: args.facts.targetPieceName,
              phase: args.facts.phase,
              scoreCp: args.facts.scoreCp,
              mateIn: args.facts.mateIn,
              engineSpreadCp: args.facts.engineSpreadCp,
            },
            requiredBehavior: {
              ifThreat: 'mention that one of the child pieces is in danger, without giving the rescue move',
              ifFreeCapture: 'mention primaryFreeCapturePiece only, without giving the exact move',
              noSquares: true,
              noEngineMoveNames: true,
            },
          }),
        },
      ],
    })

    const parsed = safeParseJson(response.output_text)
    const rawText = typeof parsed?.text === 'string' ? parsed.text.trim() : ''
    const text = cleanCoachText(rawText)
    const mood = parsed?.mood === 'good' || parsed?.mood === 'careful' || parsed?.mood === 'idea' ? parsed.mood : 'idea'
    const rejectedBy = getGuidanceRejectionReason(rawText, text, primaryFreeCapturePiece, args.facts)
    debug.rejectedBy = rejectedBy

    if (rejectedBy) {
      debug.fallbackReason = rejectedBy
      return { text: getFallbackText(args.facts, threatenedPieces), mood: 'idea', source: 'fallback', facts: args.facts, ...(shouldExposeCoachDebug() ? { coachDebug: debug } : {}) }
    }

    return { text, mood, source: 'openai', facts: args.facts, ...(shouldExposeCoachDebug() ? { coachDebug: debug } : {}) }
  } catch {
    debug.fallbackReason = 'openai_error'
    return { text: getFallbackText(args.facts, threatenedPieces), mood: 'idea', source: 'fallback', facts: args.facts, ...(shouldExposeCoachDebug() ? { coachDebug: debug } : {}) }
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
    const body = parseJsonBody<GuidanceRequest>(req)
    const chess = new Chess(typeof body.fen === 'string' ? body.fen : undefined)

    if (chess.isGameOver()) {
      res.status(200).json({ text: 'המשחק נגמר. אפשר להתחיל משחק חדש.', mood: 'idea', source: 'fallback' } satisfies GuidanceResponse)
      return
    }

    const childName = cleanName(body.childName)
    const analysis = await analyzePosition(chess.fen(), 760, 20, 3)
    const facts = describePosition(chess.fen(), analysis.lines)
    const guidance = await phraseGuidance({
      childName,
      chess,
      facts,
      engineLines: analysis.lines,
      weakestSkill: body.weakestSkill,
    })

    res.status(200).json(guidance)
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Guidance failed',
      text: fallbackGuidance,
      mood: 'idea',
      source: 'fallback',
    } satisfies GuidanceResponse & { error: string })
  }
}
