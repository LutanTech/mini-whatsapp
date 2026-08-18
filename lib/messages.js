const fs=require("fs")
const path=require("path")
const {all,run}=require("./database")
const {downloadMediaMessage}=require("@whiskeysockets/baileys")

const MEDIA_DIR=path.join(process.cwd(),"public","media")
if(!fs.existsSync(MEDIA_DIR))fs.mkdirSync(MEDIA_DIR,{recursive:true})

const clean=v=>v==null?"":String(v).trim()

function conversationKey(session,sender,receiver){
    session=clean(session);sender=clean(sender);receiver=clean(receiver)
    if(!session||!sender||!receiver)return null
    return `${session}:${[sender,receiver].sort().join(":")}`
}

function groupConversationKey(session,jid){
    session=clean(session);jid=clean(jid)
    return session&&jid?`${session}:group:${jid}`:null
}

function statusConversationKey(session,jid="status@broadcast"){
    session=clean(session);jid=clean(jid)||"status@broadcast"
    return session?`${session}:status:${jid}`:null
}

let messageEmitter=null

function setMessageEmitter(fn){
    messageEmitter=typeof fn==="function"?fn:null
}

function getMediaInfo(m){
    if(m?.imageMessage)return{type:"image",data:m.imageMessage}
    if(m?.videoMessage)return{type:"video",data:m.videoMessage}
    if(m?.documentMessage)return{type:"document",data:m.documentMessage}
    if(m?.audioMessage)return{type:"audio",data:m.audioMessage}
    if(m?.stickerMessage)return{type:"sticker",data:m.stickerMessage}
    return null
}

function extractText(data){
    if(data.text)return data.text
    if(data.body)return data.body

    const m=data.message
    if(!m)return ""

    return m.conversation||
        m.extendedTextMessage?.text||
        (m.imageMessage?(m.imageMessage.caption?`📷 ${m.imageMessage.caption}`:"[Image]"):
        m.videoMessage?(m.videoMessage.caption?`🎥 ${m.videoMessage.caption}`:"[Video]"):
        m.documentMessage?(m.documentMessage.caption?`📄 ${m.documentMessage.caption}`:`📄 ${m.documentMessage.fileName||"[Document]"}`):
        m.audioMessage?"[Audio Note]":
        m.stickerMessage?"[Sticker]":"")
}
async function recordMessage(data){
    const session=clean(data.session_id||data.sessionId||data.session)||"default"
    const key=data.key||{}
    const message=data.message

    if(!message||message.protocolMessage)return null

    const fromMe=data.from_me!==undefined?(data.from_me?1:0):(key.fromMe?1:0)

    const jid=clean(
        data.jid||
        data.chatJid||
        key.remoteJid||
        key.remoteJidAlt
    )

    if(!jid)return null

    const pushName=clean(
        data.pushName||
        data.push_name||
        data.verifiedBizName||
        data.verifiedName
    )

    const senderName=clean(
        data.sender_name||
        data.senderName||
        pushName
    )

    let sender=""
    let receiver=""
    let cKey=null
    let groupName=clean(data.group_name||data.groupName)

    if(jid==="status@broadcast"){
        sender=clean(
            data.sender||
            data.senderJid||
            key.participant
        )||"status@broadcast"

        receiver=jid
        cKey=statusConversationKey(session,jid)
    }else if(jid.endsWith("@g.us")){
        sender=clean(
            data.sender||
            data.senderJid||
            key.participant
        )||(fromMe?session:jid)

        receiver=jid
        cKey=groupConversationKey(session,jid)

        if(!groupName&&data.sock){
            try{
                const meta=await data.sock.groupMetadata(jid)
                groupName=clean(meta?.subject)
            }catch{}
        }
    }else{
        sender=fromMe
            ?session
            :clean(
                data.sender||
                data.senderJid||
                key.participant
            )||jid

        receiver=fromMe?jid:session
        cKey=conversationKey(session,sender,receiver)
    }

    if(!cKey)return null

    const context=
        message.extendedTextMessage?.contextInfo||
        message.imageMessage?.contextInfo||
        message.videoMessage?.contextInfo||
        message.documentMessage?.contextInfo||
        message.audioMessage?.contextInfo||
        null

    const quoted=context?.quotedMessage||null

    const quotedMsgId=clean(context?.stanzaId)
    const quotedSender=clean(context?.participant)

    const reaction = data.reaction
    const reaction_msg_id = data.reaction_msg_id

    const quotedText=clean(
        quoted?.conversation||
        quoted?.extendedTextMessage?.text||
        quoted?.imageMessage?.caption||
        quoted?.videoMessage?.caption||
        quoted?.documentMessage?.caption||
        ""
    )

    const text=extractText(data)

    const createdAt=Number(
        data.created_at||
        data.timestamp||
        data.messageTimestamp||
        Math.floor(Date.now()/1000)
    )

    const msgId=clean(
        data.msg_id||
        data.message_id||
        key.id
    )

    if(msgId){
        const existing=await all(
            `SELECT * FROM messages WHERE session_id=? AND msg_id=? LIMIT 1`,
            [session,msgId]
        )

        if(existing.length)return existing[0]
    }

    let mediaType=""
    let mediaPath=""
    let mimeType=""
    let fileName=""

    const media=getMediaInfo(message)

    if(media&&data.sock){
        try{
            mediaType=media.type
            mimeType=clean(media.data.mimetype)
            fileName=clean(media.data.fileName)

            let ext="bin"

            if(mediaType==="image")ext="jpg"
            else if(mediaType==="video")ext="mp4"
            else if(mediaType==="audio")ext="ogg"
            else if(mediaType==="sticker")ext="webp"
            else if(fileName.includes("."))ext=fileName.split(".").pop()
            else if(mimeType.includes("/"))ext=mimeType.split("/")[1].split(";")[0]

            ext=ext.replace(/[^a-zA-Z0-9]/g,"")||"bin"

            const safeId=(msgId||Date.now().toString()).replace(/[^\w.-]/g,"_")
            const filename=`${session}_${safeId}.${ext}`
            const fullPath=path.join(MEDIA_DIR,filename)

            const buffer=await downloadMediaMessage(
                {message,key},
                "buffer",
                {},
                {
                    logger:{
                        debug(){},
                        info(){},
                        error(){},
                        warn(){}
                    }
                }
            )

            fs.writeFileSync(fullPath,buffer)
            mediaPath=`/media/${filename}`
        }catch(e){
            console.error("[MEDIA]",e.message)
        }
    }

    const result=await run(`
        INSERT INTO messages
        (
            session_id,
            jid,
            sender,
            receiver,
            conversation_key,
            text,
            created_at,
            msg_id,
            from_me,
            push_name,
            sender_name,
            group_name,
            media_type,
            media_path,
            mime_type,
            file_name,
            quoted_msg_id,
            quoted_sender,
            quoted_text,
            reaction,
            reaction_msg_id
        )
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `,[
        session,
        jid,
        sender,
        receiver,
        cKey,
        text,
        createdAt,
        msgId,
        fromMe,
        pushName,
        senderName,
        groupName,
        mediaType,
        mediaPath,
        mimeType,
        fileName,
        quotedMsgId,
        quotedSender,
        quotedText,
        reaction,
        reaction_msg_id
    ])

    const saved={
        id:result.id,
        session_id:session,
        jid,
        sender,
        sender_name:senderName,
        receiver,
        conversation_key:cKey,
        text,
        created_at:createdAt,
        msg_id:msgId,
        from_me:fromMe,
        push_name:pushName,
        group_name:groupName,
        media_type:mediaType,
        media_path:mediaPath,
        mime_type:mimeType,
        file_name:fileName,
        quoted_msg_id:quotedMsgId,
        quoted_sender:quotedSender,
        quoted_text:quotedText,
        reaction:reaction,
        reaction_msg_id:reaction_msg_id
    }

    if(messageEmitter){
        try{
            messageEmitter(saved)
        }catch(e){
            console.error("[EMIT]",e.message)
        }
    }

    return saved
}
module.exports={
    recordMessage,
    conversationKey,
    groupConversationKey,
    statusConversationKey,
    extractText,
    setMessageEmitter
}