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

function isCleanGuidanceText(rawText: string, text: string) {
  if (!text.trim()) return false
  if (/[A-Za-z]/.test(rawText)) return false
  if (/חמור|טיפש|גרוע|לא מבין/.test(text)) return false
  if (/[a-h][1-8]/i.test(rawText)) return false
  if (/רעיון טוב עכשיו/.test(text)) return false
  return true
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
  try {
    const openai = new OpenAI({ apiKey: getRequiredEnv('OPENAI_API_KEY'), fetch: nativeFetch })
    const model = process.env.OPENAI_COACH_MODEL ?? 'gpt-4o-mini'
    const threatenedSquares = args.facts.myHangingPieces.length > 0 ? args.facts.myHangingPieces : args.facts.opponentThreats
    const threatenedPieces = getPiecesOnSquares(args.chess, threatenedSquares)

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
            'Return exactly one JSON object and nothing else, with keys "text" and "mood". You are a warm Hebrew-speaking chess coach for a 6-year-old child before the child makes a move. Use spoken modern Hebrew only, one or two short sentences. Never use English letters, chess notation, or square names like e4. Never reveal the exact best move. Do not name a piece because of engineLines. You may name a piece only if it appears in threatenedPieces, because that comes from board facts. If facts.theme is defend_hanging or escape_threat, mention the threatened piece when available, guide the child to notice it is in danger, and ask what protects it; never talk about development or center first. If there is an active threat, it is more important than developing a piece. Give direction, not the answer.',
        },
        {
          role: 'user',
          content: JSON.stringify({
            childName: args.childName,
            turn: args.chess.turn(),
            facts: args.facts,
            threatenedPieces,
            weakestSkill: args.weakestSkill ?? null,
            engineLines: args.engineLines.map((line) => ({
              rank: line.rank,
              scoreCp: line.scoreCp,
              mateIn: line.mateIn,
            })),
            requiredBehavior: {
              ifThreat: 'mention that one of the child pieces is in danger, without giving the rescue move',
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

    if (!isCleanGuidanceText(rawText, text)) {
      return { text: fallbackGuidance, mood: 'idea', source: 'fallback', facts: args.facts }
    }

    return { text, mood, source: 'openai', facts: args.facts }
  } catch {
    return { text: fallbackGuidance, mood: 'idea', source: 'fallback', facts: args.facts }
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
