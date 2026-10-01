import { diffLines, toolsSummary, type ToolCallEvent, type ToolResultEvent, type Tools } from './events.ts'

/**
 * One tool call of Claude (Simon's tool-call): its line (the tool and its detail), which opens on its result, then
 * the file change it makes, shown at all times.
 */
export function ToolCall({ call, result }: { call: ToolCallEvent; result: ToolResultEvent | null }) {
  const change = call.change
  return (
    <div className="lc-call">
      <details className="lc-disclosure">
        <summary className="row">
          <span className="lc-call-name">{call.name}</span>
          <span className="mono ellipsis grow">{call.detail}</span>
          {result?.ok === false && <span className="tag lc-tone-bad">erreur</span>}
          {!result && <span className="legend">en cours…</span>}
        </summary>
        {result && <pre className="mono lc-call-output selectable">{result.text || '(rien)'}</pre>}
      </details>
      {change && (
        <div className="lc-diff">
          <div className="row lc-diff-head">
            <span className="lc-call-name">{change.before ? 'Modifié' : 'Créé'}</span>
            <span className="mono ellipsis grow">{change.file}</span>
          </div>
          <pre className="mono lc-diff-body selectable">
            {diffLines(change.before, change.after).map((l, i) => (
              <span key={i} className={`lc-diff-line ${l.sign === '-' ? 'removed' : 'added'}`}>
                {l.sign} {l.text}
              </span>
            ))}
          </pre>
        </div>
      )}
    </div>
  )
}

// Consecutive calls: one block, closed by default, holding each call; a single call stands alone.
export function ToolCalls({ tools }: { tools: Tools }) {
  const [first] = tools
  if (tools.length === 1 && first) return <ToolCall call={first.call} result={first.result} />
  const summary = toolsSummary(tools)
  return (
    <details className="lc-disclosure lc-tools">
      <summary className="row">
        <span className="lc-call-name grow">{summary.label}</span>
        {summary.failed && <span className="tag lc-tone-bad">erreur</span>}
        {summary.running && <span className="legend">en cours…</span>}
      </summary>
      <div className="lc-tools-body">
        {tools.map((t) => (
          <ToolCall key={t.call.seq} call={t.call} result={t.result} />
        ))}
      </div>
    </details>
  )
}
