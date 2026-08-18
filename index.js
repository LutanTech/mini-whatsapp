require("dotenv").config()

const express=require("express")
const http=require("http")
const {Server}=require("socket.io")
const {pair,logout,restoreSessions,getSessions}=require("./lib/sessions")
const {all,run}=require("./lib/database")
const { recordMessage, conversationKey, setMessageEmitter } = require("./lib/messages")
const app=express()
const server=http.createServer(app)
const io=new Server(server)
const path = require("path")

app.use(express.json({limit:"1mb"}))
app.use(express.static("public"))

async function migrateDatabaseSchema(){
    for(const sql of [
        "ALTER TABLE messages ADD COLUMN msg_id TEXT",
        "ALTER TABLE messages ADD COLUMN from_me INTEGER DEFAULT 0",
        "ALTER TABLE messages ADD COLUMN push_name TEXT",
        "ALTER TABLE messages ADD COLUMN receiver TEXT",
        "ALTER TABLE messages ADD COLUMN conversation_key TEXT",
        "ALTER TABLE messages ADD COLUMN media_type TEXT",
        "ALTER TABLE messages ADD COLUMN media_path TEXT",
        "ALTER TABLE messages ADD COLUMN mime_type TEXT",
        "ALTER TABLE messages ADD COLUMN file_name TEXT",
        "ALTER TABLE messages ADD COLUMN group_name TEXT",
        "ALTER TABLE messages ADD COLUMN sender_name TEXT",
        "ALTER TABLE messages ADD COLUMN quoted_msg_id TEXT",
        "ALTER TABLE messages ADD COLUMN quoted_text TEXT",
        "ALTER TABLE messages ADD COLUMN quoted_sender TEXT",
        "ALTER TABLE messages ADD COLUMN reaction TEXT",
        "ALTER TABLE messages ADD COLUMN reaction_msg_id TEXT"
    ]){
        try{await run(sql)}catch{}
    }

    try{
        const rows=await all(`
            SELECT id,session_id,sender,receiver,jid,from_me
            FROM messages
            WHERE conversation_key IS NULL OR conversation_key=''
        `)

        let updated=0

        for(const row of rows){
            const session=String(row.session_id||"").trim()
            const jid=String(row.jid||"").trim()

            if(!session||!jid)continue

            let sender=String(row.sender||"").trim()
            let receiver=String(row.receiver||"").trim()

            if(!sender)sender=row.from_me?session:jid
            if(!receiver)receiver=row.from_me?jid:session

            let key

            if(jid==="status@broadcast"){
                key=`${session}:status:${jid}`
            }else if(jid.endsWith("@g.us")){
                key=`${session}:group:${jid}`
            }else{
                key=`${session}:${[sender,receiver].sort().join(":")}`
            }

            await run(`
                UPDATE messages
                SET sender=?,receiver=?,conversation_key=?
                WHERE id=?
            `,[sender,receiver,key,row.id])

            updated++
        }

        console.log(`[DB] Rebuilt ${updated} conversation keys`)
    }catch(err){
        console.error("[DB] Migration:",err.message)
    }
}

setMessageEmitter(message => io.emit("message",message))

app.get("/api/health",(req,res)=>{
    res.json({
        status:"ok",
        uptime:process.uptime(),
        sessions:getSessions()
    })
})

app.get("/admin", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "admin.html"))
})

app.get("/api/sessions",(req,res)=>{
    res.json(getSessions())
})

app.get("/api/messages",async(req,res)=>{
    try{
        const rows=await all(`
            SELECT *
            FROM messages
            ORDER BY id DESC
            LIMIT 100
        `)

        res.json({messages:rows})
    }catch(err){
        res.status(500).json({error:err.message})
    }
})

app.get("/api/conversations",async(req,res)=>{
    try{
        const rows=await all(`
            SELECT
                m.conversation_key,
                m.session_id,
                m.jid,
                m.sender_name,
                m.receiver,
                m.push_name,
                m.group_name,
                m.created_at AS last_time,
               m.text,
            m.reaction,
            COALESCE(NULLIF(m.text, ''), 'reacted ' || m.reaction, '') AS last_message
            FROM messages m
            INNER JOIN(
                SELECT conversation_key,MAX(id) AS last_id
                FROM messages
                WHERE conversation_key IS NOT NULL
                AND conversation_key!=''
                GROUP BY conversation_key
            ) x ON m.id=x.last_id
            ORDER BY m.created_at DESC
        `)

        res.json({conversations:rows})
    }catch(err){
        res.status(500).json({error:err.message})
    }
})

app.get("/api/conversations/:key",async(req,res)=>{
    try{
        const key=decodeURIComponent(req.params.key)

        const rows=await all(`
            SELECT *
            FROM messages
            WHERE conversation_key=?
            ORDER BY created_at ASC,id ASC
        `,[key])

        res.json({
            conversation_key:key,
            messages:rows
        })
    }catch(err){
        console.error("[API] Conversation:",err.message)
        res.status(500).json({error:err.message})
    }
})

app.post("/api/pair",async(req,res)=>{
    try{
        const phone=String(req.body.phone||"").replace(/\D/g,"")

        if(!phone)
            return res.status(400).json({error:"Phone number required"})

        if(phone.length<8)
            return res.status(400).json({error:"Invalid phone number"})

        res.json(await pair(phone,phone))
    }catch(err){
        console.error("[PAIR]",err.message)
        res.status(500).json({error:err.message})
    }
})

app.post("/api/logout/:id",async(req,res)=>{
    try{
        res.json({success:await logout(req.params.id)})
    }catch(err){
        res.status(500).json({error:err.message})
    }
})

app.post("/api/admin/login",(req,res)=>{
    const {email,password}=req.body||{}

    if(
        email===process.env.ADMIN_EMAIL&&
        password===process.env.ADMIN_PASS
    ){
        return res.json({success:true})
    }

    res.status(401).json({error:"Invalid email or password"})
})

io.on("connection",async socket=>{
    socket.emit("sessions",getSessions())

    try{
        const rows=await all(`
            SELECT *
            FROM messages
            ORDER BY id DESC
            LIMIT 100
        `)

        socket.emit("messages",rows)
    }catch{}

    
})

setInterval(()=>{
    io.emit("sessions",getSessions())
},3000)

const PORT=process.env.PORT||3000

server.listen(PORT,async()=>{
    await migrateDatabaseSchema()
    await restoreSessions()
    console.log(`Server running on ${PORT}`)
})

module.exports={app,server}