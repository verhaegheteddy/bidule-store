import { Modal, openDialog } from '@bidule/sdk'

export type Ask = { title: string; text: string; confirm: string }

// Every write on the forge is asked first (Simon's confirm-dialog): resolves to the answer.
export function confirm(ask: Ask): Promise<boolean> {
  return new Promise((resolve) => {
    openDialog((close) => {
      const answer = (yes: boolean) => {
        close()
        resolve(yes)
      }
      return (
        <Modal label={ask.title} onClose={() => answer(false)}>
          <h2>{ask.title}</h2>
          <p>{ask.text}</p>
          <div className="row">
            <span className="grow" />
            <button type="button" className="btn" onClick={() => answer(false)}>
              Annuler
            </button>
            <button type="button" className="btn-cta" autoFocus onClick={() => answer(true)}>
              {ask.confirm}
            </button>
          </div>
        </Modal>
      )
    })
  })
}
