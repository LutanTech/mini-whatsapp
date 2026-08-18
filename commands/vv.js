const {
    downloadMediaMessage
} = require("@whiskeysockets/baileys")

function getQuotedMedia(msg) {

    const content = msg?.message

    if (!content)
        return null

    const context =
        content.extendedTextMessage?.contextInfo ||
        content.imageMessage?.contextInfo ||
        content.videoMessage?.contextInfo ||
        content.audioMessage?.contextInfo ||
        content.documentMessage?.contextInfo

    const quoted = context?.quotedMessage

    if (!quoted)
        return null

    if (quoted.imageMessage)
        return {
            type: "image",
            message: quoted.imageMessage
        }

    if (quoted.videoMessage)
        return {
            type: "video",
            message: quoted.videoMessage
        }

    if (quoted.audioMessage)
        return {
            type: "audio",
            message: quoted.audioMessage
        }

    if (quoted.documentMessage)
        return {
            type: "document",
            message: quoted.documentMessage
        }

    return null
}

function getOwnerJid(sock) {

    const id = sock?.user?.id

    if (!id)
        throw new Error("Unable to determine bot number")

    return id.split(":")[0] + "@s.whatsapp.net"
}

async function execute({
    sock,
    message,
    jid
}) {

    if (!sock)
        throw new Error("Baileys socket is unavailable")

    const media = getQuotedMedia(message)

    if (!media) {

        await sock.sendMessage(
            jid,
            {
                text:
                    "❌ Reply to an ordinary photo, video, audio, or document with *.vv*"
            },
            {
                quoted: message
            }
        )

        return
    }

    try {

        const ownerJid = getOwnerJid(sock)

        console.log(
            `[VV] Downloading ${media.type}`
        )

        const buffer = await downloadMediaMessage(
            {
                message: {
                    [`${media.type}Message`]: media.message
                }
            },
            "buffer",
            {},
            {
                logger: console,
                reuploadRequest: sock.updateMediaMessage
            }
        )

        if (!buffer)
            throw new Error("Media download returned empty data")

        if (media.type === "image") {

            await sock.sendMessage(
                ownerJid,
                {
                    image: buffer,
                    caption:
                        media.message.caption ||
                        "✅ Image"
                }
            )

        } else if (media.type === "video") {

            await sock.sendMessage(
                ownerJid,
                {
                    video: buffer,
                    caption:
                        media.message.caption ||
                        "✅ Video"
                }
            )

        } else if (media.type === "audio") {

            await sock.sendMessage(
                ownerJid,
                {
                    audio: buffer,
                    mimetype:
                        media.message.mimetype ||
                        "audio/mp4",
                    ptt:
                        media.message.ptt || false
                }
            )

        } else if (media.type === "document") {

            await sock.sendMessage(
                ownerJid,
                {
                    document: buffer,
                    mimetype:
                        media.message.mimetype ||
                        "application/octet-stream",
                    fileName:
                        media.message.fileName ||
                        "file"
                }
            )
        }

        console.log(
            `[VV] ${media.type} sent to owner`
        )

    } catch (error) {

        console.error(
            "[VV] Error:",
            error
        )

        await sock.sendMessage(
            jid,
            {
                text:
                    `❌ Failed: ${error.message}`
            },
            {
                quoted: message
            }
        ).catch(() => {})
    }
}

module.exports = {
    name: "vv",
    execute
}