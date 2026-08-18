import sqlite3 from "sqlite3"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const databaseFile = path.resolve(
    process.env.DATABASE || path.join(__dirname, "../data/bot.db")
)

fs.mkdirSync(path.dirname(databaseFile), {
    recursive: true
})

const db = new sqlite3.Database(databaseFile, err => {
    if (err) {
        console.error("[DB] Connection error:", err)
    } else {
        console.log(`[DB] Connected: ${databaseFile}`)
    }
})

db.serialize(() => {

    db.run(`
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            phone TEXT,
            status TEXT DEFAULT 'disconnected',
            created_at INTEGER DEFAULT (unixepoch()),
            updated_at INTEGER DEFAULT (unixepoch())
        )
    `)

    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            jid TEXT PRIMARY KEY,
            name TEXT,
            created_at INTEGER DEFAULT (unixepoch())
        )
    `)

    db.run(`
        CREATE TABLE IF NOT EXISTS groups (
            jid TEXT PRIMARY KEY,
            name TEXT,
            settings TEXT DEFAULT '{}',
            created_at INTEGER DEFAULT (unixepoch()),
            updated_at INTEGER DEFAULT (unixepoch())
        )
    `)

    db.run(`
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT,
            jid TEXT,
            sender TEXT,
            text TEXT,
            created_at INTEGER DEFAULT (unixepoch())
        )
    `)

    console.log("[DB] Tables ready")
})

function run(sql, params = []) {
    return new Promise((resolve, reject) => {

        db.run(sql, params, function(err) {

            if (err) {
                console.error("[DB] RUN:", err.message)
                return reject(err)
            }

            resolve({
                id: this.lastID,
                changes: this.changes
            })
        })
    })
}

function get(sql, params = []) {
    return new Promise((resolve, reject) => {

        db.get(sql, params, (err, row) => {

            if (err) {
                console.error("[DB] GET:", err.message)
                return reject(err)
            }

            resolve(row)
        })
    })
}

function all(sql, params = []) {
    return new Promise((resolve, reject) => {

        db.all(sql, params, (err, rows) => {

            if (err) {
                console.error("[DB] ALL:", err.message)
                return reject(err)
            }

            resolve(rows)
        })
    })
}

export {
    db,
    run,
    get,
    all
}