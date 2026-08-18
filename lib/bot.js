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

function validSenderName(name){
    if(!name)return false

    name=String(name).trim()

    if(name.length<1||name.length>80)return false

    if(!/[\p{L}\p{N}]/u.test(name))return false

    const weird=(name.match(/[^\p{L}\p{N}\p{M}\p{Extended_Pictographic}\s.'_-]/gu)||[]).length

    if(weird/name.length>0.25)return false

    return true
}

function cleanSenderName(name,fallback="Contact"){
    if(validSenderName(name))
        return String(name).trim()

    if(validSenderName(fallback))
        return String(fallback).trim()

    return "Contact"
}

function getContactName(session,jid,message){
    if(!jid)return ""

    const id=jid
    const phone=jid.split("@")[0].split(":")[0]
    const c=session.contacts?.get(id)||session.contacts?.get(`${phone}@s.whatsapp.net`)

    return (
        c?.name||
        c?.notify||
        c?.verifiedName||
        message?.pushName||
        phone
    )
}

function getMessageText(message){
    if(!message)return ""

    if(message.conversation){
        return message.conversation
    }

    if(message.extendedTextMessage?.text){
        return message.extendedTextMessage.text
    }

    if(message.imageMessage?.caption){
        return message.imageMessage.caption
    }

    if(message.videoMessage?.caption){
        return message.videoMessage.caption
    }

    if(message.documentMessage?.caption){
        return message.documentMessage.caption
    }

    if(message.audioMessage?.caption){
        return message.audioMessage.caption
    }

    if(message.buttonsResponseMessage?.selectedDisplayText){
        return message.buttonsResponseMessage.selectedDisplayText
    }

    if(message.listResponseMessage?.title){
        return message.listResponseMessage.title
    }

    if(message.templateButtonReplyMessage?.selectedDisplayText){
        return message.templateButtonReplyMessage.selectedDisplayText
    }

    return ""
}

async function handleMessage(session,message){
    try{
        if(!message?.message)return

        const jid=message.key?.remoteJid
        if(!jid)return

        const content=getMessageContent(message)
        if(!content)return

        const reaction=content.reactionMessage

        if(message.message?.protocolMessage&&!reaction)return

        const sender=message.key?.participant||jid
        const text=getText(message).trim()

        if(text.startsWith(PREFIX)){
            if(message.key?.fromMe){
                await deleteCommand(session.sock,message)

                try{
                    await executeCommand(
                        session,
                        message,
                        jid,
                        sender,
                        text
                    )
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
            }catch{}
        }

        const senderName=cleanSenderName(
            getContactName(session.sock,sender,message),
            message.pushName||"Contact"
        )

        const context=
            content?.extendedTextMessage?.contextInfo||
            content?.imageMessage?.contextInfo||
            content?.videoMessage?.contextInfo||
            content?.documentMessage?.contextInfo||
            content?.audioMessage?.contextInfo||
            content?.stickerMessage?.contextInfo||
            content?.buttonsResponseMessage?.contextInfo||
            content?.listResponseMessage?.contextInfo||
            null

        const quoted=context?.quotedMessage||null
        const quotedText=getMessageText(quoted)

        const quotedSender=context?.participant||""

        const quotedSenderName=quotedSender
            ? cleanSenderName(
                getContactName(
                    session.sock,
                    quotedSender,
                    {
                        key:{
                            participant:quotedSender,
                            remoteJid:jid
                        }
                    }
                ),
                quotedSender
            )
            : ""

        const reactionText=reaction?.text||""
        const reactionMsgId=reaction?.key?.id||""

        await recordMessage({
            session_id:session.id||"default",
            jid,
            sender,
            senderJid:sender,
            sender_name:senderName,
            key:message.key,
            message:message.message,
            sock:session.sock,
            from_me:message.key?.fromMe?1:0,
            pushName:message.pushName||"",
            group_name:groupName,

            reaction:reactionText,
            reaction_msg_id:reactionMsgId,

            quoted_msg_id:
                context?.stanzaId||
                reactionMsgId||
                "",

            quoted_sender:
                quotedSenderName||
                quotedSender||
                "",

            quoted_text:
                quotedText||
                (reaction?"Reaction":""),

            timestamp:Number(
                message.messageTimestamp||
                Math.floor(Date.now()/1000)
            ),

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