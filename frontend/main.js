const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

let mainWindow;
let pythonProcess;
let timelineWindow;
let isBackendRunning = false;

const PYTHON_EXECUTABLE = process.platform === 'win32' ? 'python' : 'python3'; // 'python.exe' on Windows might be safer, but 'python' should work if in PATH
const PYTHON_SCRIPT = path.join(__dirname, '..', 'backend', 'app.py');
const PYTHON_VENV_EXECUTABLE = path.join(__dirname, '..', 'navigator-ai-venv', 'Scripts', 'python.exe');

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    mainWindow.loadFile('index.html');
}

function createTimelineWindow() {
    timelineWindow = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    timelineWindow.loadFile('timeline.html');
}

// Function to check if Python venv exists and use it
function getPythonExecutable() {
    if (fs.existsSync(PYTHON_VENV_EXECUTABLE)) {
        console.log(`Using Python from virtual environment: ${PYTHON_VENV_EXECUTABLE}`);
        return PYTHON_VENV_EXECUTABLE;
    }
    console.log(`Using global Python executable: ${PYTHON_EXECUTABLE}`);
    return PYTHON_EXECUTABLE;
}

function startPythonBackend() {
    console.log("MAIN: Attempting to spawn Python backend process.");
    const pythonExe = getPythonExecutable();
    
    // Add -u (unbuffered) argument to python
    pythonProcess = spawn(pythonExe, ['-u', PYTHON_SCRIPT]);

    pythonProcess.stdout.on('data', (data) => {
        console.log(`Python stdout: ${data.toString().trim()}`);
        mainWindow.webContents.send('python-log', data.toString().trim());
    });

    pythonProcess.stderr.on('data', (data) => {
        console.error(`Python stderr: ${data.toString().trim()}`);
        mainWindow.webContents.send('python-log', `ERROR: ${data.toString().trim()}`);
    });

    pythonProcess.on('close', (code) => {
        console.log(`Python process exited with code ${code}`);
        pythonProcess = null;
        mainWindow.webContents.send('backend-status', 'stopped');
    });

    pythonProcess.on('error', (err) => {
        console.error('Failed to start Python process:', err);
        mainWindow.webContents.send('python-log', `ERROR: Failed to start Python backend. Make sure Python is installed and backend dependencies are met. ${err.message}`);
        mainWindow.webContents.send('backend-status', 'stopped');
    });
}

function stopPythonBackend() {
    if (pythonProcess) {
        // Send a signal to the backend to shut down gracefully
        // Or directly kill the process if graceful shutdown is not implemented/desired
        fetch('http://127.0.0.1:5000/stop', { method: 'POST' })
            .then(response => response.json())
            .then(data => console.log('Backend stop response:', data))
            .catch(error => console.error('Error stopping backend via API:', error));
            
        // Give it a moment to shut down, then kill if it hasn't
        setTimeout(() => {
            if (pythonProcess) {
                console.log("Forcibly killing Python process.");
                pythonProcess.kill(); // Kills the process (SIGTERM)
            }
        }, 3000); // 3 seconds
    }
}

app.whenReady().then(() => {
    createMainWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createMainWindow();
        }
    });

    // IMPORTANT: Remove listeners from pythonProcess before main window closes
    mainWindow.on('closed', () => {
        if (pythonProcess) {
            pythonProcess.stdout.removeAllListeners('data');
            pythonProcess.stderr.removeAllListeners('data');
            // No need to remove 'close' or 'error' listeners as the process might still be alive
            // and we want those events to be handled if it's explicitly killed later.
        }
        mainWindow = null; // Dereference the window object for garbage collection
    });

    // Handle app close: ensure Python process is killed
    app.on('before-quit', (event) => {
        if (pythonProcess) {
            console.log("App quitting, killing Python process.");
            pythonProcess.kill();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// IPC handlers for renderer process to communicate with main process
ipcMain.handle('start-backend', async () => {
    console.log("MAIN: IPC 'start-backend' received from renderer. Attempting to start Python backend process.");
    
    if (!pythonProcess || pythonProcess.killed) {
        startPythonBackend();
        await new Promise(resolve => setTimeout(resolve, 3000));
        console.log("MAIN: Python process spawned (or assumed to be ready). Now sending /start API call.");
    } else {
        console.log("MAIN: Python process already running. Sending /start API call.");
    }

    return new Promise((resolve, reject) => {
        const options = {
            hostname: '127.0.0.1',
            port: 5000,
            path: '/start',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': 0
            }
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        const parsedData = JSON.parse(data);
                        console.log("MAIN: Backend /start API response:", parsedData);
                        resolve({ success: true, data: parsedData });
                    } catch (e) {
                        console.error('MAIN: Error parsing /start response JSON:', e, 'Raw data:', data);
                        resolve({ success: false, error: 'Invalid JSON response from backend.' });
                    }
                } else {
                    console.error(`MAIN: Failed to start backend via API. Status: ${res.statusCode}, Response: ${data}`);
                    resolve({ success: false, error: `API error: ${res.statusCode}` });
                }
            });
        });

        req.on('error', (e) => {
            console.error('MAIN: Error sending start command to backend via API:', e);
            reject({ success: false, error: e.message });
        });

        req.end();
    });
});

ipcMain.handle('stop-backend', async () => {
    console.log("MAIN: IPC 'stop-backend' received from renderer.");
    if (pythonProcess) {
        // Use http.request for stop as well for consistency
        return new Promise((resolve, reject) => {
            const options = { hostname: '127.0.0.1', port: 5000, path: '/stop', method: 'POST' };
            const req = http.request(options, (res) => {
                res.on('data', () => {}); // Consume response
                res.on('end', () => {
                    console.log('MAIN: Backend stop API response status:', res.statusCode);
                    resolve({ success: true });
                });
            });
            req.on('error', (e) => {
                console.error('MAIN: Error stopping backend via API:', e);
                resolve({ success: false, error: e.message }); // Resolve as false to not block app
            });
            req.end();
        });
    }
    return { success: true }; // If no pythonProcess, assume stopped
});

ipcMain.handle('fetch-status', async () => {
    try {
        const response = await fetch('http://127.0.0.1:5000/status');
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Error fetching status:', error);
        return { is_listening: false, error: error.message };
    }
});

ipcMain.handle('fetch-cheat-sheet', async () => {
    try {
        const response = await fetch('http://127.0.0.1:5000/cheat_sheet');
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Error fetching cheat sheet:', error);
        return [];
    }
});

// Add timeline window handler
ipcMain.handle('open-timeline-window', () => {
    if (!timelineWindow) {
        createTimelineWindow();
    } else {
        timelineWindow.focus();
    }
});

// Add video title handler
ipcMain.handle('setVideoTitle', async (event, title) => {
    try {
        const response = await fetch('http://127.0.0.1:5000/set_title', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: title })
        });
        return { success: response.ok };
    } catch (error) {
        console.error('MAIN: Error setting video title:', error);
        return { success: false, error: error.message };
    }
});