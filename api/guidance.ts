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
}

const fallbackGuidance = 'עצור רגע — מה היריב מאיים, ואיזה כלי שלך לא מוגן?'
const captureFallbackGuidance = 'עצור רגע — יש כלי של היריב שאפשר לקחת בבטחה. איזה כלי נשאר בלי הגנה?'
const endgameFallbackGuidance = 'זה סוף משחק. קודם בודקים אם יש שח, אם רגלי יכול להתקדם, ואם המלך שלך בטוח.'
const bannedCoachTerms = /פיצ'?ר|פיצ׳ר|שולחן|אסטרטגי|דינמיקה|קונספט|אופציה|סיטואציה/
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

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.max(min, Math.min(max, Math.round(numeric)))
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

function isCleanGuidanceText(rawText: string, text: string, primaryFreeCapturePiece: string | null, facts: ReturnType<typeof describePosition>) {
  if (!text.trim()) return false
  if (/[A-Za-z]/.test(rawText)) return false
  if (/חמור|טיפש|גרוע|לא מבין/.test(text)) return false
  if (bannedCoachTerms.test(text)) return false
  if (vagueCoachTerms.test(text)) return false
  if (/[a-h][1-8]/i.test(rawText)) return false
  if (/רעיון טוב עכשיו/.test(text)) return false
  if (facts.phase !== 'opening' && /לפתח|פיתוח|מרכז|שליטה במרכז/.test(text)) return false
  if (facts.theme !== 'capture_free' && facts.freeCaptures.length === 0 && /(לקחת|לתפוס|לאכול).{0,24}(של היריב|יריב|מתחרה|שחור|מלכה|צריח|רץ|סוס|רגלי)/.test(text)) return false
  if ((facts.theme === 'defend_hanging' || facts.theme === 'escape_threat') && /(לקחת|לתפוס|לאכול).{0,18}(של היריב|יריב|שחור)/.test(text)) return false
  if (facts.theme === 'capture_free' && primaryFreeCapturePiece && !text.includes(primaryFreeCapturePiece)) return false
  return true
}

function getFallbackText(facts?: ReturnType<typeof describePosition>, threatenedPieces: string[] = []) {
  if (facts?.theme === 'capture_free') return captureFallbackGuidance
  if ((facts?.theme === 'defend_hanging' || facts?.theme === 'escape_threat') && threatenedPieces[0]) {
    return `${threatenedPieces[0]} שלך בסכנה. קודם מצילים אותו, ורק אחר כך חושבים על לקיחות.`
  }
  if (facts?.phase === 'endgame') return endgameFallbackGuidance
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
  const threatenedPieces = getPiecesOnSquares(args.chess, threatenedSquares)
  const shouldMentionCapture = args.facts.theme === 'capture_free'
  const factsForPrompt = shouldMentionCapture ? args.facts : { ...args.facts, freeCaptures: [] }
  const freeCapturePieces = shouldMentionCapture ? getPiecesOnSquares(args.chess, args.facts.freeCaptures) : []
  const primaryFreeCapturePiece = freeCapturePieces[0] ?? null

  try {
    const openai = new OpenAI({ apiKey: getRequiredEnv('OPENAI_API_KEY'), fetch: nativeFetch })
    const model = process.env.OPENAI_COACH_MODEL ?? 'gpt-4o-mini'

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
            'Return exactly one JSON object and nothing else, with keys "text" and "mood". You are a warm Hebrew-speaking chess coach for a 6-year-old child before the child makes a move. Use spoken modern Hebrew only, one or two short sentences. Talk only about the current board position and the child’s next move. Never describe past exchanges, never say why an opponent captured something earlier, and never ask the child to protect a piece that is no longer on the board. Never say vague coaching like "look at the board", "many options", "good finish", or "think how to win"; every sentence must point to a concrete chess check the child can do now. If facts.phase is endgame and there is no immediate threat or free capture, guide the child to check king safety, checks, pawn promotion, or stopping the opponent pawn. Never talk about development or center control in an endgame. Never use English letters, chess notation, or square names like e4. Never use product or abstract jargon such as פיצ׳ר, אסטרטגי, קונספט, אופציה, סיטואציה, דינמיקה, and never call the chess board שולחן; say לוח. Never reveal the exact best move. Do not name a piece because of engineLines. You may name a piece only if it appears in threatenedPieces or freeCapturePieces, because that comes from current board facts. If freeCapturePieces is empty, never say the child can take or capture an opponent piece. If facts.theme is defend_hanging or escape_threat, mention the threatened piece when available, guide the child to notice it is in danger, and ask what protects it; do not mention captures or opponent pawns in this case. If facts.theme is capture_free, guide the child to notice that an opponent piece can be taken, without naming a square or exact move; never recommend defending in that case. In capture_free, if primaryFreeCapturePiece is not null, mention exactly that piece and do not mention another capturable piece. If there is an active threat, it is more important than developing a piece or taking a pawn. Give direction, not the answer.',
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
            engineLines: args.engineLines.map((line) => ({
              rank: line.rank,
              scoreCp: line.scoreCp,
              mateIn: line.mateIn,
            })),
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

    if (!isCleanGuidanceText(rawText, text, primaryFreeCapturePiece, args.facts)) {
      return { text: getFallbackText(args.facts, threatenedPieces), mood: 'idea', source: 'fallback', facts: args.facts }
    }

    return { text, mood, source: 'openai', facts: args.facts }
  } catch {
    return { text: getFallbackText(args.facts, threatenedPieces), mood: 'idea', source: 'fallback', facts: args.facts }
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
    const skillLevel = clampNumber(body.skillLevel, 20, 0, 20)
    const analysis = await analyzePosition(chess.fen(), 420, skillLevel, 3)
    const facts = describePosition(chess.fen(), analysis.lines, analysis.ponder)
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
