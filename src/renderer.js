const { ipcRenderer } = require('electron');

export const toggleMaximize = (domRef) => {
    const toggleMaximizeDiv = domRef
    toggleMaximizeDiv.addEventListener('dblclick', () => {
        ipcRenderer.send('toggle-maximize');
    });
}
