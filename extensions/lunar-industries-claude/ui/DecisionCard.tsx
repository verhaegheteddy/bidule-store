import { useState } from 'react'
import type { Decision } from '../contract.ts'
import { cardTitle, type DecisionEvent, type Permission } from './events.ts'
import { md } from './markdown.ts'

// A card already answered: what was decided, in a line.
export function Decided({ card, decision }: { card: Permission; decision: DecisionEvent }) {
  return (
    <div className="row lc-decided">
      <span className={`tag lc-tone-${decision.allow ? 'ok' : 'bad'}`}>
        {decision.always ? 'Autorisé pour la session' : decision.allow ? 'Autorisé' : 'Refusé'}
      </span>
      <span className="mono ellipsis grow">{card.ask === 'plan' ? 'Plan' : card.detail}</span>
      {decision.answer && <span className="legend ellipsis">{decision.answer}</span>}
    </div>
  )
}

/**
 * What Claude waits for (Simon's decision cards): a tool's permission, a plan to validate (refused with an
 * instruction), or its questions, one choice or several each.
 */
export function DecisionCard({
  card,
  busy,
  decide,
}: {
  card: Permission
  busy: boolean
  decide: (card: Permission, decision: Decision) => void
}) {
  const [instruction, setInstruction] = useState('')
  const [answers, setAnswers] = useState<Record<string, string[]>>({})
  const chosen = (q: string) => answers[q] ?? []
  const toggle = (q: string, label: string, multi: boolean) => {
    const now = chosen(q)
    const next = now.includes(label) ? now.filter((l) => l !== label) : multi ? [...now, label] : [label]
    setAnswers({ ...answers, [q]: next })
  }
  const answered = card.questions.every((q) => chosen(q.question).length > 0)

  if (card.ask === 'plan')
    return (
      <div className="lc-card" role="group" aria-label="Claude propose un plan">
        <strong>Claude propose un plan</strong>
        <div className="lc-text lc-plan selectable" dangerouslySetInnerHTML={{ __html: md(card.plan ?? 'Le plan est dans le message au-dessus.') }} />
        <label className="field wide">
          Pour le refuser, dites à Claude quoi changer
          <textarea className="lc-textarea" rows={2} value={instruction} onChange={(e) => setInstruction(e.target.value)} />
        </label>
        <div className="row">
          <button
            type="button"
            className="btn"
            disabled={busy || !instruction.trim()}
            onClick={() => decide(card, { allow: false, message: instruction.trim() })}
          >
            Refuser avec cette consigne
          </button>
          <span className="grow" />
          <button type="button" className="btn-cta" disabled={busy} onClick={() => decide(card, { allow: true })}>
            Valider le plan
          </button>
        </div>
      </div>
    )

  if (card.ask === 'question')
    return (
      <div className="lc-card" role="group" aria-label="Claude pose une question">
        <strong>Claude pose {card.questions.length > 1 ? 'des questions' : 'une question'}</strong>
        {card.questions.map((q) => (
          <div key={q.question} className="lc-question">
            <span className="row">
              <span className="tag lc-tone-neutral">{q.header}</span>
              <span>{q.question}</span>
            </span>
            <div className="row lc-choices" role="group" aria-label={q.question}>
              {q.options.map((o) => (
                <button
                  key={o.label}
                  type="button"
                  className="chip-btn"
                  title={o.description}
                  aria-pressed={chosen(q.question).includes(o.label)}
                  onClick={() => toggle(q.question, o.label, q.multiSelect)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        ))}
        <div className="row">
          <button type="button" className="btn" disabled={busy} onClick={() => decide(card, { allow: false })}>
            Ne pas répondre
          </button>
          <span className="grow" />
          <button
            type="button"
            className="btn-cta"
            disabled={busy || !answered}
            onClick={() =>
              decide(card, {
                allow: true,
                answers: Object.fromEntries(card.questions.map((q) => [q.question, chosen(q.question).join(', ')])),
              })
            }
          >
            Répondre
          </button>
        </div>
      </div>
    )

  return (
    <div className="lc-card" role="group" aria-label={cardTitle(card)}>
      <strong>{cardTitle(card)}</strong>
      <pre className="mono lc-command selectable">{card.detail}</pre>
      <div className="row">
        <button type="button" className="btn" disabled={busy} onClick={() => decide(card, { allow: false })}>
          Refuser
        </button>
        {card.canAlways && (
          <button type="button" className="btn" disabled={busy} onClick={() => decide(card, { allow: true, always: true })}>
            Toujours pour cette session
          </button>
        )}
        <span className="grow" />
        <button type="button" className="btn-cta" disabled={busy} onClick={() => decide(card, { allow: true })}>
          Autoriser
        </button>
      </div>
    </div>
  )
}
