const electron = require('electron');
const { ipcRenderer } = require("electron");

const updateOnlineStatus = () => {
    console.log(navigator.onLine)
    ipcRenderer.send('online_status',navigator.onLine ? 'online' : 'offline')
}

window.addEventListener('online', updateOnlineStatus)
window.addEventListener('offline', updateOnlineStatus)
updateOnlineStatus()

const API = {
    load_status:()=>ipcRenderer.send('load_status'),
    load_detail:(cb)=>ipcRenderer.on('load_detail',cb)
}

electron.contextBridge.exposeInMainWorld("api", API)
