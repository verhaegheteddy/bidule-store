import { useEffect, useState } from 'react'
import { react, saveSettingValues, useSettingValues } from '@bidule/sdk'
import type { ClaudePlace, RepoOverrides, RepoSettings } from '../contract.ts'
import { api, errorMessage } from './api.ts'
import { Places } from './ClaudePage.tsx'
import { useEnabled } from './state.ts'

const REPOS = 'lunar-industries-claude.repos'

// A repo's own settings, as the panel asks them (empty: the module's, above).
const FIELDS: { key: keyof RepoOverrides; title: string; placeholder?: string; hint?: string }[] = [
  { key: 'reviewTarget', title: 'Branche cible des MR', placeholder: 'develop' },
  { key: 'stagingBranch', title: 'Branche de staging' },
  { key: 'productionBranch', title: 'Branche de production' },
  { key: 'stagingJob', title: 'Job de staging', hint: '{env} : l’environnement.' },
  { key: 'productionJob', title: 'Job de production' },
  { key: 'stagingEnv', title: 'Environnement de staging' },
  {
    key: 'worktreeSeed',
    title: 'Fichiers recopiés dans un worktree',
    placeholder: '.env, config/*.local.yml',
    hint: 'Non suivis par git, relatifs au dépôt.',
  },
  { key: 'worktreePrepare', title: 'Préparation d’un worktree', placeholder: 'npm ci' },
]

// The overrides kept in the hidden setting, by repo path.
function overridesOf(raw: unknown): Record<string, RepoOverrides> {
  try {
    const parsed: unknown = JSON.parse(String(raw ?? '{}'))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, RepoOverrides>) : {}
  } catch {
    return {}
  }
}

/**
 * Under the module's settings: the Claude Code the sessions run (found, logged in), and each repo's own settings for
 * the sessions and their tools (Simon's Réglages › Claude), kept in the hidden setting `lunar-industries-claude.repos`.
 */
export function SettingsPanel() {
  const enabled = useEnabled()
  const [places, setPlaces] = useState<ClaudePlace[] | null>(null)
  const [checking, setChecking] = useState(false)
  const [repos, setRepos] = useState<RepoSettings[] | null>(null)
  const [reposError, setReposError] = useState<string | null>(null)

  const check = async () => {
    setChecking(true)
    try {
      setPlaces((await api.status()).places)
    } catch (err) {
      setPlaces([])
      react('panic', errorMessage(err), errorMessage(err))
    } finally {
      setChecking(false)
    }
  }
  useEffect(() => {
    if (!enabled) return
    void check()
    void api.repos().then(
      (r) => setRepos(r.repos),
      (err) => setReposError(errorMessage(err)),
    )
  }, [enabled])

  if (!enabled) return <p className="legend">Allume les sessions pour vérifier Claude Code et régler chaque dépôt.</p>

  return (
    <>
      <section className="lc-settings-block" aria-labelledby="lc-settings-places">
        <div className="row">
          <h3 id="lc-settings-places" className="grow">
            Claude Code
          </h3>
          <button type="button" className="btn lc-btn-sm" disabled={checking} onClick={() => void check()}>
            {checking ? 'Vérification…' : 'Vérifier'}
          </button>
        </div>
        <Places places={places} checking={checking} />
      </section>
      <section className="lc-settings-block" aria-labelledby="lc-settings-repos">
        <h3 id="lc-settings-repos">Par dépôt</h3>
        <p className="legend">Vide : le réglage du module, plus haut.</p>
        {reposError && <p className="test-result bad">{reposError}</p>}
        {repos?.map((r) => <RepoForm key={r.path} repo={r} />)}
        {repos && !repos.length && <p className="legend">Aucun dépôt connu.</p>}
      </section>
    </>
  )
}

function RepoForm({ repo }: { repo: RepoSettings }) {
  const values = useSettingValues()
  const saved = overridesOf(values?.[REPOS])[repo.path] ?? {}
  const [draft, setDraft] = useState<RepoOverrides | null>(null)
  const [saving, setSaving] = useState(false)
  const shown = draft ?? saved

  const save = async () => {
    if (!draft) return
    setSaving(true)
    try {
      const all = overridesOf(values?.[REPOS])
      const kept = Object.fromEntries(Object.entries(draft).filter(([, v]) => typeof v === 'string' && v.trim()))
      if (Object.keys(kept).length) all[repo.path] = kept
      else delete all[repo.path]
      await saveSettingValues({ [REPOS]: JSON.stringify(all) })
      setDraft(null)
      react('quack', `Réglages de ${repo.label} enregistrés, coin !`, `${repo.label} réglé`)
    } catch (err) {
      react('panic', errorMessage(err), errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const count = FIELDS.filter((f) => saved[f.key]).length
  return (
    <details className="lc-disclosure lc-repo">
      <summary className="row">
        <strong className="grow ellipsis">{repo.label}</strong>
        {count > 0 && <span className="legend">{count} réglage{count > 1 ? 's' : ''}</span>}
      </summary>
      <form
        className="lc-repo-form"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <p className="legend mono ellipsis" title={repo.path}>
          {repo.path}
        </p>
        <div className="fields">
          {FIELDS.map((f) => (
            <label key={f.key} className="field">
              {f.title}
              <input
                value={shown[f.key] ?? ''}
                placeholder={f.placeholder}
                onChange={(e) => setDraft({ ...shown, [f.key]: e.target.value })}
              />
              {f.hint && <span className="hint">{f.hint}</span>}
            </label>
          ))}
        </div>
        <div className="row">
          <span className="grow" />
          {draft && (
            <button type="button" className="btn" onClick={() => setDraft(null)}>
              Annuler
            </button>
          )}
          <button type="submit" className="btn" disabled={!draft || saving}>
            Enregistrer
          </button>
        </div>
      </form>
    </details>
  )
}
