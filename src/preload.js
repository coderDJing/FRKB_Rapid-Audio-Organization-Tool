const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // 暴露给渲染进程的 IPC 方法
    send: (channel, data) => {
        // whitelist channels
        let validChannels = ["toggle-maximize"];
        if (validChannels.includes(channel)) {
            ipcRenderer.send(channel, data);
        }
    },
    sendSync: (channel, data) => {
        // whitelist channels
        let validChannels = [];
        if (validChannels.includes(channel)) {
            ipcRenderer.sendSync(channel, data);
        }
    },
    receive: (channel, func) => {
        let validChannels = ["mainWin-max"];
        if (validChannels.includes(channel)) {
            // Deliberately strip event as it includes `sender` 
            ipcRenderer.on(channel, (event, ...args) => func(...args));
        }
    }
});