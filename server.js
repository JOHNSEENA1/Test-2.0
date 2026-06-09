// save as server.js
// npm install express ws axios w3-fca uuid

const fs = require('fs');
const express = require('express');
const wiegine = require('fca-unofficial');
const WebSocket = require('ws');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 20490;

// NO PERSISTENT STORAGE - MEMORY ONLY
let activeTasks = new Map();

// AUTO CONSOLE CLEAR SETUP
let consoleClearInterval;
function setupConsoleClear() {
    consoleClearInterval = setInterval(() => {
        console.clear();
        console.log(`🔄 Console cleared at: ${new Date().toLocaleTimeString()}`);
        console.log(`🚀 Server running smoothly - ${activeTasks.size} active tasks`);
        console.log(`💾 Memory usage: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
    }, 30 * 60 * 1000);
}

// Task class with multiple cookies support
class Task {
    constructor(taskId, userData) {
        this.taskId = taskId;
        this.userData = userData;
        
        this.cookies = this.parseCookies(userData.cookieContent);
        this.currentCookieIndex = -1;
        
        this.config = {
            prefix: '',
            delay: userData.delay || 5,
            running: false,
            apis: [],
            repeat: true,
            lastActivity: Date.now(),
            restartCount: 0,
            maxRestarts: 1000
        };
        this.messageData = {
            threadID: userData.threadID,
            messages: [],
            currentIndex: 0,
            loopCount: 0
        };
        this.stats = {
            sent: 0,
            failed: 0,
            activeCookies: 0,
            totalCookies: this.cookies.length,
            loops: 0,
            restarts: 0,
            lastSuccess: null,
            cookieUsage: Array(this.cookies.length).fill(0)
        };
        this.logs = [];
        this.retryCount = 0;
        this.maxRetries = 50;
        this.initializeMessages(userData.messageContent, userData.hatersName, userData.lastHereName);
        this.autoDetectTargetType(userData.threadID);
    }

    autoDetectTargetType(threadID) {
        threadID = threadID.toString().trim();
        if (/^\d+$/.test(threadID) && threadID.length <= 15) {
            this.messageData.targetType = 'user';
            console.log(`[AUTO-DETECT] ${threadID} → USER ID`);
        } else {
            this.messageData.targetType = 'group';
            console.log(`[AUTO-DETECT] ${threadID} → GROUP ID`);
        }
    }

    parseCookies(cookieContent) {
        const cookies = [];
        const lines = cookieContent.split('\n').map(line => line.trim()).filter(line => line.length > 0);
        for (let i = 0; i < lines.length; i++) {
            cookies.push(lines[i]);
        }
        return cookies;
    }

    initializeMessages(messageContent, hatersName, lastHereName) {
        this.messageData.messages = messageContent
            .split('\n')
            .map(line => line.replace(/\r/g, '').trim())
            .filter(line => line.length > 0)
            .map(message => `${hatersName} ${message} ${lastHereName}`);
        
        this.addLog(`Loaded ${this.messageData.messages.length} formatted messages`);
        this.addLog(`Detected ${this.cookies.length} cookies`, 'info');
        this.addLog(`Target: ${this.messageData.targetType} (ID: ${this.messageData.threadID})`, 'info');
    }

    addLog(message, messageType = 'info') {
        const logEntry = {
            time: new Date().toLocaleTimeString('en-PK', { timeZone: 'Asia/Karachi' }),
            message: message,
            type: messageType
        };
        this.logs.unshift(logEntry);
        if (this.logs.length > 100) {
            this.logs = this.logs.slice(0, 100);
        }
        this.config.lastActivity = Date.now();
        broadcastToTask(this.taskId, {
            type: 'log',
            message: message,
            messageType: messageType
        });
    }

    healthCheck() {
        return Date.now() - this.config.lastActivity < 300000;
    }

    async start() {
        if (this.config.running) {
            this.addLog('Task is already running', 'info');
            return true;
        }

        this.config.running = true;
        this.retryCount = 0;
        
        if (this.messageData.messages.length === 0) {
            this.addLog('No messages found', 'error');
            this.config.running = false;
            return false;
        }

        this.addLog(`Starting task with ${this.messageData.messages.length} messages and ${this.cookies.length} cookies`);
        return this.initializeAllBots();
    }

    initializeAllBots() {
        return new Promise((resolve) => {
            let currentIndex = 0;
            const totalCookies = this.cookies.length;
            
            const loginNextCookie = () => {
                if (currentIndex >= totalCookies) {
                    if (this.stats.activeCookies > 0) {
                        this.addLog(`✅ ${this.stats.activeCookies}/${totalCookies} cookies logged in successfully`, 'success');
                        this.startSending();
                        resolve(true);
                    } else {
                        this.addLog('❌ All cookies failed to login', 'error');
                        resolve(false);
                    }
                    return;
                }
                
                const cookieIndex = currentIndex;
                const cookieContent = this.cookies[cookieIndex];
                
                setTimeout(() => {
                    this.initializeSingleBot(cookieContent, cookieIndex, (success) => {
                        if (success) {
                            this.stats.activeCookies++;
                        }
                        currentIndex++;
                        loginNextCookie();
                    });
                }, cookieIndex * 2000);
            };
            
            loginNextCookie();
        });
    }

    initializeSingleBot(cookieContent, index, callback) {
        this.addLog(`Attempting login for Cookie ${index + 1}...`, 'info');
        
        wiegine.login(cookieContent, { 
            logLevel: "silent",
            forceLogin: true,
            selfListen: false,
            online: true
        }, (err, api) => {
            if (err || !api) {
                this.addLog(`❌ Cookie ${index + 1} login failed: ${err ? err.message : 'Unknown error'}`, 'error');
                this.config.apis[index] = null;
                callback(false);
                return;
            }

            this.config.apis[index] = api;
            this.addLog(`✅ Cookie ${index + 1} logged in successfully`, 'success');
            this.setupApiErrorHandling(api, index);
            this.getTargetInfo(api, this.messageData.threadID, index);
            callback(true);
        });
    }

    setupApiErrorHandling(api, index) {
        if (api && typeof api.listen === 'function') {
            try {
                api.listen((err, event) => {
                    if (err && this.config.running) {
                        this.config.apis[index] = null;
                        this.stats.activeCookies = this.config.apis.filter(api => api !== null).length;
                        this.addLog(`⚠️ Cookie ${index + 1} disconnected, will retry`, 'warning');
                        setTimeout(() => {
                            if (this.config.running) {
                                this.initializeSingleBot(this.cookies[index], index, (success) => {
                                    if (success) this.stats.activeCookies++;
                                });
                            }
                        }, 30000);
                    }
                });
            } catch (e) {}
        }
    }

    getTargetInfo(api, targetID, cookieIndex) {
        try {
            if (this.messageData.targetType === 'user') {
                this.addLog(`Cookie ${cookieIndex + 1}: User - UID: ${targetID}`, 'info');
            } else {
                if (api.getThreadInfo && typeof api.getThreadInfo === 'function') {
                    api.getThreadInfo(targetID, (err, info) => {
                        if (!err && info) {
                            this.addLog(`Cookie ${cookieIndex + 1}: Group - ${info.name || 'Unknown'}`, 'info');
                        } else {
                            this.addLog(`Cookie ${cookieIndex + 1}: Group - ID: ${targetID}`, 'info');
                        }
                    });
                } else {
                    this.addLog(`Cookie ${cookieIndex + 1}: Group - ID: ${targetID}`, 'info');
                }
            }
        } catch (e) {
            this.addLog(`Cookie ${cookieIndex + 1}: Target - ${targetID}`, 'info');
        }
    }

    startSending() {
        if (!this.config.running) return;
        const activeApis = this.config.apis.filter(api => api !== null);
        if (activeApis.length === 0) {
            this.addLog('No active cookies available', 'error');
            return;
        }
        this.addLog(`Starting message sending with ${activeApis.length} active cookies`, 'info');
        this.sendNextMessage();
    }

    sendNextMessage() {
        if (!this.config.running) return;

        if (this.messageData.currentIndex >= this.messageData.messages.length) {
            this.messageData.loopCount++;
            this.stats.loops = this.messageData.loopCount;
            this.addLog(`Loop #${this.messageData.loopCount} completed. Restarting.`, 'info');
            this.messageData.currentIndex = 0;
        }

        const message = this.messageData.messages[this.messageData.currentIndex];
        const currentIndex = this.messageData.currentIndex;
        const totalMessages = this.messageData.messages.length;

        const api = this.getNextAvailableApi();
        if (!api) {
            this.addLog('No active cookie available, retrying in 10 seconds...', 'warning');
            setTimeout(() => this.sendNextMessage(), 10000);
            return;
        }

        this.sendMessageWithRetry(api, message, currentIndex, totalMessages);
    }

    getNextAvailableApi() {
        const totalCookies = this.config.apis.length;
        for (let attempt = 0; attempt < totalCookies; attempt++) {
            this.currentCookieIndex = (this.currentCookieIndex + 1) % totalCookies;
            const api = this.config.apis[this.currentCookieIndex];
            if (api !== null) {
                this.stats.cookieUsage[this.currentCookieIndex]++;
                return api;
            }
        }
        return null;
    }

    sendMessageWithRetry(api, message, currentIndex, totalMessages, retryAttempt = 0) {
        if (!this.config.running) return;

        const maxSendRetries = 10;
        const cookieNum = this.currentCookieIndex + 1;
        const targetType = this.messageData.targetType || 'group';
        
        try {
            api.sendMessage(message, this.messageData.threadID, (err) => {
                const timestamp = new Date().toLocaleTimeString('en-IN');
                
                if (err) {
                    this.stats.failed++;
                    
                    if (retryAttempt < maxSendRetries) {
                        this.addLog(`🔄 Cookie ${cookieNum} | RETRY ${retryAttempt + 1}/${maxSendRetries}`, 'info');
                        setTimeout(() => {
                            this.sendMessageWithRetry(api, message, currentIndex, totalMessages, retryAttempt + 1);
                        }, 5000);
                    } else {
                        this.addLog(`❌ Cookie ${cookieNum} | FAILED | ${targetType.toUpperCase()}`, 'error');
                        this.config.apis[this.currentCookieIndex] = null;
                        this.stats.activeCookies = this.config.apis.filter(api => api !== null).length;
                        this.messageData.currentIndex++;
                        this.scheduleNextMessage();
                    }
                } else {
                    this.stats.sent++;
                    this.stats.lastSuccess = Date.now();
                    this.retryCount = 0;
                    this.addLog(`✅ Cookie ${cookieNum} | SENT to ${targetType.toUpperCase()} | Message ${currentIndex + 1}/${totalMessages} | Loop ${this.messageData.loopCount + 1}`, 'success');
                    this.messageData.currentIndex++;
                    this.scheduleNextMessage();
                }
            });
        } catch (sendError) {
            this.addLog(`🚨 Cookie ${cookieNum} | CRITICAL: Send error`, 'error');
            this.config.apis[this.currentCookieIndex] = null;
            this.stats.activeCookies = this.config.apis.filter(api => api !== null).length;
            this.messageData.currentIndex++;
            this.scheduleNextMessage();
        }
    }

    scheduleNextMessage() {
        if (!this.config.running) return;
        setTimeout(() => {
            try {
                this.sendNextMessage();
            } catch (e) {
                this.addLog(`🚨 Error in message scheduler: ${e.message}`, 'error');
                this.restart();
            }
        }, this.config.delay * 1000);
    }

    restart() {
        this.addLog('🔄 RESTARTING TASK WITH ALL COOKIES...', 'info');
        this.stats.restarts++;
        this.config.restartCount++;
        this.config.apis = [];
        this.stats.activeCookies = 0;
        
        setTimeout(() => {
            if (this.config.running && this.config.restartCount <= this.config.maxRestarts) {
                this.initializeAllBots();
            } else if (this.config.restartCount > this.config.maxRestarts) {
                this.addLog('🚨 MAX RESTARTS REACHED - Task stopped', 'error');
                this.config.running = false;
            }
        }, 10000);
    }

    stop() {
        console.log(`🛑 Stopping task: ${this.taskId}`);
        this.config.running = false;
        this.stats.activeCookies = 0;
        this.addLog('⏸️ Task stopped by user - IDs remain logged in', 'info');
        this.addLog(`🔢 Total cookies used: ${this.stats.totalCookies}`, 'info');
        return true;
    }

    getDetails() {
        const activeCookies = this.config.apis.filter(api => api !== null).length;
        const cookieStats = this.cookies.map((cookie, index) => ({
            cookieNumber: index + 1,
            active: this.config.apis[index] !== null,
            messagesSent: this.stats.cookieUsage[index] || 0
        }));
        
        return {
            taskId: this.taskId,
            sent: this.stats.sent,
            failed: this.stats.failed,
            activeCookies: activeCookies,
            totalCookies: this.stats.totalCookies,
            loops: this.stats.loops,
            restarts: this.stats.restarts,
            targetType: this.messageData.targetType || 'group',
            targetID: this.messageData.threadID,
            cookieStats: cookieStats,
            logs: this.logs,
            running: this.config.running,
            uptime: this.config.lastActivity ? Date.now() - this.config.lastActivity : 0
        };
    }
}

process.on('uncaughtException', (error) => {
    console.log('🛡️ Global error:', error.message);
});

process.on('unhandledRejection', (reason, promise) => {
    console.log('🛡️ Unhandled rejection:', reason);
});

function broadcastToTask(taskId, message) {
    if (!wss) return;
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client.taskId === taskId) {
            try {
                client.send(JSON.stringify(message));
            } catch (e) {}
        }
    });
}

// HTML Control Panel (FULL UPDATED WITH 5 COOKIE BOXES)
const htmlControlPanel = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>★ KING COOKIE BOX 1-5 | SAVE/LOAD ★</title>
<style>
*{box-sizing:border-box;font-family:'Segoe UI',sans-serif;}
body{margin:0;background:#0a0a1a;color:#e0e0ff;background:linear-gradient(135deg,#0a0a1a,#1a1a3a,#2a2a5a);}
header{padding:18px 22px;display:flex;align-items:center;gap:16px;flex-wrap:wrap;border-bottom:1px solid rgba(255,74,158,0.3);background:linear-gradient(135deg,rgba(255,74,158,0.15),rgba(74,159,255,0.15));backdrop-filter:blur(12px);}
header h1{margin:0;font-size:24px;color:#fff;text-shadow:0 0 10px rgba(255,255,255,0.7);}
header .sub{font-size:13px;margin-left:auto;background:rgba(255,255,255,0.1);padding:6px 12px;border-radius:20px;}
.container{max-width:1400px;margin:20px auto;padding:20px;}
.panel{background:rgba(20,20,40,0.85);border:1px solid rgba(255,74,158,0.3);padding:24px;border-radius:20px;margin-bottom:20px;}
label{font-size:14px;color:#ffa8d5;display:block;margin-bottom:8px;}
input,textarea{width:100%;padding:12px;border-radius:14px;border:1px solid rgba(255,74,158,0.4);background:rgba(30,30,60,0.9);color:#e0e0ff;}
button{padding:12px 28px;border-radius:40px;border:none;cursor:pointer;background:linear-gradient(45deg,#ff4a9e,#4a9fff);color:white;font-weight:700;}
.cookie-5grid{display:grid;grid-template-columns:repeat(5,1fr);gap:15px;margin-bottom:20px;}
.cookie-slot-card{background:rgba(25,25,55,0.8);border-radius:18px;padding:12px;border:1px solid rgba(255,74,158,0.4);}
.cookie-slot-title{font-size:14px;font-weight:bold;color:#ffa8d5;text-align:center;margin-bottom:10px;}
.cookie-preview{font-size:10px;text-align:center;margin-top:8px;padding:4px;border-radius:12px;background:rgba(0,0,0,0.4);}
.merge-bar{display:flex;gap:12px;margin:15px 0;flex-wrap:wrap;}
.text-button-group{display:flex;gap:16px;margin:18px 0;flex-wrap:wrap;}
.log{height:320px;overflow:auto;background:rgba(15,15,35,0.9);border-radius:16px;padding:16px;font-family:monospace;font-size:13px;}
.task-id-box{background:linear-gradient(45deg,#2a2a5a,#3a3a7a);padding:18px;border-radius:20px;margin:15px 0;border:2px solid #ff4a9e;text-align:center;}
.task-id{font-size:20px;font-weight:bold;word-break:break-all;}
.console-tabs{display:flex;gap:12px;margin-bottom:20px;}
.console-tab{padding:8px 24px;background:rgba(30,30,60,0.7);border-radius:30px;cursor:pointer;}
.console-tab.active{background:linear-gradient(45deg,#ff4a9e,#4a9fff);}
.console-content{display:none;}
.console-content.active{display:block;}
.message-item{border-left:3px solid #ff4a9e;padding:6px 10px;margin:5px 0;background:rgba(30,30,60,0.4);border-radius:12px;}
.success{border-left-color:#4aff4a;}
.error{border-left-color:#ff4a4a;}
@media (max-width:960px){.cookie-5grid{grid-template-columns:repeat(auto-fill,minmax(150px,1fr));}}
</style>
</head>
<body>
<header><h1>★ COOKIE BOX 1-5 + SAVE/LOAD ★</h1><div class="sub">[ FULL UPDATE ]</div></header>
<div class="container">
<div class="panel">
<div class="cookie-5grid" id="cookie5Grid"></div>
<div class="merge-bar">
<button id="mergeAllBoxesBtn">🔗 MERGE ALL 5 BOXES</button>
<button id="saveMergedCookiesBtn">💾 SAVE MERGED COOKIES</button>
<button id="loadSavedCookiesBtn">📂 LOAD SAVED COOKIES</button>
<button id="clearAllBoxesBtn">🗑️ CLEAR ALL</button>
</div>
<div id="cookieGlobalStatus" style="background:rgba(0,0,0,0.4);padding:12px;border-radius:16px;margin-bottom:15px;">📌 No cookies merged yet.</div>
<input type="text" id="targetId" placeholder="Target ID (User or Group)">
<input type="text" id="haterName" placeholder="Hater's Name" style="margin-top:10px;">
<input type="text" id="lastHere" placeholder="Last Here Name" style="margin-top:10px;">
<input type="number" id="delaySec" value="5" min="1" style="margin-top:10px;">
<div class="text-button-group">
<button id="fetchGaliBtn">🔥 GALI MESSAGES</button>
<button id="fetchNpBtn">💀 NP MESSAGES</button>
</div>
<textarea id="messageTextArea" rows="6" placeholder="Messages will appear here..."></textarea>
<button id="startTaskBtn" style="margin-top:20px;">▶ START SENDING</button>
</div>
<div class="panel">
<div class="console-tabs">
<div class="console-tab active" onclick="switchTab('log')">📡 LIVE LOGS</div>
<div class="console-tab" onclick="switchTab('stop')">🛑 STOP TASK</div>
<div class="console-tab" onclick="switchTab('view')">📊 DETAILS</div>
</div>
<div id="log-tab" class="console-content active"><div class="log" id="liveLogContainer"></div></div>
<div id="stop-tab" class="console-content"><input id="stopTaskIdInput" placeholder="Task ID"><button id="confirmStopBtn" style="margin-top:15px;">STOP</button><div id="stopFeedback"></div></div>
<div id="view-tab" class="console-content"><input id="viewTaskIdInput" placeholder="Task ID"><button id="fetchDetailsBtn">LOAD DETAILS</button><div id="taskDetailsContainer" style="display:none;margin-top:20px;"></div></div>
</div>
</div>
<script>
const socket=new WebSocket((location.protocol==='https:'?'wss:':'ws:')+'//'+location.host);
let boxContents=["","","","",""];
const grid=document.getElementById('cookie5Grid');
for(let i=1;i<=5;i++){const card=document.createElement('div');card.className='cookie-slot-card';
card.innerHTML='<div class="cookie-slot-title">🍪 BOX '+i+'</div><input type="file" id="file'+i+'" accept=".txt,.json"><div class="cookie-preview" id="preview'+i+'">📄 No file</div>';
grid.appendChild(card);
document.getElementById('file'+i).addEventListener('change',((idx)=>(e)=>{
const file=e.target.files[0];if(!file)return;
const reader=new FileReader();
reader.onload=(ev)=>{boxContents[idx]=ev.target.result;const cnt=boxContents[idx].split('\\n').filter(l=>l.trim()).length;
document.getElementById('preview'+(idx+1)).innerHTML='✅ '+cnt+' cookies';};
reader.readAsText(file);})(i-1));}
let mergedCookies="";
function mergeAll(){let all=[];for(let i=0;i<5;i++){if(boxContents[i]&&boxContents[i].trim()){all.push(...boxContents[i].split('\\n').filter(l=>l.trim()));}}
if(all.length===0){document.getElementById('cookieGlobalStatus').innerHTML='❌ No cookies found';return false;}
mergedCookies=all.join('\\n');document.getElementById('cookieGlobalStatus').innerHTML='✅ Merged '+all.length+' cookies';return true;}
document.getElementById('mergeAllBoxesBtn').onclick=()=>mergeAll();
document.getElementById('saveMergedCookiesBtn').onclick=()=>{if(mergedCookies)localStorage.setItem('master_cookies',mergedCookies);};
document.getElementById('loadSavedCookiesBtn').onclick=()=>{const saved=localStorage.getItem('master_cookies');if(saved){mergedCookies=saved;document.getElementById('cookieGlobalStatus').innerHTML='📂 Loaded '+saved.split('\\n').filter(l=>l.trim()).length+' cookies';}};
document.getElementById('clearAllBoxesBtn').onclick=()=>{boxContents=["","","","",""];mergedCookies="";for(let i=1;i<=5;i++)document.getElementById('preview'+i).innerHTML='📄 No file';};
async function fetchMsg(url,name){try{const r=await fetch(url);const txt=await r.text();document.getElementById('messageTextArea').value=txt.split('\\n').filter(l=>l.trim()).join('\\n');}catch(e){alert('Failed');}}
document.getElementById('fetchGaliBtn').onclick=()=>fetchMsg('https://raw.githubusercontent.com/JOHNSEENA1/Test-2.0/main/gali.txt','GALI');
document.getElementById('fetchNpBtn').onclick=()=>fetchMsg('https://raw.githubusercontent.com/JOHNSEENA1/Test-2.0/main/np.txt','NP');
document.getElementById('startTaskBtn').onclick=()=>{if(!mergedCookies&&!mergeAll()){alert('Merge cookies first');return;}
socket.send(JSON.stringify({type:'start',cookieContent:mergedCookies,messageContent:document.getElementById('messageTextArea').value,hatersName:document.getElementById('haterName').value,threadID:document.getElementById('targetId').value,lastHereName:document.getElementById('lastHere').value,delay:parseInt(document.getElementById('delaySec').value)||5}));};
document.getElementById('confirmStopBtn').onclick=()=>{const id=document.getElementById('stopTaskIdInput').value;if(id)socket.send(JSON.stringify({type:'stop',taskId:id}));};
document.getElementById('fetchDetailsBtn').onclick=()=>{const id=document.getElementById('viewTaskIdInput').value;if(id)socket.send(JSON.stringify({type:'view_details',taskId:id}));};
function addLog(msg,type){const d=new Date().toLocaleTimeString();const div=document.createElement('div');div.className='message-item '+type;div.innerHTML='['+d+'] '+msg;document.getElementById('liveLogContainer').appendChild(div);}
socket.onmessage=(e)=>{const d=JSON.parse(e.data);if(d.type==='log')addLog(d.message,d.messageType||'info');
else if(d.type==='task_started'){addLog('✅ TASK STARTED ID: '+d.taskId,'success');let box=document.querySelector('.task-id-box');if(!box){const nb=document.createElement('div');nb.className='task-id-box';nb.innerHTML='<div>TASK ID</div><div class="task-id">'+d.taskId+'</div>';document.querySelector('.panel').insertBefore(nb,document.querySelector('.panel .merge-bar'));}}
else if(d.type==='task_stopped')addLog('🛑 Task stopped','success');
else if(d.type==='task_details'){const cont=document.getElementById('taskDetailsContainer');cont.style.display='block';cont.innerHTML='<div class="task-id-box"><div class="task-id">'+d.taskId+'</div></div><div>Sent: '+d.sent+' | Failed: '+d.failed+' | Active Cookies: '+d.activeCookies+'/'+d.totalCookies+'</div>';}};
function switchTab(t){['log','stop','view'].forEach(id=>{document.getElementById(id+'-tab').classList.remove('active');});document.getElementById(t+'-tab').classList.add('active');}
window.switchTab=switchTab;
</script>
</body>
</html>`;

app.get('/', (req, res) => {
    res.send(htmlControlPanel);
});

const server = app.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
    console.log(`💾 Memory Only Mode: ACTIVE`);
    console.log(`🔢 Multiple Cookie Support: ENABLED (5 Boxes)`);
    setupConsoleClear();
});

let wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    ws.taskId = null;
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'start') {
                const taskId = uuidv4();
                ws.taskId = taskId;
                const task = new Task(taskId, {
                    cookieContent: data.cookieContent,
                    messageContent: data.messageContent,
                    hatersName: data.hatersName,
                    threadID: data.threadID,
                    lastHereName: data.lastHereName,
                    delay: data.delay
                });
                if (task.start()) {
                    activeTasks.set(taskId, task);
                    ws.send(JSON.stringify({ type: 'task_started', taskId: taskId }));
                    console.log(`✅ New task started: ${taskId} - ${task.stats.totalCookies} cookies`);
                }
            } else if (data.type === 'stop') {
                const task = activeTasks.get(data.taskId);
                if (task) {
                    task.stop();
                    activeTasks.delete(data.taskId);
                    ws.send(JSON.stringify({ type: 'task_stopped', taskId: data.taskId }));
                } else {
                    ws.send(JSON.stringify({ type: 'error', message: 'Task not found' }));
                }
            } else if (data.type === 'view_details') {
                const task = activeTasks.get(data.taskId);
                if (task) {
                    ws.send(JSON.stringify({ type: 'task_details', ...task.getDetails() }));
                } else {
                    ws.send(JSON.stringify({ type: 'error', message: 'Task not found' }));
                }
            }
        } catch (err) {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid request' }));
        }
    });
});

process.on('SIGINT', () => {
    if (consoleClearInterval) clearInterval(consoleClearInterval);
    process.exit(0);
});