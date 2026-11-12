import { DatabaseSync } from "node:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

export interface SessionRecord {
  info: Record<string, unknown>
  messages: Record<string, unknown>[]
}

// Persists one row per session: its public info and the projected message list.
export class Store {
  #db: DatabaseSync

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
    this.#db = new DatabaseSync(path)
    this.#db.exec(
      `CREATE TABLE IF NOT EXISTS sessions (
         id TEXT PRIMARY KEY,
         info TEXT NOT NULL,
         messages TEXT NOT NULL DEFAULT '[]',
         updated INTEGER NOT NULL
       )`,
    )
  }

  save(id: string, record: SessionRecord): void {
    this.#db
      .prepare(
        `INSERT INTO sessions (id, info, messages, updated) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET info=excluded.info, messages=excluded.messages, updated=excluded.updated`,
      )
      .run(id, JSON.stringify(record.info), JSON.stringify(record.messages), Date.now())
  }

  load(id: string): SessionRecord | undefined {
    const row = this.#db.prepare(`SELECT info, messages FROM sessions WHERE id = ?`).get(id) as
      | { info: string; messages: string }
      | undefined
    if (!row) return undefined
    return { info: JSON.parse(row.info), messages: JSON.parse(row.messages) }
  }

  list(): { id: string; record: SessionRecord }[] {
    const rows = this.#db.prepare(`SELECT id, info, messages FROM sessions ORDER BY updated DESC`).all() as {
      id: string
      info: string
      messages: string
    }[]
    return rows.map((row) => ({
      id: row.id,
      record: { info: JSON.parse(row.info), messages: JSON.parse(row.messages) },
    }))
  }

  delete(id: string): void {
    this.#db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id)
  }

  close(): void {
    this.#db.close()
  }
}
