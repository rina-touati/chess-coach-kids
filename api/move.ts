import { Chess, type Move, type Square } from 'chess.js'
import { type ApiRequest, type ApiResponse, handleCorsPreflight, parseJsonBody, setJsonHeaders } from './_shared.js'
import { analyzePosition } from './stockfish.js'

type MoveRequest = {
  fen?: string
  childName?: string
  moveCount?: number
  skillLevel?: number
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

function cleanName(name: unknown) {
  return typeof name === 'string' && name.trim() ? name.trim().slice(0, 40) : 'אלוף'
}

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.max(min, Math.min(max, Math.round(numeric)))
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
  return `${pieceNames[move.piece]} מ${move.from} אל ${move.to}`
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

function buildMoveCoachText(args: {
  childName: string
  playerMove: Move
  blackMove: Move | null
  bestMove: Move | null
  finalGame: Chess
  safetyPenalty: number
  moveCount: number
  lessonSkill: MoveRequest['lessonSkill']
}) {
  const played = formatMove(args.playerMove) ?? 'המסע שלך'
  const black = formatMove(args.blackMove)
  const best = formatMove(args.bestMove)

  if (args.finalGame.isCheckmate()) {
    return args.finalGame.turn() === 'w'
      ? {
          mood: 'careful' as const,
          text: `${args.childName}, זה מט לשחור. המלך הלבן בלי בריחה, אז נבדוק במסע הבא איפה ההגנה נשברה.`,
        }
      : {
          mood: 'good' as const,
          text: `${args.childName}, זה מט ללבן. מצאת דרך לסגור למלך את כל הבריחות.`,
        }
  }

  if (args.finalGame.isDraw()) {
    return {
      mood: 'idea' as const,
      text: `${args.childName}, זה תיקו. מכאן אף צד לא יכול לנצח, אז כדאי להתחיל משחק חדש ולחפש תכנית מוקדם יותר.`,
    }
  }

  if (args.finalGame.isCheck()) {
    return {
      mood: 'careful' as const,
      text: `${args.childName}, אחרי ${played}, השחור נתן שח${black ? ` עם ${black}` : ''}. עכשיו קודם מצילים את המלך, ורק אחר כך חושבים על התקפה.`,
    }
  }

  if (args.safetyPenalty > 250) {
    return {
      mood: 'careful' as const,
      text: `${args.childName}, ${played} משאיר כלי בסכנה. לפני שמזיזים כלי, בודקים מי יכול לאכול אותו והאם יש לו שומר.`,
    }
  }

  if (args.playerMove.san.includes('x')) {
    return {
      mood: 'good' as const,
      text: `${args.childName}, ${played} לקח כלי. עכשיו השאלה החשובה היא אם הכלי שלקח נשאר מוגן אחרי התגובה של השחור.`,
    }
  }

  if (args.playerMove.san.includes('+')) {
    return {
      mood: 'good' as const,
      text: `${args.childName}, ${played} נתן שח. זה מאלץ את היריב להגיב, אבל אחרי שח תמיד בודקים מה נשאר לא מוגן אצלנו.`,
    }
  }

  if (args.lessonSkill === 'opening' || args.moveCount <= 8) {
    return {
      mood: 'idea' as const,
      text: `${args.childName}, ${played} הוא מסע פתיחה. בפתיחה מחפשים מרכז, פיתוח כלים, ומלך בטוח.`,
    }
  }

  if (best) {
    return {
      mood: 'idea' as const,
      text: `${args.childName}, ${played} חוקי. רעיון שכדאי לבדוק הוא ${best}, ואז לשאול מה השחור מאיים.`,
    }
  }

  return {
    mood: 'idea' as const,
    text: `${args.childName}, ${played} חוקי. לפני המסע הבא חפש איום של השחור וכלי לבן שלא מוגן.`,
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
    const coach = buildMoveCoachText({
      childName,
      playerMove,
      blackMove,
      bestMove,
      finalGame: afterPlayer,
      safetyPenalty,
      moveCount,
      lessonSkill: body.lessonSkill ?? null,
    })

    res.status(200).json({
      fen: afterPlayer.fen(),
      pgn: afterPlayer.pgn(),
      text: coach.text,
      mood: coach.mood,
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
        bestMove: beforeAnalysis?.bestMove ?? null,
        safetyPenalty,
        beforeAnalysis,
        afterPlayerAnalysis: blackAnalysis,
        afterBlackAnalysis,
      },
    })
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : 'Move analysis failed',
    })
  }
}
