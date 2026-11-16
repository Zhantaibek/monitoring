import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Kind, Level } from '../monitoring/types.js';

export interface PersistedState {
  key: string;
  level: Level;
  since: number;
}

export interface IncidentRow {
  id: number;
  check_key: string;
  kind: string;
  title: string;
  subject: string;
  severity: Level;
  started_at: number;
  ended_at: number | null;
}

export interface OutboxRow {
  id: number;
  created_at: number;
  text: string;
  attempts: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  check_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  subject TEXT NOT NULL,
  severity TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_incidents_open ON incidents(check_key, ended_at);
CREATE INDEX IF NOT EXISTS idx_incidents_started ON incidents(started_at);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  check_key TEXT NOT NULL,
  type TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  notified INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);

CREATE TABLE IF NOT EXISTS check_state (
  check_key TEXT PRIMARY KEY,
  level TEXT NOT NULL,
  since INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  text TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  sent_at INTEGER,
  failed INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(sent_at, failed, next_attempt_at);

CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
`;

const DAY = 86_400_000;

export class Database {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'monitor.db'));
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  // ---------- kv ----------
  get(k: string): string | undefined {
    const row = this.db.prepare('SELECT v FROM kv WHERE k = ?').get(k) as { v: string } | undefined;
    return row?.v;
  }

  set(k: string, v: string): void {
    this.db.prepare('INSERT INTO kv(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
  }

  // ---------- состояние проверок ----------
  loadStates(): PersistedState[] {
    return this.db.prepare('SELECT check_key AS key, level, since FROM check_state').all() as unknown as PersistedState[];
  }

  saveState(s: PersistedState): void {
    this.db
      .prepare('INSERT INTO check_state(check_key, level, since) VALUES(?, ?, ?) ON CONFLICT(check_key) DO UPDATE SET level = excluded.level, since = excluded.since')
      .run(s.key, s.level, s.since);
  }

  deleteState(key: string): void {
    this.db.prepare('DELETE FROM check_state WHERE check_key = ?').run(key);
  }

  // ---------- инциденты ----------
  openIncident(p: { key: string; kind: Kind; title: string; subject: string; severity: Level; startedAt: number }): void {
    const open = this.db.prepare('SELECT id FROM incidents WHERE check_key = ? AND ended_at IS NULL').get(p.key);
    if (open) {
      this.updateIncidentSeverity(p.key, p.severity);
      return;
    }
    this.db
      .prepare('INSERT INTO incidents(check_key, kind, title, subject, severity, started_at) VALUES(?, ?, ?, ?, ?, ?)')
      .run(p.key, p.kind, p.title, p.subject, p.severity, p.startedAt);
  }

  /** Поднимает (не понижает) максимальную серьёзность открытого инцидента. */
  updateIncidentSeverity(key: string, severity: Level): void {
    if (severity !== 'CRITICAL') return;
    this.db.prepare("UPDATE incidents SET severity = 'CRITICAL' WHERE check_key = ? AND ended_at IS NULL").run(key);
  }

  closeIncident(key: string, endedAt: number): void {
    this.db.prepare('UPDATE incidents SET ended_at = ? WHERE check_key = ? AND ended_at IS NULL').run(endedAt, key);
  }

  recentIncidents(limit: number): IncidentRow[] {
    return this.db.prepare('SELECT * FROM incidents ORDER BY started_at DESC LIMIT ?').all(limit) as unknown as IncidentRow[];
  }

  // ---------- журнал событий приложения ----------
  addEvent(p: { key: string; type: string; level: Level | 'INFO'; message: string; notified: boolean; ts?: number }): void {
    this.db
      .prepare('INSERT INTO events(ts, check_key, type, level, message, notified) VALUES(?, ?, ?, ?, ?, ?)')
      .run(p.ts ?? Date.now(), p.key, p.type, p.level, p.message.slice(0, 1000), p.notified ? 1 : 0);
  }

  // ---------- очередь исходящих сообщений ----------
  enqueue(text: string, now = Date.now()): number {
    const r = this.db.prepare('INSERT INTO outbox(created_at, text, next_attempt_at) VALUES(?, ?, ?)').run(now, text, now);
    return Number(r.lastInsertRowid);
  }

  pendingOutbox(now: number, limit: number): OutboxRow[] {
    return this.db
      .prepare('SELECT id, created_at, text, attempts FROM outbox WHERE sent_at IS NULL AND failed = 0 AND next_attempt_at <= ? ORDER BY id LIMIT ?')
      .all(now, limit) as unknown as OutboxRow[];
  }

  pendingCount(): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE sent_at IS NULL AND failed = 0').get() as { n: number };
    return r.n;
  }

  markSent(id: number, now = Date.now()): void {
    this.db.prepare('UPDATE outbox SET sent_at = ?, last_error = NULL WHERE id = ?').run(now, id);
  }

  markAttemptFailed(id: number, error: string, nextAttemptAt: number, permanent: boolean): void {
    this.db
      .prepare('UPDATE outbox SET attempts = attempts + 1, last_error = ?, next_attempt_at = ?, failed = ? WHERE id = ?')
      .run(error.slice(0, 500), nextAttemptAt, permanent ? 1 : 0, id);
  }

  /** Повторная попытка всех отложенных сообщений сразу (после восстановления связи). */
  retryNow(now = Date.now()): void {
    this.db.prepare('UPDATE outbox SET next_attempt_at = ? WHERE sent_at IS NULL AND failed = 0').run(now);
  }

  // ---------- обслуживание ----------
  cleanup(retentionDays: number, now = Date.now()): void {
    const border = now - retentionDays * DAY;
    this.db.prepare('DELETE FROM events WHERE ts < ?').run(border);
    this.db.prepare('DELETE FROM incidents WHERE ended_at IS NOT NULL AND ended_at < ?').run(border);
    this.db.prepare('DELETE FROM outbox WHERE (sent_at IS NOT NULL OR failed = 1) AND created_at < ?').run(now - 7 * DAY);
    // Неотправленные старше 3 суток неактуальны
    this.db.prepare('UPDATE outbox SET failed = 1 WHERE sent_at IS NULL AND created_at < ?').run(now - 3 * DAY);
  }
}
