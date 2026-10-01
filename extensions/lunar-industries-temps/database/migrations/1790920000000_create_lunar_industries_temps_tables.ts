import { BaseSchema } from '@adonisjs/lucid/schema'

// Taken from quack-board (Simon's day_shares and drop_draft_suggested, as one): what the app keeps of the days. A day
// is worth 20 twentieths; the Time Log is the reference, mirrored here for the days the page shows.
export default class extends BaseSchema {
  async up() {
    // A day's draft: one line per task (or branch without a task, or label), until sent.
    this.schema.createTable('lunar_industries_temps_drafts', (table) => {
      table.increments('id')
      table.string('day').notNullable().index()
      table.string('task_id').nullable()
      table.string('label').notNullable().defaultTo('')
      // A line from a branch linked to no task.
      table.text('repo').nullable()
      table.string('branch').nullable()
      table.integer('share').notNullable().defaultTo(0)
      // Some activity, too little to reach 0.05.
      table.integer('tiny').notNullable().defaultTo(0)
      // A line without a task kept on purpose, a deployment, a line added by hand or copied from the Time Log.
      table.integer('confirmed').notNullable().defaultTo(0)
      table.text('reason').notNullable().defaultTo('')
      // The Time Log's other properties, as JSON.
      table.text('props').notNullable().defaultTo('{}')
    })
    // A day whose draft is the user's: it no longer follows the signals.
    this.schema.createTable('lunar_industries_temps_days', (table) => {
      table.string('day').primary()
      table.integer('edited').notNullable().defaultTo(0)
    })
    // The user's Time Log entries, as the Time Log answered; one no longer there is hidden.
    this.schema.createTable('lunar_industries_temps_log', (table) => {
      table.string('id').primary()
      table.string('day').notNullable().index()
      table.string('task_id').nullable()
      table.string('label').notNullable().defaultTo('')
      table.integer('share').notNullable()
      table.text('url').nullable()
      table.text('props').notNullable().defaultTo('{}')
      table.string('last_edited').nullable()
      table.string('deleted_at').nullable()
    })
  }

  async down() {
    for (const table of ['lunar_industries_temps_log', 'lunar_industries_temps_days', 'lunar_industries_temps_drafts']) {
      this.schema.dropTable(table)
    }
  }
}
