import { BaseSchema } from '@adonisjs/lucid/schema'

// Taken from quack-board (Simon's claude_sessions and claude_archives, their five migrations as one): the Claude
// sessions started from the app, keyed by Claude Code's own session id. Their conversation stays in Claude Code's
// history (~/.claude); these rows keep what it does not: the task, the repos, the state, the decisions, the cost.
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('lunar_industries_claude_sessions', (table) => {
      table.string('id').primary()
      table.string('task_id').nullable()
      // The folder the session runs in.
      table.string('cwd').notNullable()
      // JSON lists: the repos the session works on, and their worktrees.
      table.text('repos').notNullable().defaultTo('[]')
      table.text('worktrees').notNullable().defaultTo('[]')
      table.string('mode').notNullable()
      // running, waiting (a decision is expected), idle (Claude answered), saved (no process).
      table.string('status').notNullable()
      table.string('title').notNullable()
      // JSON list of the permission decisions: { id, tool, detail, allow, at }.
      table.text('decisions').notNullable().defaultTo('[]')
      // Null: Claude Code's default (the user's settings).
      table.string('model').nullable()
      table.string('effort').nullable()
      // `modelUsage` of the last result, a JSON object keyed by model, and its totals; not in the transcript.
      table.text('usage').nullable()
      table.float('cost_usd').nullable()
      table.integer('turns').nullable()
      // 'subscription' or 'apiKey': how the session was billed.
      table.string('login').nullable()
      // 'terminal': a session of the terminal given a row to carry its task; null: started from the app.
      table.string('origin').nullable()
      table.string('created_at').notNullable()
      table.string('updated_at').notNullable()
    })
    // The sessions the user archived (the app's, the terminal's, VS Code's), by Claude Code's session id.
    this.schema.createTable('lunar_industries_claude_archives', (table) => {
      table.string('session_id').primary()
      table.string('created_at').notNullable()
    })
  }

  async down() {
    this.schema.dropTable('lunar_industries_claude_archives')
    this.schema.dropTable('lunar_industries_claude_sessions')
  }
}
