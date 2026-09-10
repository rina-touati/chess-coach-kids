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
const centerSquares = new Set(['d4', 'e4', 'd5', 'e5'])
const startingBackRank = new Set(['b1', 'c1', 'f1', 'g1'])

function speak(text: string) {
  window.speechSynthesis.cancel()
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.lang = 'he-IL'
  utterance.rate = 0.9
  utterance.pitch = 1.08
  window.speechSynthesis.speak(utterance)
}

function getCoachMessage(move: Move, chess: Chess): CoachMessage {
  if (chess.isCheckmate()) {
    return {
      mood: 'good',
      text: `וואו ${kidName}! זה מט. ניצחת במשחק.`,
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
    text: `מסע נחמד. עכשיו נשאל שאלה פשוטה: איזה כלי שלך עוד לא משחק?`,
  }
}

function pickBlackMove(chess: Chess) {
  const moves = chess.moves({ verbose: true })
  if (moves.length === 0) return null

  const checks = moves.filter((move) => move.san.includes('+'))
  const captures = moves.filter((move) => move.captured)
  const develops = moves.filter((move) => move.piece === 'n' || move.piece === 'b')
  const pool = checks[0] ? checks : captures[0] ? captures : develops[0] ? develops : moves

  return pool[Math.floor(Math.random() * pool.length)]
}

function getHint(chess: Chess) {
  const moves = chess.moves({ verbose: true })
  const capture = moves.find((move) => move.captured)
  const check = moves.find((move) => move.san.includes('+'))
  const center = moves.find((move) => centerSquares.has(move.to))
  const develop = moves.find(
    (move) => (move.piece === 'n' || move.piece === 'b') && startingBackRank.has(move.from),
  )

  const best = check ?? capture ?? develop ?? center ?? moves[0]

  if (!best) {
    return {
      text: 'המשחק נגמר. אפשר להתחיל מחדש.',
      squares: {},
    }
  }

  return {
    text: `רמז קטן: תסתכל על הכלי ב${best.from}, אולי הוא יכול ללכת ל${best.to}.`,
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

  function onPieceDrop({ sourceSquare, targetSquare }: PieceDropHandlerArgs) {
    if (!targetSquare || game.turn() !== 'w' || game.isGameOver()) return false

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

    setMovesPlayed((value) => value + 1)
    setLastMove(`${playerMove.from} אל ${playerMove.to}`)
    setHighlightedSquares({
      [playerMove.from]: { background: '#bfdbfe' },
      [playerMove.to]: { background: '#86efac' },
    })

    const message = getCoachMessage(playerMove, nextGame)

    if (!nextGame.isGameOver()) {
      const blackMove = pickBlackMove(nextGame)
      if (blackMove) {
        nextGame.move({ from: blackMove.from, to: blackMove.to, promotion: 'q' })
        setLastMove(`${playerMove.from} אל ${playerMove.to}; השחור: ${blackMove.from} אל ${blackMove.to}`)
      }
    }

    setGame(nextGame)
    updateCoach(message)
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
