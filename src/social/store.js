// Хранилище диагностических метрик: отдельный SQLite-файл, без дублей.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

class SocialStore {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS social_communities (
        platform TEXT NOT NULL, identifier TEXT NOT NULL, url TEXT, name TEXT,
        subscribers INTEGER, subscribers_source TEXT, subscribers_approximate INTEGER DEFAULT 0,
        collected_at TEXT, PRIMARY KEY (platform, identifier));
      CREATE TABLE IF NOT EXISTS social_posts (
        platform TEXT NOT NULL, identifier TEXT NOT NULL, external_id TEXT NOT NULL, url TEXT,
        published_at TEXT, views INTEGER, views_approximate INTEGER DEFAULT 0, views_raw TEXT,
        views_source TEXT, collected_at TEXT, PRIMARY KEY (platform, identifier, external_id));
    `);
  }
  saveCommunity({ platform, identifier, url, name, subscribers }) {
    const exists = this.db.prepare('SELECT 1 FROM social_communities WHERE platform=? AND identifier=?').get(platform, identifier);
    this.db.prepare(`INSERT INTO social_communities
      (platform,identifier,url,name,subscribers,subscribers_source,subscribers_approximate,collected_at)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(platform,identifier) DO UPDATE SET
        url=excluded.url, name=excluded.name, subscribers=excluded.subscribers,
        subscribers_source=excluded.subscribers_source, subscribers_approximate=excluded.subscribers_approximate,
        collected_at=excluded.collected_at`)
      .run(platform, identifier, url, name,
        subscribers?.available ? subscribers.value : null, subscribers?.source || null,
        subscribers?.approximate ? 1 : 0, subscribers?.collectedAt || null);
    return { inserted: !exists, updated: Boolean(exists) };
  }
  savePosts(platform, identifier, posts) {
    const exists = this.db.prepare('SELECT 1 FROM social_posts WHERE platform=? AND identifier=? AND external_id=?');
    const statement = this.db.prepare(`INSERT INTO social_posts
      (platform,identifier,external_id,url,published_at,views,views_approximate,views_raw,views_source,collected_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(platform,identifier,external_id) DO UPDATE SET
        url=excluded.url, published_at=excluded.published_at, views=excluded.views,
        views_approximate=excluded.views_approximate, views_raw=excluded.views_raw,
        views_source=excluded.views_source, collected_at=excluded.collected_at`);
    let inserted = 0, updated = 0, skipped = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const post of posts) {
        if (!post.externalId) { skipped += 1; continue; }
        if (exists.get(platform, identifier, post.externalId)) updated += 1; else inserted += 1;
        statement.run(platform, identifier, post.externalId, post.url, post.publishedAt,
          post.views?.available ? post.views.value : null, post.views?.approximate ? 1 : 0,
          post.views?.raw || null, post.views?.source || null, post.views?.collectedAt || null);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { inserted, updated, skipped };
  }
  readCommunity(platform, identifier) {
    return this.db.prepare('SELECT * FROM social_communities WHERE platform=? AND identifier=?').get(platform, identifier) || null;
  }
  readPosts(platform, identifier) {
    return this.db.prepare('SELECT * FROM social_posts WHERE platform=? AND identifier=? ORDER BY published_at DESC').all(platform, identifier);
  }
  close() { this.db.close(); }
}

module.exports = { SocialStore };
