const {getCommand}=require("./commands")
const {recordMessage}=require("./messages")

const PREFIX=process.env.PREFIX||"."

function getMessageContent(message){
    let c=message?.message
    if(!c)return null

    while(c){
        if(c.ephemeralMessage?.message)c=c.ephemeralMessage.message
        else if(c.viewOnceMessage?.message)c=c.viewOnceMessage.message
        else if(c.viewOnceMessageV2?.message)c=c.viewOnceMessageV2.message
        else if(c.viewOnceMessageV2Extension?.message)c=c.viewOnceMessageV2Extension.message
        else break
    }

    return c
}

function getText(message){
    const c=getMessageContent(message)
    if(!c)return ""

    return c.conversation||
        c.extendedTextMessage?.text||
        c.imageMessage?.caption||
        c.videoMessage?.caption||
        c.documentMessage?.caption||
        c.buttonsResponseMessage?.selectedButtonId||
        c.templateButtonReplyMessage?.selectedId||
        c.listResponseMessage?.singleSelectReply?.selectedRowId||
        ""
}

function getContactName(sock,jid,message){
    if(!jid)return ""

    const c=sock?.store?.contacts?.[jid]

    return c?.name||
        c?.verifiedName||
        c?.notify||
        message?.pushName||
        jid.split("@")[0].split(":")[0]
}

async function deleteCommand(sock,message){
    if(!sock?.sendMessage||!message?.key)return

    try{
        await sock.sendMessage(message.key.remoteJid,{delete:message.key})
    }catch(e){
        console.error("[CMD] Delete failed:",e.message)
    }
}

async function executeCommand(session,message,jid,sender,text){
    const body=text.slice(PREFIX.length).trim()
    if(!body)return false

    const parts=body.split(/\s+/)
    const name=parts.shift().toLowerCase()
    const command=getCommand?getCommand(name):null

    if(!command)return false

    await command.execute({
        sock:session.sock,
        session,
        message,
        jid,
        sender,
        text,
        args:parts,
        isGroup:jid.endsWith("@g.us"),
        command:name
    })

    return true
}

async function handleMessage(session,message){
    try{
        if(!message?.message)return

        const jid=message.key?.remoteJid
        if(!jid)return

        if(message.message?.protocolMessage)return

        const sender=message.key?.participant||jid
        const text=getText(message).trim()

        if(text.startsWith(PREFIX)){
            if(message.key?.fromMe){
                await deleteCommand(session.sock,message)

                try{
                    await executeCommand(session,message,jid,sender,text)
                }catch(e){
                    console.error("[CMD] Execution error:",e.message)
                }
            }

            return
        }

        let groupName=""

        if(jid.endsWith("@g.us")){
            try{
                const metadata=await session.sock.groupMetadata(jid)
                groupName=metadata?.subject||""
            }catch(e){}
        }

        await recordMessage({
            session_id:session.id||"default",
            jid,
            sender,
            senderJid:sender,
            key:message.key,
            message:message.message,
            sock:session.sock,
            from_me:message.key?.fromMe?1:0,
            pushName:message.pushName||"",
            group_name:groupName,
            timestamp:Number(message.messageTimestamp||Math.floor(Date.now()/1000)),
            msg_id:message.key?.id||""
        })
    }catch(e){
        console.error("[BOT] Message error:",e.message)
    }
}

module.exports={
    handleMessage,
    getText,
    getMessageContent,
    getContactName
}