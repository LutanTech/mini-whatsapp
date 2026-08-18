const fs = require("fs")
const path = require("path")
const { Boom } = require("@hapi/boom")
const pino = require("pino")
const { run, all } = require("./database")

let makeWASocket
let useMultiFileAuthState
let DisconnectReason
let Browsers
let fetchLatestWaWebVersion

async function loadBaileys() {
    if (makeWASocket) return

    const baileys = await import("@whiskeysockets/baileys")

    makeWASocket = baileys.default
    useMultiFileAuthState = baileys.useMultiFileAuthState
    DisconnectReason = baileys.DisconnectReason
    Browsers = baileys.Browsers
    fetchLatestWaWebVersion = baileys.fetchLatestWaWebVersion
}

const sessions = new Map()

const SESSION_DIR = path.resolve(
    process.env.SESSION_DIR || "./sessions"
)

fs.mkdirSync(SESSION_DIR, { recursive: true })

const logger = pino({
    level: process.env.LOG_LEVEL || "silent"
})

async function saveStatus(id, phone, status) {
    try {
        await run(`
            INSERT INTO sessions
            (id, phone, status)
            VALUES (?, ?, ?)
            ON CONFLICT(id)
            DO UPDATE SET
                phone = excluded.phone,
                status = excluded.status,
                updated_at = unixepoch()
        `, [id, phone, status])
    } catch (err) {
        console.error("[DB]", err.message)
    }
}

async function createSession(id, phone = "") {
    await loadBaileys()

    if (sessions.has(id)) {
        return sessions.get(id)
    }

    const folder = path.join(SESSION_DIR, id)

    fs.mkdirSync(folder, {
        recursive: true
    })

    let auth

    try {
        auth = await useMultiFileAuthState(folder)
    } catch (err) {
        console.error(
            "[AUTH] Load failed:",
            err.message
        )

        throw err
    }

    const {
        state,
        saveCreds
    } = auth

    let version

    try {
        const latest =
            await fetchLatestWaWebVersion()

        if (latest?.version) {
            version = latest.version
        }
    } catch (err) {
        console.error(
            "[WA] Version fetch failed:",
            err.message
        )
    }

    let sock

    try {
        const options = {
            auth: state,
            logger,
            markOnlineOnConnect: false,
            browser: Browsers.windows("Chrome"),
            printQRInTerminal: false,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000
        }

        if (version) {
            options.version = version
        }

        sock = makeWASocket(options)
    } catch (err) {
        console.error(
            "[WA] Socket failed:",
            err.message
        )

        throw err
    }

    const session = {
        id,
        phone,
        sock,
        status: "connecting",

        // WhatsApp contacts for this session
        contacts: new Map()
    }

    sessions.set(id, session)

    await saveStatus(
        id,
        phone,
        "connecting"
    )

    /*
     * Credentials
     */

    sock.ev.on(
        "creds.update",
        async creds => {
            try {
                await saveCreds(creds)
            } catch (err) {
                console.error(
                    "[AUTH] Save failed:",
                    err.message
                )
            }
        }
    )

    /*
     * Contacts
     */

    sock.ev.on(
        "contacts.upsert",
        items => {
            for (const contact of items) {
                if (!contact?.id) continue

                const old =
                    session.contacts.get(contact.id) || {}

                session.contacts.set(
                    contact.id,
                    {
                        ...old,
                        ...contact
                    }
                )
            }
        }
    )

    sock.ev.on(
        "contacts.update",
        items => {
            for (const contact of items) {
                if (!contact?.id) continue

                const old =
                    session.contacts.get(contact.id) || {}

                session.contacts.set(
                    contact.id,
                    {
                        ...old,
                        ...contact
                    }
                )
            }
        }
    )

    /*
     * Connection
     */

    sock.ev.on(
        "connection.update",
        async update => {
            const {
                connection,
                lastDisconnect
            } = update

            if (connection === "connecting") {
                session.status = "connecting"

                await saveStatus(
                    id,
                    phone,
                    "connecting"
                )
            }

            if (connection === "open") {
                session.status = "connected"

                await saveStatus(
                    id,
                    phone,
                    "connected"
                )

                console.log(
                    `[WA] Connected: ${id}`
                )
            }

            if (connection !== "close") {
                return
            }

            let code

            try {
                code = new Boom(
                    lastDisconnect?.error
                ).output.statusCode
            } catch {
                code = undefined
            }

            session.status = "disconnected"

            await saveStatus(
                id,
                phone,
                "disconnected"
            )

            console.error(
                `[WA] Disconnected: ${id} (${code || "unknown"})`
            )

            if (
                lastDisconnect?.error?.message
            ) {
                console.error(
                    `[WA] ${lastDisconnect.error.message}`
                )
            }

            /*
             * Permanent logout / bad session
             */

            if (
                code === DisconnectReason.loggedOut ||
                code === DisconnectReason.badSession
            ) {
                sessions.delete(id)

                console.error(
                    `[WA] Session invalid: ${id}`
                )

                return
            }

            /*
             * Another WhatsApp connection replaced this one
             */

            if (
                code === DisconnectReason.connectionReplaced
            ) {
                sessions.delete(id)

                console.error(
                    `[WA] Session replaced: ${id}`
                )

                return
            }

            /*
             * Reconnectable errors
             */

            const reconnectable = [
                DisconnectReason.connectionClosed,
                DisconnectReason.connectionLost,
                DisconnectReason.timedOut,
                DisconnectReason.restartRequired
            ]

            if (
                !reconnectable.includes(code)
            ) {
                sessions.delete(id)

                console.error(
                    `[WA] Not reconnecting: ${id}`
                )

                return
            }

            sessions.delete(id)

            console.log(
                `[WA] Reconnecting: ${id}`
            )

            setTimeout(() => {
                createSession(
                    id,
                    phone
                ).catch(err => {
                    console.error(
                        `[WA] Reconnect failed: ${id}`,
                        err.message
                    )
                })
            }, 5000)
        }
    )

    /*
     * Incoming messages
     */

    sock.ev.on(
        "messages.upsert",
        async event => {
            for (const message of event.messages) {
                try {
                    await require("./bot").handleMessage(
                        session,
                        message
                    )
                } catch (err) {
                    console.error(
                        "[MSG] Processing failed:",
                        err.message
                    )
                }
            }
        }
    )

    return session
}

async function pair(id, phone) {
    phone = String(phone)
        .replace(/\D/g, "")

    if (!phone) {
        throw new Error(
            "Invalid phone number"
        )
    }

    const session =
        await createSession(
            id,
            phone
        )

    const registered =
        session.sock.authState?.creds?.registered

    if (registered) {
        return {
            registered: true,
            code: null
        }
    }

    if (
        session.sock.ws?.readyState !== 1
    ) {
        await new Promise(resolve =>
            setTimeout(resolve, 3000)
        )
    }

    const code =
        await session.sock.requestPairingCode(
            phone
        )

    console.log(
        `[PAIR] Code generated for ${id}`
    )

    return {
        registered: false,
        code
    }
}

async function logout(id) {
    const session =
        sessions.get(id)

    if (!session) {
        return false
    }

    try {
        await session.sock.logout()
    } catch (err) {
        console.error(
            "[AUTH] Logout failed:",
            err.message
        )
    }

    sessions.delete(id)

    await saveStatus(
        id,
        session.phone,
        "logged_out"
    )

    console.log(
        `[AUTH] Logged out: ${id}`
    )

    return true
}

async function restoreSessions() {
    try {
        const rows = await all(`
            SELECT id, phone
            FROM sessions
            WHERE status != 'logged_out'
        `)

        console.log(
            `[AUTH] Restoring ${rows.length} session(s)`
        )

        for (const row of rows) {
            const folder =
                path.join(
                    SESSION_DIR,
                    row.id
                )

            if (!fs.existsSync(folder)) {
                continue
            }

            createSession(
                row.id,
                row.phone
            ).catch(err => {
                console.error(
                    `[AUTH] Restore failed: ${row.id}`,
                    err.message
                )
            })
        }
    } catch (err) {
        console.error(
            "[AUTH] Restore failed:",
            err.message
        )
    }
}

function getSession(id) {
    return sessions.get(id)
}

function getSessions() {
    return [
        ...sessions.values()
    ].map(session => ({
        id: session.id,
        phone: session.phone,
        status: session.status
    }))
}

function getContact(id, jid) {
    const session =
        sessions.get(id)

    if (!session) {
        return null
    }

    return (
        session.contacts.get(jid) ||
        null
    )
}

function isSavedContact(id, jid) {
    const contact =
        getContact(id, jid)

    if (!contact) {
        return false
    }

    return !!(
        contact.name ||
        contact.notify ||
        contact.verifiedName
    )
}

function getContacts(id) {
    const session =
        sessions.get(id)

    if (!session) {
        return []
    }

    return [
        ...session.contacts.values()
    ]
}

module.exports = {
    createSession,
    pair,
    logout,
    restoreSessions,
    getSession,
    getSessions,
    getContact,
    getContacts,
    isSavedContact
}