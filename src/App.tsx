import { useMemo, useState } from 'react'
import { Chess, type Move, type Square } from 'chess.js'
import { Chessboard, type PieceDropHandlerArgs } from 'react-chessboard'
import { Lightbulb, RefreshCcw, RotateCcw, Volume2 } from 'lucide-react'
import './App.css'

type CoachMood = 'good' | 'careful' | 'idea'

type CoachMessage = {
  text: string
  mood: CoachMood
}

const kidName = 'אלוף'
const centerSquares = new Set(['c3', 'd3', 'e3', 'f3', 'c4', 'd4', 'e4', 'f4', 'c5', 'd5', 'e5', 'f5', 'c6', 'd6', 'e6', 'f6'])
const startingBackRank = new Set(['b1', 'c1', 'f1', 'g1'])
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

const whitePieceSquareTables = {
  p: [
    0, 0, 0, 0, 0, 0, 0, 0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
    5, 5, 10, 25, 25, 10, 5, 5,
    0, 0, 0, 20, 20, 0, 0, 0,
    5, -5, -10, 0, 0, -10, -5, 5,
    5, 10, 10, -20, -20, 10, 10, 5,
    0, 0, 0, 0, 0, 0, 0, 0,
  ],
  n: [
    -50, -40, -30, -30, -30, -30, -40, -50,
    -40, -20, 0, 5, 5, 0, -20, -40,
    -30, 5, 10, 15, 15, 10, 5, -30,
    -30, 0, 15, 20, 20, 15, 0, -30,
    -30, 5, 15, 20, 20, 15, 5, -30,
    -30, 0, 10, 15, 15, 10, 0, -30,
    -40, -20, 0, 0, 0, 0, -20, -40,
    -50, -40, -30, -30, -30, -30, -40, -50,
  ],
  b: [
    -20, -10, -10, -10, -10, -10, -10, -20,
    -10, 5, 0, 0, 0, 0, 5, -10,
    -10, 10, 10, 10, 10, 10, 10, -10,
    -10, 0, 10, 10, 10, 10, 0, -10,
    -10, 5, 5, 10, 10, 5, 5, -10,
    -10, 0, 5, 10, 10, 5, 0, -10,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -20, -10, -10, -10, -10, -10, -10, -20,
  ],
  r: [
    0, 0, 0, 5, 5, 0, 0, 0,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    5, 10, 10, 10, 10, 10, 10, 5,
    0, 0, 0, 0, 0, 0, 0, 0,
  ],
  q: [
    -20, -10, -10, -5, -5, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 5, 5, 5, 0, -10,
    -5, 0, 5, 5, 5, 5, 0, -5,
    0, 0, 5, 5, 5, 5, 0, -5,
    -10, 5, 5, 5, 5, 5, 0, -10,
    -10, 0, 5, 0, 0, 0, 0, -10,
    -20, -10, -10, -5, -5, -10, -10, -20,
  ],
  k: [
    20, 30, 10, 0, 0, 10, 30, 20,
    20, 20, 0, 0, 0, 0, 20, 20,
    -10, -20, -20, -20, -20, -20, -20, -10,
    -20, -30, -30, -40, -40, -30, -30, -20,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
  ],
} as const

type MoveAnalysis = {
  move: Move
  score: number
}

function speak(text: string) {
  void speakWithServerVoice(text)
}

function speakWithBrowserVoice(text: string) {
  window.speechSynthesis.cancel()
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.lang = 'he-IL'
  utterance.rate = 0.9
  utterance.pitch = 1.08
  window.speechSynthesis.speak(utterance)
}

async function speakWithServerVoice(text: string) {
  try {
    const response = await fetch('/api/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })

    if (!response.ok) throw new Error('Speech API failed')

    window.speechSynthesis.cancel()
    const blob = await response.blob()
    const audioUrl = URL.createObjectURL(blob)
    const audio = new Audio(audioUrl)
    audio.addEventListener('ended', () => URL.revokeObjectURL(audioUrl), { once: true })
    await audio.play()
  } catch {
    speakWithBrowserVoice(text)
  }
}

function squareIndex(square: string) {
  const file = square.charCodeAt(0) - 97
  const rank = Number(square[1])
  return (8 - rank) * 8 + file
}

function pieceSquareBonus(piece: keyof typeof pieceValues, square: string, color: 'w' | 'b') {
  const index = squareIndex(square)
  const tableIndex = color === 'w' ? index : 63 - index
  return whitePieceSquareTables[piece][tableIndex]
}

function evaluateBoard(chess: Chess) {
  if (chess.isCheckmate()) return chess.turn() === 'w' ? -100_000 : 100_000
  if (chess.isDraw()) return 0

  let score = 0
  const board = chess.board()

  for (let rank = 0; rank < board.length; rank += 1) {
    for (let file = 0; file < board[rank].length; file += 1) {
      const piece = board[rank][file]
      if (!piece) continue

      const square = `${String.fromCharCode(97 + file)}${8 - rank}`
      const pieceScore = pieceValues[piece.type] + pieceSquareBonus(piece.type, square, piece.color)
      score += piece.color === 'w' ? pieceScore : -pieceScore
    }
  }

  const whiteMobility = new Chess(chess.fen().replace(/ [bw] /, ' w ')).moves().length
  const blackMobility = new Chess(chess.fen().replace(/ [bw] /, ' b ')).moves().length
  score += (whiteMobility - blackMobility) * 4

  return score
}

function scoreMoveForOrdering(move: Move) {
  const captured = move.captured ? pieceValues[move.captured] : 0
  const attacker = pieceValues[move.piece]
  const checkBonus = move.san.includes('+') ? 60 : 0
  const promotionBonus = move.promotion ? pieceValues[move.promotion] : 0

  return captured * 10 - attacker + checkBonus + promotionBonus
}

function minimax(chess: Chess, depth: number, alpha: number, beta: number): number {
  if (depth === 0 || chess.isGameOver()) return evaluateBoard(chess)

  const moves = chess.moves({ verbose: true }).sort((a, b) => scoreMoveForOrdering(b) - scoreMoveForOrdering(a))

  if (chess.turn() === 'w') {
    let best = -Infinity
    for (const move of moves) {
      chess.move(move)
      best = Math.max(best, minimax(chess, depth - 1, alpha, beta))
      chess.undo()
      alpha = Math.max(alpha, best)
      if (beta <= alpha) break
    }
    return best
  }

  let best = Infinity
  for (const move of moves) {
    chess.move(move)
    best = Math.min(best, minimax(chess, depth - 1, alpha, beta))
    chess.undo()
    beta = Math.min(beta, best)
    if (beta <= alpha) break
  }
  return best
}

function analyzeLegalMoves(chess: Chess, depth = 2): MoveAnalysis[] {
  const moves = chess.moves({ verbose: true })

  return moves
    .map((move) => {
      const next = new Chess(chess.fen())
      next.move(move)
      return {
        move,
        score: minimax(next, depth - 1, -Infinity, Infinity),
      }
    })
    .sort((a, b) => (chess.turn() === 'w' ? b.score - a.score : a.score - b.score))
}

function findMoveAnalysis(analyses: MoveAnalysis[], playedMove: Move) {
  return analyses.find(
    (analysis) => analysis.move.from === playedMove.from && analysis.move.to === playedMove.to && analysis.move.promotion === playedMove.promotion,
  )
}

function formatScore(score: number) {
  if (Math.abs(score) > 90_000) return score > 0 ? 'כמעט ניצחון ללבן' : 'כמעט ניצחון לשחור'
  const pawns = Math.abs(score / 100).toFixed(1)
  return score >= 0 ? `יתרון לבן בערך ${pawns} רגלים` : `יתרון שחור בערך ${pawns} רגלים`
}

function explainMoveReason(move: Move) {
  if (move.san.includes('#')) return 'כי זה נותן מט'
  if (move.san.includes('+')) return 'כי זה נותן שח ומכריח את היריב להגיב'
  if (move.captured) return `כי זה לוקח ${pieceNames[move.captured]}`
  if ((move.piece === 'n' || move.piece === 'b') && startingBackRank.has(move.from)) return 'כי זה מוציא כלי חדש למשחק'
  if (centerSquares.has(move.to)) return 'כי זה מקרב כלי למרכז'
  return 'כי זה משפר את המקום של הכלי'
}

function getCoachMessage(move: Move, chess: Chess, bestBeforeMove: MoveAnalysis | undefined, playedAnalysis: MoveAnalysis | undefined): CoachMessage {
  if (chess.isCheckmate()) {
    return {
      mood: 'good',
      text: `וואו ${kidName}! זה מט. ניצחת במשחק.`,
    }
  }

  if (bestBeforeMove && playedAnalysis) {
    const loss = bestBeforeMove.score - playedAnalysis.score

    if (loss > 250) {
      return {
        mood: 'careful',
        text: `עצור רגע. זה מסע חוקי, אבל היה מסע חזק יותר: ${bestBeforeMove.move.from} אל ${bestBeforeMove.move.to}, ${explainMoveReason(bestBeforeMove.move)}.`,
      }
    }

    if (loss > 120) {
      return {
        mood: 'idea',
        text: `לא רע, אבל אפשר היה לדייק. המסע ${bestBeforeMove.move.from} אל ${bestBeforeMove.move.to} נראה קצת יותר חזק, ${explainMoveReason(bestBeforeMove.move)}.`,
      }
    }
  }

  if (move.san.includes('+')) {
    return {
      mood: 'good',
      text: `יפה מאוד. עשית שח למלך. עכשיו תחפש איך להביא עוד כלי לעזור.`,
    }
  }

  if (move.captured) {
    return {
      mood: 'good',
      text: `יופי! לקחת כלי של היריב. עכשיו תבדוק שהכלי שלך לא נשאר לבד.`,
    }
  }

  if (move.piece === 'n' && startingBackRank.has(move.from)) {
    return {
      mood: 'good',
      text: `מעולה. הוצאת סוס למשחק. בתחילת משחק אוהבים להביא סוסים ורצים למרכז.`,
    }
  }

  if (move.piece === 'b' && startingBackRank.has(move.from)) {
    return {
      mood: 'good',
      text: `יפה. הרץ יצא מהבית. ככל שיותר כלים משחקים, הצבא שלך חזק יותר.`,
    }
  }

  if (centerSquares.has(move.to)) {
    return {
      mood: 'idea',
      text: `רעיון טוב. המרכז הוא מקום חשוב. מי ששולט במרכז רואה יותר משבצות.`,
    }
  }

  if (move.piece === 'q') {
    return {
      mood: 'careful',
      text: `המלכה חזקה מאוד, אבל לא כדאי להוציא אותה לבד מוקדם מדי. תנסה להביא גם סוס או רץ.`,
    }
  }

  return {
    mood: 'idea',
    text: `מסע בסדר. המצב עכשיו: ${formatScore(evaluateBoard(chess))}. לפני המסע הבא נשאל: מה היריב מאיים לקחת?`,
  }
}

function pickBlackMove(chess: Chess) {
  const analyses = analyzeLegalMoves(chess, 3)
  return analyses[0]?.move ?? null
}

function getHint(chess: Chess) {
  const best = analyzeLegalMoves(chess, 2)[0]?.move

  if (!best) {
    return {
      text: 'המשחק נגמר. אפשר להתחיל מחדש.',
      squares: {},
    }
  }

  return {
    text: `רמז חכם: נסה ${best.from} אל ${best.to}. ${explainMoveReason(best)}.`,
    squares: {
      [best.from]: { background: '#facc15' },
      [best.to]: { background: '#22c55e' },
    },
  }
}

function App() {
  const [game, setGame] = useState(() => new Chess())
  const [coach, setCoach] = useState<CoachMessage>({
    mood: 'idea',
    text: 'שלום אלוף. תזיז כלי לבן, ואני אלמד אותך תוך כדי משחק.',
  })
  const [highlightedSquares, setHighlightedSquares] = useState<Record<string, React.CSSProperties>>({})
  const [movesPlayed, setMovesPlayed] = useState(0)
  const [lastMove, setLastMove] = useState<string>('עוד לא התחיל')

  const status = useMemo(() => {
    if (game.isCheckmate()) return game.turn() === 'w' ? 'השחור ניצח' : 'הלבן ניצח'
    if (game.isDraw()) return 'תיקו'
    if (game.isCheck()) return 'שח'
    return game.turn() === 'w' ? 'התור של הלבן' : 'התור של השחור'
  }, [game])

  function updateCoach(message: CoachMessage) {
    setCoach(message)
    speak(message.text)
  }

  async function updateCoachFromCloud(
    fallbackMessage: CoachMessage,
    nextGame: Chess,
    playerMove: Move,
    bestBeforeMove: MoveAnalysis | undefined,
    playedAnalysis: MoveAnalysis | undefined,
    nextMoveCount: number,
  ) {
    const loss =
      bestBeforeMove && playedAnalysis && Number.isFinite(bestBeforeMove.score) && Number.isFinite(playedAnalysis.score)
        ? bestBeforeMove.score - playedAnalysis.score
        : 0

    try {
      const response = await fetch('/api/coach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'move',
          localMessage: fallbackMessage.text,
          fen: nextGame.fen(),
          pgn: nextGame.pgn(),
          moveCount: nextMoveCount,
          move: {
            from: playerMove.from,
            to: playerMove.to,
            san: playerMove.san,
            color: 'w',
          },
          analysis: {
            bestMove: bestBeforeMove ? `${bestBeforeMove.move.from}${bestBeforeMove.move.to}` : undefined,
            playedMove: `${playerMove.from}${playerMove.to}`,
            bestScore: bestBeforeMove?.score,
            playedScore: playedAnalysis?.score,
            loss,
            scoreLabel: formatScore(evaluateBoard(nextGame)),
          },
        }),
      })

      if (!response.ok) return

      const cloudMessage = (await response.json()) as Partial<CoachMessage>
      if (typeof cloudMessage.text !== 'string') return

      updateCoach({
        text: cloudMessage.text,
        mood:
          cloudMessage.mood === 'good' || cloudMessage.mood === 'careful' || cloudMessage.mood === 'idea'
            ? cloudMessage.mood
            : fallbackMessage.mood,
      })
    } catch {
      // The local coach already spoke, so network failures can stay quiet.
    }
  }

  function onPieceDrop({ sourceSquare, targetSquare }: PieceDropHandlerArgs) {
    if (!targetSquare || game.turn() !== 'w' || game.isGameOver()) return false

    const analysesBeforeMove = analyzeLegalMoves(game, 2)
    const bestBeforeMove = analysesBeforeMove[0]
    const nextGame = new Chess(game.fen())
    let playerMove: Move

    try {
      playerMove = nextGame.move({
        from: sourceSquare as Square,
        to: targetSquare as Square,
        promotion: 'q',
      })
    } catch {
      updateCoach({
        mood: 'careful',
        text: 'המסע הזה לא חוקי. נסה כלי אחר או משבצת אחרת.',
      })
      return false
    }

    const playedAnalysis = findMoveAnalysis(analysesBeforeMove, playerMove)

    const nextMoveCount = movesPlayed + 1
    setMovesPlayed(nextMoveCount)
    setLastMove(`${playerMove.from} אל ${playerMove.to}`)
    setHighlightedSquares({
      [playerMove.from]: { background: '#bfdbfe' },
      [playerMove.to]: { background: '#86efac' },
    })

    const message = getCoachMessage(playerMove, nextGame, bestBeforeMove, playedAnalysis)

    if (!nextGame.isGameOver()) {
      const blackMove = pickBlackMove(nextGame)
      if (blackMove) {
        nextGame.move({ from: blackMove.from, to: blackMove.to, promotion: 'q' })
        setLastMove(`${playerMove.from} אל ${playerMove.to}; השחור: ${blackMove.from} אל ${blackMove.to}`)
      }
    }

    setGame(nextGame)
    updateCoach(message)
    void updateCoachFromCloud(message, nextGame, playerMove, bestBeforeMove, playedAnalysis, nextMoveCount)
    return true
  }

  function showHint() {
    if (game.turn() !== 'w' || game.isGameOver()) return
    const hint = getHint(game)
    setHighlightedSquares(hint.squares)
    updateCoach({ mood: 'idea', text: hint.text })
  }

  function resetGame() {
    const freshGame = new Chess()
    setGame(freshGame)
    setMovesPlayed(0)
    setLastMove('עוד לא התחיל')
    setHighlightedSquares({})
    updateCoach({
      mood: 'idea',
      text: 'מתחילים משחק חדש. קודם כל, נסה להוציא סוס או רץ למרכז.',
    })
  }

  return (
    <main className="app-shell" dir="rtl">
      <section className="coach-panel" aria-label="מאמן שחמט קולי">
        <div>
          <p className="eyebrow">מאמן שחמט קולי לילדים</p>
          <h1>שחמט עם מאמן מדבר</h1>
        </div>

        <div className={`speech-bubble ${coach.mood}`}>
          <Volume2 aria-hidden="true" />
          <p>{coach.text}</p>
        </div>

        <div className="controls" aria-label="פעולות משחק">
          <button type="button" onClick={() => speak(coach.text)} title="השמע שוב">
            <Volume2 aria-hidden="true" />
            <span>שוב</span>
          </button>
          <button type="button" onClick={showHint} title="רמז">
            <Lightbulb aria-hidden="true" />
            <span>רמז</span>
          </button>
          <button type="button" onClick={resetGame} title="משחק חדש">
            <RefreshCcw aria-hidden="true" />
            <span>חדש</span>
          </button>
        </div>
      </section>

      <section className="board-panel" aria-label="לוח שחמט">
        <div className="board-wrap">
          <Chessboard
            options={{
              id: 'kid-coach-board',
              position: game.fen(),
              boardOrientation: 'white',
              onPieceDrop,
              allowDrawingArrows: false,
              squareStyles: highlightedSquares,
              darkSquareStyle: { backgroundColor: '#769656' },
              lightSquareStyle: { backgroundColor: '#eeeed2' },
              boardStyle: {
                borderRadius: '8px',
                boxShadow: '0 24px 70px rgba(18, 24, 38, 0.22)',
                overflow: 'hidden',
              },
            }}
          />
        </div>
      </section>

      <aside className="parent-panel" aria-label="מצב להורה">
        <div>
          <span>מצב</span>
          <strong>{status}</strong>
        </div>
        <div>
          <span>מסעים של הילד</span>
          <strong>{movesPlayed}</strong>
        </div>
        <div>
          <span>מסע אחרון</span>
          <strong>{lastMove}</strong>
        </div>
        <button type="button" onClick={resetGame}>
          <RotateCcw aria-hidden="true" />
          התחלה מחדש
        </button>
      </aside>
    </main>
  )
}

export default App
